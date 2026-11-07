"""M22 평가: LangGraph 회차 루프에서 과거 사례 검색만의 효과를 따로 잰다 (실제 API는 사용자가 실행).

    python -m scripts.m22_eval --repeats 5                 # 실제 AI (configs/llm.yaml 제공사, 비용). LLM_CACHE=0으로 돈다
    python -m scripts.m22_eval --repeats 2 --fake          # 가짜 AI: 키 없이 흐름만 확인 (비용 0)

준비 (한 번): seed 42, P1~P4, 배정 10건 L3로 LangGraph 고정 흐름을 돌려 1회차 1순위 안을 구체적 사유(--note)로 반려하고,
다음에 사람 검토에 오는 안을 승인한다. 두 결정은 루프 사례(loop_cases)로 저장된다. 승인 뒤 반영(규칙 파일 쓰기) 전에 멈춘다
(비교 실행이 준비 실행과 같은 규칙에서 시작하게).

비교 (새 실행, 같은 데이터): 같은 실행 안의 기억은 비어 있으므로 이전 판단이 들어오는 길은 사례 검색뿐이다.
사례 검색 끔/켬을 번갈아 각 --repeats회. 규정·의견 검색은 둘 다 켠다. 각 실행은 1회차 개선 제안 → 미리 돌려보기·순위까지.

지표 (실행마다):
- 반려안 재제안: 첫 제안 묶음에 준비 단계에서 반려한 안과 같은 변경(_proposal_change: 같은 파라미터·값·구간 조건)이 있는가
- 사례 인용: cited_docs에 case-*가 있는 안 수, 그중 반려 사례를 인용하고 다른 변경을 낸 안 수
- 규정 위반 안: domains/<도메인>/knowledge/limits.yaml 한도를 넘는 설정값 안 수 (m15_eval과 같은 기준)
- 1순위 개선폭: 순위 1위 안의 핵심 지표 변화 (미리 돌려보기)
- 비용·시간: 실행 전체(배정·분석·개선)와 개선 단계만

결과: <out>/results.json, <out>/summary.md (기본 runs/m22_eval/<시각>). 키는 어디에도 쓰지 않는다.
"""

import argparse
import json
import os
import statistics
import time
from pathlib import Path

from core.improvement.changes import apply_params
from core.improvement.constraints import constraint_violations
from core.improvement.memory import _proposal_change
from core.improvement.ranking import metric_specs
from core.registry import load_pack
from core.storage.store import Store
from scripts.m15_eval import load_limits, workspace

ROOT = Path(__file__).resolve().parents[1]
METRICS = [{"key": "assignment_rate", "label": "배정 성공률", "format": "pct", "primary": True, "better": "up"}]


def domain_metrics(domain: str) -> list[dict]:
    """화면에 보낼 핵심 지표 (도메인 dimensions.yaml의 metrics 중 primary). 없으면 출동 기본값 (M21 재고 레포: --domain inventory)."""
    from core.registry import load_pack

    specs = (load_pack(domain).dimensions().get("metrics") or {})
    out = [{"key": k, **{f: v[f] for f in ("label", "format", "better") if f in v}, "primary": True}
           for k, v in specs.items() if v.get("primary")]
    return out or METRICS


def _runs(out: Path, demo: bool = False):
    from workflow.agents.api import AgentRuns

    return AgentRuns(demo, out / "retrieval.sqlite", Store(out / "harness.db"), out / "flows")


def _start(runs, args, **kw) -> dict:
    from workflow.agents.api import AgentsStart

    req = AgentsStart(domain=args.domain, seed=args.seed, faults=args.faults, items=args.items, level=args.level,
                      metrics=domain_metrics(args.domain), pace=0, llm="fake" if args.fake else "claude", **kw)
    return runs.start(req)


def _step(runs, flow_id: str, action: str = "next", note: str = "", timeout: float = 1800) -> dict:
    from workflow.api import StepRequest

    runs.step(flow_id, StepRequest(action=action, note=note))
    deadline = time.time() + timeout
    while (snap := runs.snapshot(flow_id))["status"] == "running":
        if time.time() > deadline:
            raise TimeoutError(f"{flow_id}: 단계가 {timeout}초 안에 끝나지 않음")
        time.sleep(0.2)
    if snap["error"]:
        raise RuntimeError(f"{flow_id}: {snap['error']}")
    return snap


def _cost(steps: list[dict], node: str | None = None) -> float | None:
    vals = [s["cost_usd"] for s in steps if s.get("cost_usd") is not None and (node is None or s["node"] == node)]
    return round(sum(vals), 6) if vals else None


def prepare(runs, args) -> dict:
    """준비 실행: 1순위 안 반려(--note) → 다음 안 승인. 승인을 반영하기 전에 멈춘다."""
    started = time.time()
    snap = _start(runs, args)
    ctx = runs.runs.flows[snap["id"]]["_ctx"]
    decisions: list[dict] = []
    for _ in range(60):
        if snap["status"] == "done":
            break
        if snap["waiting"] == "approval":
            p = ctx.data["proposals"][snap["approval"]["proposal"]]
            action = "reject" if not decisions else "approve"
            decisions.append({"action": action, "title": p["body"].get("title"), "rank": snap["approval"].get("rank"),
                              "change": _proposal_change(p["body"]), "proposal_id": p.get("id"),
                              "case_id": f"case-{p['id'][-8:]}" if p.get("id") else None})
            snap = _step(runs, snap["id"], action, args.note if action == "reject" else args.approve_note)
            if action == "approve":
                break
        else:
            snap = _step(runs, snap["id"])
    stored = runs.store.loop_cases(args.domain)
    return {"flow_id": snap["id"], "decisions": decisions, "cases_written": snap["loop"].get("cases_written") or [],
            "stored_cases": [{"id": r["id"], "status": r["status"]} for r in stored],
            "cost_usd": _cost(snap["steps"]), "seconds": round(time.time() - started, 1)}


def compare_run(runs, args, use_cases: bool, rejected: dict, pack, params: dict, limits: list[dict]) -> dict:
    """새 실행 하나: 1회차 개선 제안 → 미리 돌려보기·순위까지. 사람 결정은 하지 않는다 (사례를 더 쓰지 않는다)."""
    started = time.time()
    snap = _start(runs, args, use_cases=use_cases)
    ctx = runs.runs.flows[snap["id"]]["_ctx"]
    while "simulate" not in [s["node"] for s in snap["steps"]] and snap["status"] != "done":
        snap = _step(runs, snap["id"])
    d = ctx.data
    primary = [m["key"] for m in metric_specs(pack.dimensions()) if m.get("primary")]
    rows = []
    for p in d.get("proposals") or []:
        body = p["body"] if isinstance(p.get("body"), dict) else {}
        cited = [str(c) for c in body.get("cited_docs") or []] if isinstance(body.get("cited_docs"), list) else []
        change = _proposal_change(body)
        broken = []
        if body.get("kind") == "params" and not p["errors"]:
            broken = constraint_violations([{k: v for k, v in c.items() if k != "clause"} for c in limits],
                                           apply_params(params, body))
        sim = p.get("simulation") or {}
        rows.append({"title": body.get("title"), "kind": body.get("kind"), "status": p["status"],
                     "errors": p["errors"][:2], "change": change, "repeats_rejected": change == rejected["change"],
                     "cited": cited, "cites_case": any(c.startswith("case-") for c in cited),
                     "cites_rejected_case": rejected["case_id"] in cited,
                     "regulation_clauses": sorted({limits[b["index"]]["clause"] for b in broken}),
                     "rank": (p.get("rank") or {}).get("rank"), "tier": (p.get("rank") or {}).get("tier"),
                     "primary": {k: [(sim.get("before") or {}).get(k), (sim.get("after") or {}).get(k)] for k in primary}
                     if sim else None})
    top = next((r for r in rows if r["rank"] == 1 and r["tier"] == "main"), None)
    key = primary[0] if primary else None
    gain = None
    if top and top["primary"] and key and None not in top["primary"][key]:
        gain = top["primary"][key][1] - top["primary"][key][0]
    proposal_step = next((s for s in snap["steps"] if s["node"] == "proposal_agent"), {})
    searched = proposal_step.get("retrieval") or {}
    return {"flow_id": snap["id"], "use_cases": use_cases, "proposals": rows,
            "repeated_rejected": any(r["repeats_rejected"] for r in rows),
            "repeated_rejected_valid": any(r["repeats_rejected"] and r["status"] != "invalid" for r in rows),
            "case_citing": sum(r["cites_case"] for r in rows),
            "different_after_rejected_case": sum(r["cites_rejected_case"] and not r["repeats_rejected"] for r in rows),
            "regulation_violating": sum(bool(r["regulation_clauses"]) for r in rows),
            "invalid": sum(r["status"] == "invalid" for r in rows),
            "top_title": top["title"] if top else None, "top_gain": gain,
            "search_counts": searched.get("counts") or {}, "search_line": next(
                (x for x in proposal_step.get("lines") or [] if x.startswith("검색: ")), None),
            "retrieval": snap["loop"].get("retrieval"), "retrieval_options": snap["loop"].get("retrieval_options"),
            "cost_usd": _cost(snap["steps"]), "proposal_cost_usd": _cost(snap["steps"], "proposal_agent"),
            "proposal_seconds": proposal_step.get("seconds"), "seconds": round(time.time() - started, 1),
            "model": next((x.split("모델 ")[-1].split(" ·")[0] for x in proposal_step.get("lines") or []
                           if "모델 " in x), None)}


def run(args) -> dict:
    if not args.fake:
        os.environ["LLM_CACHE"] = "0"       # 최종 측정: 입력 해시 캐시를 끈다 (같은 입력도 새로 부른다)
    out = Path(args.out or ROOT / "runs" / "m22_eval" / time.strftime("%Y%m%d-%H%M%S"))
    out.mkdir(parents=True, exist_ok=True)
    results = {"args": {k: v for k, v in vars(args).items()}, "started": time.time(), "out": str(out)}
    with workspace(args.domain):
        runs = _runs(out)
        pack = load_pack(args.domain)
        import yaml
        params = yaml.safe_load(Path(pack.params_path()).read_text(encoding="utf-8"))
        limits = load_limits(pack)
        print("준비 실행 (반려 → 승인) …", flush=True)
        prep = prepare(runs, args)
        results["prepare"] = prep
        rejected = next((x for x in prep["decisions"] if x["action"] == "reject"), None)
        if rejected is None:
            raise RuntimeError("준비 실행에서 반려할 안이 없었음")
        print(f"  반려: {rejected['title']} ({rejected['change']}) → {rejected['case_id']}", flush=True)
        results["rows"] = []
        for i in range(args.repeats):
            for use_cases in (False, True):          # 번갈아 (시간에 따른 차이를 두 조건에 고르게)
                row = compare_run(runs, args, use_cases, rejected, pack, params, limits)
                row["repeat"] = i + 1
                results["rows"].append(row)
                print(f"  {i + 1}회 사례 {'켬' if use_cases else '끔'}: 재제안 {row['repeated_rejected']} · 사례 인용 "
                      f"{row['case_citing']} · 규정 위반 {row['regulation_violating']} · 1순위 개선폭 {row['top_gain']} · "
                      f"${row['cost_usd']} · {row['seconds']}초", flush=True)
                (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1, default=str),
                                                  encoding="utf-8")
    results["finished"] = time.time()
    (out / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    (out / "summary.md").write_text(summary_md(results), encoding="utf-8")
    return results


def _mean(vals, digits=4):
    vals = [v for v in vals if v is not None]
    return f"{statistics.mean(vals):.{digits}f}" if vals else "-"


def summary_md(results: dict) -> str:
    prep, rows = results["prepare"], results["rows"]
    rej = next(x for x in prep["decisions"] if x["action"] == "reject")
    lines = ["# M22 평가: 과거 사례 검색 끔/켬", "",
             f"- 준비: 반려 `{rej['title']}` ({rej['change']}) → {rej['case_id']}, 사유 \"{results['args']['note']}\"",
             f"- 준비: 승인 " + ", ".join(f"`{x['title']}`" for x in prep["decisions"] if x["action"] == "approve"),
             f"- 저장된 루프 사례: {len(prep['stored_cases'])}건 · 준비 비용 ${prep['cost_usd']} · {prep['seconds']}초", "",
             "| 회 | 사례 | 반려안 재제안 | 사례 인용 안 | 반려 사례 보고 다른 안 | 규정 위반 안 | 적용 불가 | 1순위 개선폭(%p) | 검색 | 비용($) | 개선 단계($) | 시간(초) |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        gain = "-" if r["top_gain"] is None else f"{r['top_gain'] * 100:+.2f}"
        lines.append(f"| {r['repeat']} | {'켬' if r['use_cases'] else '끔'} | {'예' if r['repeated_rejected'] else '아니오'} | "
                     f"{r['case_citing']} | {r['different_after_rejected_case']} | {r['regulation_violating']} | "
                     f"{r['invalid']} | {gain} | {(r['search_line'] or '-').removeprefix('검색: ')} | {r['cost_usd']} | "
                     f"{r['proposal_cost_usd']} | {r['seconds']} |")
    lines += ["", "| 조건 | 재제안 실행 | 사례 인용 실행 | 규정 위반 안 합 | 1순위 개선폭 평균(%p) | 비용 평균($) | 시간 평균(초) |",
              "|---|---|---|---|---|---|---|"]
    for flag in (False, True):
        sub = [r for r in rows if r["use_cases"] == flag]
        gains = [r["top_gain"] * 100 for r in sub if r["top_gain"] is not None]
        lines.append(f"| 사례 {'켬' if flag else '끔'} | {sum(r['repeated_rejected'] for r in sub)}/{len(sub)} | "
                     f"{sum(r['case_citing'] > 0 for r in sub)}/{len(sub)} | {sum(r['regulation_violating'] for r in sub)} | "
                     f"{_mean(gains, 2)} | {_mean([r['cost_usd'] for r in sub])} | {_mean([r['seconds'] for r in sub], 1)} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> dict:
    parser = argparse.ArgumentParser(description="M22 평가: 과거 사례 검색 끔/켬 (실제 API는 비용)")
    parser.add_argument("--domain", default="dispatch")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--faults", default="P1,P2,P3,P4")
    parser.add_argument("--items", type=int, default=10)
    parser.add_argument("--level", default="L3")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--note", default="규정 한도를 먼저 확인할 것")
    parser.add_argument("--approve-note", default="준비 단계 승인")
    parser.add_argument("--out", default=None)
    parser.add_argument("--fake", action="store_true", help="가짜 AI (키 없이 흐름만, 비용 0)")
    args = parser.parse_args(argv)
    args.faults = [f for f in args.faults.split(",") if f]
    results = run(args)
    print(summary_md(results))
    print(f"결과: {results['out']}")
    return results


if __name__ == "__main__":
    main()

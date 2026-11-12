"""분석·개선 Supervisor (M18-b): 기존 분석·개선 에이전트와 계산 도구를 도구로 부르며 다음 행동을 스스로 정한다.

원칙: 판단은 자유롭게, 실행 결과에는 제약.
- 판단: 무엇을 다시 볼지, 어떤 가설을 믿을지, 어떤 안을 추천할지는 정해진 선택지 없이 Supervisor가 정한다.
- 제약 (코드가 지킨다, 프롬프트로만 막지 않는다):
  · 추천안은 이 실행에서 simulate로 돌린 안만. 적용 불가(분류·허용 범위·인용 위반) 안은 추천 불가.
  · 추천 근거의 수치는 인용한 도구 결과에 있어야 한다 (근거 검사 재사용).
  · 규칙 파일 변경·승인 도구는 없다 (반영은 사람 승인 후).
  · 호출 상한: 도구 호출 전체 40회, run_analysis 3회, run_proposals 4회. 실행 예산(core.llm.control.Budget)은
    Supervisor와 그가 부른 에이전트가 나눠 쓴다.
  · 판단 보고서 형식 검사를 통과하지 못하면 1회 돌려보내고, 그래도 안 되면 '해결 불가'로 보고한다.
코어는 도메인을 모른다: 차원·지표·관점은 도메인 팩에서 읽는다.
"""

import json
from collections.abc import Callable
from typing import Any

from core.analysis.agent import analyze
from core.analysis.aggregate_tools import Aggregator
from core.analysis.grounding import numbers_in, unsupported_numbers
from core.analysis.perspectives import analyze_perspectives
from core.interfaces import DecisionRecord, DomainPack
from core.llm.control import Budget, failure
from core.llm.tool_loop import resolve_call, run_tool_loop, usage_dict
from core.retrieval.tool import search_tool

from .changes import apply_params, params_errors
from .constraints import constraint_violations
from .diagnose import diagnose
from .proposer import FINDING_SUMMARY_KEYS, propose
from .ranking import _score, load_ranking_config, metric_specs, minimal_change
from .simulate import simulate_params
from .sweep import sweep_params

LIMITS = {"total": 40, "run_analysis": 3, "run_proposals": 4}
CONFIDENCE = ["높음", "중간", "낮음"]
END_REASONS = {
    "good_enough": "충분히 좋은 안 확보",
    "no_further_gain": "더 나아질 여지 없음",
    "not_solvable_by_params": "파라미터로 못 푸는 문제",
    "budget": "예산 초과",
}
MAX_RECOMMEND = 3

SYSTEM = """너는 최적화 규칙 개선 작업을 지휘하는 Supervisor다. 분석 에이전트, 개선 에이전트, 계산 도구를 도구로 불러
실패 원인을 찾고, 효과가 확인된 개선안을 사람에게 추천한다. 무엇을 할지는 네가 정한다. 정해진 순서는 없다.

도구:
- run_analysis: 분석 에이전트를 돌린다. 관점(perspectives)을 고르거나, 직접 쓴 질문(question)과 구간(slice)으로 좁혀
  다시 분석할 수 있다. 결과는 발견(id, 구간, 원인 가설) 요약이다.
- run_proposals: 개선 에이전트를 돌린다. 대상 발견(finding_ids), 초점(focus), 추가 지시(instruction)를 줄 수 있다.
  결과는 개선안(id P…)과 코드 검사 결과(적용 불가 사유)다.
- simulate: 개선안(proposal_id) 또는 직접 쓴 변경(params_changes·override_rules)을 규칙 엔진으로 미리 돌린다.
  지표 전후, 발견 구간별 실패율, 제약 위반, 최소 변경, 진단 신호가 나온다.
- sweep: 파라미터 1~2개 축을 훑어 득실 곡선을 본다.
- search_knowledge (있으면): 운영 규정·과거 사례·현장 의견 검색.
- submit_judgment: 판단 보고서를 제출하고 끝낸다.

진단 신호 (simulate 결과의 diagnosis):
- target_changes: 겨냥한 발견 구간의 실패율 전→후. improved=false면 원인 가설을 의심하라.
- worsened_metrics: 나빠진 비핵심 지표와 폭 (득실).
- missed_slices: 남은 실패가 많은데 어떤 발견에도 속하지 않는 구간 (분석이 놓친 문제).
- dominated_by: 훑기(sweep)한 점 중 이 안보다 모든 지표에서 나은 점 (탐색 부족).

일하는 방법:
- 결과가 예상과 다르면 다음 후보로 넘어가기 전에 이유부터 확인한다.
  목표 구간이 그대로면 가설을 의심하고 재분석한다. 놓친 구간이 크면 그 구간을 분석한다.
- 관점끼리 원인이 엇갈리면 "가설 A라면 변경 X가, B라면 변경 Y가 효과 있다"고 먼저 예측을 적은 뒤
  둘 다 simulate해 가린다.
- 득실이 갈리는 안은 직접 고르지 말고 사람에게 한도를 묻는 항목(questions_for_human)으로 올린다.
- 지켜야 할 제약이 있으면 simulate 결과의 constraint_violations가 비는 안을 찾는다.

규칙 (코드가 검사한다):
- 추천안(recommendations)은 최대 3건이고, 이 실행에서 simulate로 돌린 안의 id(P… 또는 S…)만 쓸 수 있다.
  적용 불가 사유가 있는 안은 추천할 수 없다.
- 추천의 expected_effect·loses에 쓴 수치는 cited_calls로 인용한 도구 결과(호출 번호 c1, c2 …)나 그 안의 변경값에 있어야 한다.
  수치는 읽기 쉽게 반올림해 써라 (예: 0.6681985 → 66.8% 또는 0.668). 표시한 자릿수 안에서 같으면 근거로 인정된다.
  사람에게 묻는 항목(questions_for_human)도 같은 방식으로 반올림해 쓴다.
- 도구 호출은 전체 40회, run_analysis 3회, run_proposals 4회까지다. 예산을 넘으면 그때까지의 결과로 멈춘다.
- 규칙을 바꾸거나 승인할 수 없다. 반영은 사람이 판단 보고서를 보고 한다."""

_CHANGES = {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "value": {}},
                                       "required": ["path", "value"]}}
_RULES = {"type": "array", "items": {"type": "object", "properties": {
    "when": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}}},
    "set": {"type": "object"}}, "required": ["when", "set"]}}
_SLICE = {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}},
          "description": "차원 → 값 목록 (예: {\"차원\": [\"값\"]})"}


def judgment_tool() -> dict:
    s, arr = {"type": "string"}, lambda item: {"type": "array", "items": item}
    return {
        "name": "submit_judgment",
        "description": "판단 보고서를 제출하고 끝낸다.",
        "input_schema": {"type": "object", "properties": {
            "summary": s,
            "recommendations": arr({"type": "object", "properties": {
                "proposal_id": {"type": "string", "description": "simulate로 돌린 안의 id (P… 또는 S…)"},
                "cited_calls": arr(s), "expected_effect": s, "loses": s,
                "confidence": {"type": "string", "enum": CONFIDENCE}},
                "required": ["proposal_id", "cited_calls", "expected_effect", "loses", "confidence"]}),
            "not_recommended": arr({"type": "object", "properties": {"proposal_id": s, "reason": s},
                                    "required": ["proposal_id", "reason"]}),
            "hypotheses": arr({"type": "object", "properties": {
                "statement": s, "support": s, "against": s, "confidence": {"type": "string", "enum": CONFIDENCE},
                "would_flip": {"type": "string", "description": "이 결론을 뒤집을 증거"}},
                "required": ["statement", "support", "against", "confidence", "would_flip"]}),
            "attempts": arr({"type": "object", "properties": {"what": s, "why": s, "learned": s},
                             "required": ["what", "why", "learned"]}),
            "questions_for_human": arr(s),
            "end_reason": {"type": "string", "enum": list(END_REASONS)}},
            "required": ["summary", "recommendations", "hypotheses", "attempts", "end_reason"]},
    }


def _matches(d: DecisionRecord, slice_: dict | None) -> bool:
    for k, vals in (slice_ or {}).items():
        allowed = {str(v) for v in (vals if isinstance(vals, list) else [vals])}
        if str(d.dims.get(k)) not in allowed:
            return False
    return True


def _finding_id(fid: str, findings: dict) -> str | None:
    """발견 id. 개선 에이전트가 리포트 안의 짧은 id(F3)를 쓰면, 그 id를 가진 리포트가 하나뿐일 때 R1-F3으로 맞춘다."""
    fid = str(fid)
    if fid in findings:
        return fid
    hits = [k for k in findings if k.endswith(f"-{fid}")]
    return hits[0] if len(hits) == 1 else None


def _primary_gain(sim: dict, state: dict) -> float | None:
    """미리 돌려본 결과의 핵심 지표 개선폭 (방향 반영). 지표를 못 읽으면 None."""
    result = sim.get("result") or {}
    if not state.get("specs") or not (result.get("before") and result.get("after")):
        return None
    return _score(result, state["specs"])["gain"]


def judgment_problems(sub: dict, calls: dict, state: dict) -> list[str]:
    """판단 보고서 검사 (코드가 지키는 것). state: supervise()의 실행 기록 (proposals·simulations)."""
    problems = []
    recs = sub.get("recommendations") or []
    if not isinstance(recs, list):
        return ["recommendations는 목록이어야 한다"]
    if len(recs) > MAX_RECOMMEND:
        problems.append(f"추천안은 최대 {MAX_RECOMMEND}건 (지금 {len(recs)}건)")
    for i, r in enumerate(recs):
        where = f"recommendations[{i}] {r.get('proposal_id')}"
        pid = str(r.get("proposal_id") or "")
        sim = state["simulations"].get(pid)
        if sim is None:
            problems.append(f"{where}: 이 실행에서 simulate로 돌리지 않은 안은 추천할 수 없다")
            continue
        if sim.get("errors"):
            problems.append(f"{where}: 적용 불가 안은 추천할 수 없다 ({sim['errors'][0]})")
        elif (gain := _primary_gain(sim, state)) is not None and gain < state["min_effect"] - 1e-9:
            # 고정 흐름은 순위에서 "최소 효과 미만"을 본안에서 뺀다. Supervisor 추천도 같은 기준을 지킨다
            problems.append(f"{where}: 핵심 지표 개선폭 {gain * 100:+.1f}%p가 최소 효과 "
                            f"{state['min_effect'] * 100:.1f}%p 미만이라 추천할 수 없다. "
                            "이만한 안밖에 없으면 recommendations를 비우고 end_reason을 no_further_gain으로 제출하라")
        cited = [resolve_call(c, calls) for c in r.get("cited_calls") or []]
        if not cited or None in cited:
            problems.append(f"{where}: cited_calls가 비었거나 없는 호출 번호가 있다")
            continue
        sources = [n for cid in cited for n in numbers_in(calls[cid].get("output"))]
        # 추천한 안 자체의 변경값(구간 조건의 차원 값, 바꾼 값)도 근거로 인정한다: 구간 이름에 든 숫자가
        # 지표 수치로 오인돼 반려되지 않게 (2026-10-20 실제 API S3에서 구간 값의 숫자가 걸림)
        sources += numbers_in(sim.get("change"))
        for key in ("expected_effect", "loses"):
            bad = unsupported_numbers(str(r.get(key) or ""), sources)
            if bad:
                problems.append(f"{where}: {key}의 수치 {', '.join(bad)}가 인용한 도구 결과에 없다")
    if r_conf := [h for h in sub.get("hypotheses") or [] if h.get("confidence") not in CONFIDENCE]:
        problems.append(f"hypotheses의 confidence는 {'/'.join(CONFIDENCE)} 중 하나 ({len(r_conf)}건)")
    if not sub.get("hypotheses"):
        problems.append("원인 가설(hypotheses)이 비었다")
    if not sub.get("attempts"):
        problems.append("시도 기록(attempts)이 비었다")
    if sub.get("end_reason") not in END_REASONS:
        problems.append(f"end_reason은 {', '.join(END_REASONS)} 중 하나")
    return problems


def supervise(pack: DomainPack, pack_factory: Callable[[dict], DomainPack], instance, decisions: list[DecisionRecord],
              params: dict, spec_text: str, make_llm: Callable[[str], Any], llm_config: dict, *,
              perspectives: list[dict] | None = None, constraints: list[dict] | None = None,
              analysis_memory: str = "", proposal_memory: str = "", previous: str = "",
              retrieval: dict | None = None, salt: str = "", on_event=None, budget: Budget | None = None,
              limits: dict | None = None, max_calls: int = 40) -> dict:
    """make_llm(role) → LLM 클라이언트 (role: supervisor | analysis | proposals).
    previous: 이전 회차의 판단 보고서·사람의 판단·재평가 결과 (M18-c가 만든다). 비면 첫 회차.
    돌려주는 것: judgment(검사 통과한 보고서, 아니면 None), draft, problems, failure, reports, proposals,
    simulations, sweeps, calls, attempts_log(코드가 남긴 호출 기록), usage(Supervisor), sub_usage, budget."""
    limits = {**LIMITS, **(limits or {})}
    budget = budget if budget is not None else Budget.from_config()
    emit = on_event or (lambda e: None)
    dims = pack.dimensions()
    specs = metric_specs(dims)
    primary = [m["key"] for m in specs if m.get("primary")]
    perspectives = perspectives or []
    state: dict = {"reports": {}, "findings": {}, "proposals": {}, "simulations": {}, "sweep_points": [],
                   "counts": {"total": 0, "run_analysis": 0, "run_proposals": 0}, "sub_usage": [], "log": [],
                   # 추천 기준: 고정 흐름의 순위와 같은 최소 효과를 Supervisor 추천에도 적용한다 (judgment_problems)
                   "specs": specs, "min_effect": load_ranking_config()["min_effect"]}

    def sub_events(label: str):
        return (lambda e: emit({**e, "item": label})) if on_event else None

    def spend(name: str) -> str | None:
        c = state["counts"]
        c["total"] += 1
        if c["total"] > limits["total"]:
            return f"도구 호출 상한 {limits['total']}회를 넘었다. submit_judgment로 제출하라"
        if name in c and name != "total":
            c[name] += 1
            if c[name] > limits[name]:
                return f"{name} 상한 {limits[name]}회를 넘었다"
        return None

    def log(name: str, args: dict, result: str) -> None:
        state["log"].append({"tool": name, "args": args, "result": result})

    # --- 도구 ---
    def run_analysis(args: dict) -> dict:
        if over := spend("run_analysis"):
            return {"error": over}
        rid = f"R{len(state['reports']) + 1}"
        chosen = [p for p in perspectives if p["id"] in (args.get("perspectives") or [])]
        if args.get("perspectives") and not chosen:
            return {"error": f"없는 관점: {args['perspectives']} (가능: {[p['id'] for p in perspectives]})"}
        subset = [d for d in decisions if _matches(d, args.get("slice"))]
        if not subset:
            return {"error": "구간에 해당하는 항목이 없다"}
        events = sub_events(f"분석 {rid}")
        if chosen:
            body = analyze_perspectives(pack, instance, subset, lambda: make_llm("analysis"), llm_config, chosen,
                                        salt=f"{salt}:{rid}", memory_text=analysis_memory, on_event=events,
                                        budget=budget)
        else:
            question = (args.get("question") or "").strip()
            persp = {"id": "supervisor", "name": "Supervisor 질문", "question": question} if question else None
            body = analyze(pack, instance, subset, make_llm("analysis"), llm_config, salt=f"{salt}:{rid}",
                           memory_text=analysis_memory, perspective=persp, on_event=events, budget=budget)
        findings = []
        for f in body["findings"]:
            fid = f"{rid}-{f['id']}"
            state["findings"][fid] = {**f, "id": fid}
            findings.append({k: f.get(k) for k in FINDING_SUMMARY_KEYS if f.get(k) is not None} | {"id": fid})
        state["reports"][rid] = {**body, "args": args, "items": len(subset)}
        state["sub_usage"].append(body.get("usage"))
        log("run_analysis", args, f"{rid}: 발견 {len(findings)}건")
        out = {"report_id": rid, "items": len(subset), "summary": body.get("summary", ""), "findings": findings,
               "dropped_insufficient_evidence": len(body.get("dropped") or []), "failure": body.get("failure")}
        if not findings and not state["findings"]:
            # 분석이 바꿀 거리를 못 찾았다: 개선 요청으로 넘어가지 않고 여기서 끝낸다
            out["stop_here"] = ("개선할 문제를 찾지 못했다. 설정값으로 바꿀 것이 없으므로 run_proposals로 넘어가지 말고 "
                                "submit_judgment로 끝내라: recommendations는 비우고 end_reason은 no_further_gain")
        return out

    def run_proposals(args: dict) -> dict:
        if over := spend("run_proposals"):
            return {"error": over}
        ids = args.get("finding_ids") or list(state["findings"])
        missing = [i for i in ids if i not in state["findings"]]
        if not ids and state["counts"]["run_analysis"]:
            return {"error": "분석이 개선할 문제를 찾지 못했다. 개선안을 만들지 말고 submit_judgment로 끝내라 "
                             "(recommendations 비움, end_reason no_further_gain)"}
        if missing or not ids:
            return {"error": f"없는 발견: {missing or '발견이 없다. 먼저 run_analysis'}"}
        report = {"summary": "", "findings": [state["findings"][i] for i in ids]}
        note = "".join(f"\n\n# Supervisor 지시\n{label}: {args[k]}" for k, label in
                       (("focus", "초점"), ("instruction", "추가 지시")) if args.get(k))
        bid = f"B{state['counts']['run_proposals']}"
        out = propose(pack_factory, instance, params, spec_text, dims, report, make_llm("proposals"), llm_config,
                      salt=f"{salt}:{bid}", constraints=constraints, memory_text=proposal_memory + note,
                      retrieval=retrieval, on_event=sub_events(f"개선 {bid}"), budget=budget)
        state["sub_usage"].append(out.get("usage"))
        rows = []
        for p in out["proposals"]:
            pid = f"P{len(state['proposals']) + 1}"
            state["proposals"][pid] = {**p, "id": pid, "batch": bid}
            body = p["proposal"] if isinstance(p["proposal"], dict) else {}
            rows.append({"id": pid, "title": body.get("title"), "kind": body.get("kind"),
                         "params_changes": body.get("params_changes"), "override_rules": body.get("override_rules"),
                         "target_findings": body.get("target_findings"), "errors": p["errors"]})
        log("run_proposals", args, f"{bid}: 개선안 {len(rows)}건")
        return {"batch": bid, "proposals": rows, "failure": out.get("failure")}

    def simulate(args: dict) -> dict:
        if over := spend("simulate"):
            return {"error": over}
        pid = args.get("proposal_id")
        if pid:
            p = state["proposals"].get(pid)
            if p is None:
                return {"error": f"없는 개선안: {pid}"}
            body = p["proposal"] if isinstance(p["proposal"], dict) else {}
            if body.get("kind") != "params":
                return {"error": f"{pid}는 규칙 설정값(params) 안이 아니라 미리 돌려볼 수 없다"}
            change, errors = body, list(p["errors"])
        else:
            change = {k: args[k] for k in ("params_changes", "override_rules") if args.get(k)}
            pid = f"S{sum(1 for k in state['simulations'] if k.startswith('S')) + 1}"
            errors = params_errors(params, change, dims)
        if errors:
            state["simulations"][pid] = {"errors": errors}
            return {"id": pid, "error": "적용 불가: " + "; ".join(errors)}
        candidate = apply_params(params, change)
        slices = {fid: f["slice"] for fid, f in state["findings"].items() if f.get("slice")}
        result = simulate_params(pack_factory, instance, params, candidate, slices)
        violations = constraint_violations(constraints or [], candidate, result) if constraints else []
        minimal = minimal_change(pack_factory, instance, params, change, result, primary) if primary else None
        after = pack_factory(candidate).solve(instance, candidate)
        targets = [_finding_id(t, state["findings"]) for t in
                   (args.get("target_findings") or change.get("target_findings") or [])]
        targets = [t for t in targets if t]
        diagnosis = diagnose(result, dims, list(state["findings"].values()), after, targets or None,
                             state["sweep_points"] or None)
        state["simulations"][pid] = {"change": change, "result": result, "constraint_violations": violations,
                                     "minimal_change": minimal, "diagnosis": diagnosis, "errors": []}
        log("simulate", {"id": pid}, f"{pid}: 위반 {result['violations_after']}건")
        return {"id": pid, "before": result["before"], "after": result["after"],
                "violations_after": result["violations_after"], "constraint_violations": violations,
                "minimal_change": minimal, "diagnosis": diagnosis}

    def sweep(args: dict) -> dict:
        if over := spend("sweep"):
            return {"error": over}
        try:
            out = sweep_params(pack_factory, instance, params, args.get("axes") or [], args.get("metrics"))
        except ValueError as exc:
            return {"error": str(exc)}
        state["sweep_points"] += out["points"]
        log("sweep", args, f"점 {len(out['points'])}개")
        return {"axes": out["axes"], "base": out["base"], "points": out["points"], "warnings": out["warnings"]}

    tools = [
        {"name": "run_analysis", "handler": run_analysis,
         "description": "분석 에이전트를 돌린다 (관점 선택 또는 직접 쓴 질문·구간으로 재분석). 결과는 발견 요약.",
         "input_schema": {"type": "object", "properties": {
             "perspectives": {"type": "array", "items": {"type": "string", "enum": [p["id"] for p in perspectives]}}
             if perspectives else {"type": "array", "items": {"type": "string"}},
             "question": {"type": "string", "description": "직접 쓴 분석 질문"}, "slice": _SLICE}}},
        {"name": "run_proposals", "handler": run_proposals,
         "description": "개선 에이전트를 돌린다. 대상 발견 id(없으면 전부), 초점, 추가 지시. 결과는 개선안과 코드 검사 결과.",
         "input_schema": {"type": "object", "properties": {
             "finding_ids": {"type": "array", "items": {"type": "string"}},
             "focus": {"type": "string", "description": "예: 구간 조건(override_rules)만"},
             "instruction": {"type": "string"}}}},
        {"name": "simulate", "handler": simulate,
         "description": "개선안 id 또는 직접 쓴 변경을 규칙 엔진으로 미리 돌린다 (지표 전후·구간 실패율·제약·최소 변경·진단 신호).",
         "input_schema": {"type": "object", "properties": {
             "proposal_id": {"type": "string"}, "params_changes": _CHANGES, "override_rules": _RULES,
             "target_findings": {"type": "array", "items": {"type": "string"}}}}},
        {"name": "sweep", "handler": sweep,
         "description": "파라미터 1~2개 축을 훑어 조합마다 지표를 본다 (규칙 엔진, AI 비용 0).",
         "input_schema": {"type": "object", "properties": {
             "axes": {"type": "array", "items": {"type": "object", "properties": {
                 "path": {"type": "string"}, "values": {"type": "array"}}, "required": ["path", "values"]}},
             "metrics": {"type": "array", "items": {"type": "string"}}}, "required": ["axes"]}},
    ]
    if retrieval:
        search = search_tool(retrieval["index"], retrieval["kinds"], record=retrieval.setdefault("record", {}))
        inner = search["handler"]

        def counted_search(args):
            return {"error": over} if (over := spend("search_knowledge")) else inner(args)
        tools.append({**search, "handler": counted_search})

    overview = Aggregator(decisions, dims).overview({})
    metrics_now = pack.metrics(instance, decisions)
    targets = {m["key"]: {k: m.get(k) for k in ("label", "primary", "better", "target") if m.get(k) is not None}
               for m in specs}
    user = ("# 규칙 실행 결과 요약\n" + json.dumps(overview, ensure_ascii=False)
            + "\n\n# 핵심 지표와 목표\n" + json.dumps({"now": metrics_now, "metrics": targets}, ensure_ascii=False)
            + (f"\n\n# 분석 관점\n" + json.dumps([{"id": p["id"], "name": p["name"]} for p in perspectives],
                                                ensure_ascii=False) if perspectives else "")
            + ("\n\n# 지켜야 할 제약\n" + json.dumps(constraints, ensure_ascii=False) if constraints else "")
            + (f"\n\n# 이전 회차\n{previous}" if previous else "")
            + "\n\n원인을 찾고 효과가 확인된 개선안을 골라 submit_judgment로 보고하라.")

    def check(sub: dict, calls: dict) -> list[str]:
        return judgment_problems(sub, calls, state)

    llm = make_llm("supervisor")
    result = run_tool_loop(llm, system=SYSTEM, user=user, tools=tools, submit_tool=judgment_tool(),
                           max_calls=max_calls, salt=salt, check_submission=check, on_event=on_event,
                           check_label="판단 보고서 검사", budget=budget)
    draft = result.submission
    problems = judgment_problems(draft, result.calls, state) if draft else []
    fail = result.failure
    if draft and problems:          # 1회 돌려보낸 뒤에도 문제 → 해결 불가 (그때까지의 시도 기록과 함께)
        fail = failure("unresolved", "판단 보고서 검사 실패: " + problems[0])
    return {
        "judgment": draft if draft and not problems else None,
        "draft": draft,
        "problems": problems,
        "failure": fail,
        "stop": result.stop,
        "reports": state["reports"],
        "findings": state["findings"],
        "proposals": state["proposals"],
        "simulations": state["simulations"],
        "sweep_points": len(state["sweep_points"]),
        "counts": state["counts"],
        "attempts_log": state["log"],
        "calls": result.calls,
        "usage": usage_dict(result, llm.model, llm_config),
        "sub_usage": state["sub_usage"],
        "budget": budget.to_dict(),
    }

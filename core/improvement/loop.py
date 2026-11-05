"""개선 루프 (M15-B): 회차 종료 판정과 결과 보고. LLM 없이 기록만으로 계산한다.

한 회차 = 배정 → 평가 → 분석 → 제안 → 미리 돌려보기 → 사람 검토(승인·반려·의견) → (승인 시) 반영 → 재배정·재평가.
회차 기록 (round_entry):
  {round, before: {지표}, after: {지표}, approved: [제목], decisions: [{action, title, note}],
   constraints: [제약], cost_usd, seconds, params_version_before, params_version_after}
종료: ① 핵심 지표가 목표값(metrics[*].target)에 닿음 ② 이번 회차 개선 없음(승인 없음 또는 최소 효과 미만)
③ 최대 회차. 셋 다 아니면 다음 회차.
"""

from pathlib import Path

import yaml

from core.improvement.ranking import _fmt, _label, _sign

CONFIG_PATH = Path(__file__).resolve().parents[2] / "configs" / "workflow.yaml"
DEFAULTS = {"max_rounds": 2, "max_reproposals": 2, "end_check": "fixed"}
GOAL, NO_GAIN, MAX_ROUNDS = "목표 달성", "개선 없음", "최대 회차"
NEXT_STEPS = {"next_round": "다음 회차 (배정부터 새 규칙으로)", "repropose": "이번 회차에서 개선안 다시 받기",
              "report": "끝내고 결과 보고"}


def allowed_steps(entry: dict, config: dict, reproposals: int) -> list[str]:
    """Supervisor가 고를 수 있는 다음 단계 (M15-D). 최대 회차·다시 제안 횟수는 코드가 막는다."""
    steps = ["report"]
    if entry["round"] < config["max_rounds"] and entry.get("approved"):
        steps.insert(0, "next_round")
    if reproposals < config["max_reproposals"] and not entry.get("approved"):
        steps.insert(0, "repropose")
    return steps


def load_loop_config(path: str | Path = CONFIG_PATH) -> dict:
    cfg = dict(DEFAULTS)
    p = Path(path)
    if p.is_file():
        cfg.update(yaml.safe_load(p.read_text(encoding="utf-8")) or {})
    return cfg


def _reached(spec: dict, value) -> bool:
    return isinstance(value, (int, float)) and (value - spec["target"]) * _sign(spec) >= -1e-9


def round_gain(entry: dict, specs: list[dict]) -> float:
    """회차 전→후 핵심 지표 개선폭 (방향 반영 합)."""
    before, after = entry.get("before") or {}, entry.get("after") or {}
    return sum((after[s["key"]] - before[s["key"]]) * _sign(s) for s in specs
               if s.get("primary") and s["key"] in before and s["key"] in after)


def termination(entry: dict, specs: list[dict], config: dict, min_effect: float) -> tuple[bool, str]:
    """(끝내는가, 이유). 이유는 끝내지 않을 때도 채운다 (화면에 다음 회차로 가는 까닭을 보인다)."""
    goals = [s for s in specs if s.get("primary") and s.get("target") is not None]
    after = entry.get("after") or {}
    if goals and all(_reached(s, after.get(s["key"])) for s in goals):
        return True, GOAL + ": " + ", ".join(f"{_label(s)} {_value(s, after[s['key']])} {'≤' if _sign(s) < 0 else '≥'} 목표 {_value(s, s['target'])}"
                                            for s in goals)
    gain = round_gain(entry, specs)
    if not entry.get("approved") or gain < min_effect - 1e-9:
        return True, NO_GAIN + (": 승인한 제안 없음" if not entry.get("approved") else ": 핵심 지표 개선폭이 최소 효과 미만")
    if entry["round"] >= config["max_rounds"]:
        return True, f"{MAX_ROUNDS}: {config['max_rounds']}회차를 마침"
    left = [f"{_label(s)} {_value(s, after.get(s['key']))} (목표 {_value(s, s['target'])})" for s in goals
            if not _reached(s, after.get(s["key"]))]
    return False, "다음 회차: " + (", ".join(left) + " 미달" if left else "개선 여지 확인")


def _value(spec: dict, v) -> str:
    if not isinstance(v, (int, float)):
        return "–"
    return f"{v * 100:.1f}%" if spec.get("format") == "pct" else f"{v:.2f}{spec.get('unit', '')}"


def loop_report(rounds: list[dict], specs: list[dict], stop_reason: str, findings: list[dict] | None = None,
                constraints: list[dict] | None = None) -> dict:
    """결과 보고: 회차별 핵심 지표 전→후, 승인·반려·의견 이력, 쓴 제약, 남은 문제, 회차별 AI 비용·시간."""
    primary = [s for s in specs if s.get("primary")]
    approved_targets = {f for r in rounds for d in r.get("decisions") or [] if d.get("action") == "approve"
                        for f in d.get("target_findings") or []}
    remaining = [{"id": f.get("id"), "title": f.get("title")} for f in findings or [] if f.get("id") not in approved_targets]
    lines = []
    for r in rounds:
        b, a = r.get("before") or {}, r.get("after") or {}
        metric = " · ".join(f"{_label(s)} {_value(s, b.get(s['key']))} → {_value(s, a.get(s['key']))}"
                            + (f" ({_fmt(s, a[s['key']] - b[s['key']])})" if s["key"] in a and s["key"] in b else "")
                            for s in primary)
        cost = r.get("cost_usd")
        lines.append(f"{r['round']}회차: {metric} · 승인 {len(r.get('approved') or [])}건"
                     + f" · 결정 {len(r.get('decisions') or [])}건"
                     + ("" if cost is None else f" · AI 비용 ${cost:.4f}") + f" · {r.get('seconds', 0):.1f}초")
    first, last = (rounds[0] if rounds else {}), (rounds[-1] if rounds else {})
    total = {s["key"]: {"before": (first.get("before") or {}).get(s["key"]), "after": (last.get("after") or {}).get(s["key"])}
             for s in primary}
    costs = [r["cost_usd"] for r in rounds if r.get("cost_usd") is not None]
    return {"rounds": rounds, "stop_reason": stop_reason, "total": total,
            "decisions": [{"round": r["round"], **d} for r in rounds for d in r.get("decisions") or []],
            "constraints": list(constraints or []), "remaining": remaining,
            "cost_usd": sum(costs) if costs else None, "seconds": sum(r.get("seconds") or 0 for r in rounds),
            "lines": lines}

"""개선안 제시 기준 (M15-A): 몇 건을, 어떤 순서로, 무엇을 접어서 보여 줄지 코드로 정한다 (AI 비용 0).

- 개수: 본안은 최대 max_proposals건, 발견 하나당 per_finding건. 넘치면 잘라 내고 잘린 안을 기록한다.
- 제외("참고"): 적용 불가, 규칙 위반 증가, 핵심 지표 개선 없음, 최소 효과(min_effect) 미만, 같은 발견의 아랫순위 안.
- 정렬: ① 사람 제약을 지키는 안 → ② 핵심 지표 개선폭이 큰 순 → ③ 손실(나빠진 지표의 상대 하락폭 합)이 작은 순.
- 지배당한 안: 모든 지표에서 다른 안보다 나쁜 안은 숨김 표시한다.
- 최소 변경 추천: 숫자 하나를 바꾸는 안이면 현재 값~제안 값 사이를 규칙 엔진으로 훑어
  같은 핵심 지표를 내는 가장 작은 변경을 찾는다.

기준값은 configs/proposals.yaml(코어 설정), 핵심 지표와 방향은 도메인 dimensions()["metrics"]에서 읽는다.
핵심 지표에 min_effect가 선언돼 있으면 코어 설정 대신 그 값을 쓴다.
"""

import copy
from pathlib import Path

import yaml

from core.improvement.changes import apply_params
from core.params import get_path

CONFIG_PATH = Path(__file__).resolve().parents[2] / "configs" / "proposals.yaml"
DEFAULTS = {"max_proposals": 3, "per_finding": 1, "min_effect": 0.01, "min_change_steps": 4}
TIERS = ("main", "cut", "reference", "hidden", "pending")
EPS = 1e-9


def load_ranking_config(path: str | Path = CONFIG_PATH) -> dict:
    cfg = dict(DEFAULTS)
    p = Path(path)
    if p.is_file():
        cfg.update(yaml.safe_load(p.read_text(encoding="utf-8")) or {})
    return cfg


def min_effect_for(specs: list[dict], config: dict | None = None) -> float:
    """추천할 가치가 있다고 보는 핵심 지표 개선폭.

    핵심 지표가 min_effect를 직접 선언하면 그 값을 쓴다 (M21: 결품률처럼 값의 범위가 작은 지표).
    순위(rank_proposals)와 Supervisor 추천 검사가 같은 기준을 쓰도록 여기 한 곳에 둔다.
    """
    cfg = {**DEFAULTS, **(config or {})}
    declared = [s["min_effect"] for s in specs
                if s.get("primary") and isinstance(s.get("min_effect"), (int, float))]
    return min(declared) if declared else cfg["min_effect"]


def metric_specs(dimensions: dict) -> list[dict]:
    """dimensions()["metrics"] {키: {label, primary, better: up|down, format, unit}} → 목록. 선언이 없으면 빈 목록."""
    return [{"key": k, **(v or {})} for k, v in (dimensions.get("metrics") or {}).items()]


def _sign(spec: dict) -> int:
    return -1 if spec.get("better") == "down" else 1


def _fmt(spec: dict, delta: float) -> str:
    if spec.get("format") == "pct":
        return f"{delta * 100:+.1f}%p"
    if abs(delta) >= 100:   # 금액처럼 큰 값은 소수 없이 천 단위 쉼표 (M21)
        return f"{delta:+,.0f}{spec.get('unit', '')}"
    return f"{delta:+.2f}{spec.get('unit', '')}"


def _label(spec: dict) -> str:
    return spec.get("label") or spec["key"]


def _score(sim: dict, specs: list[dict]) -> dict:
    """핵심 지표 개선폭(gain, 방향 반영 합), 손실(loss, 나빠진 비핵심 지표의 상대 하락폭 합), 지표별 변화."""
    before, after = sim.get("before") or {}, sim.get("after") or {}
    gain, loss, deltas, worse = 0.0, 0.0, {}, []
    for spec in specs:
        k = spec["key"]
        if not isinstance(before.get(k), (int, float)) or not isinstance(after.get(k), (int, float)):
            continue
        d = after[k] - before[k]
        signed = d * _sign(spec)
        deltas[k] = d
        if spec.get("primary"):
            gain += signed
        elif signed < -EPS:
            loss += -signed / abs(before[k]) if abs(before[k]) > EPS else -signed
        if signed < -EPS:
            worse.append(f"{_label(spec)} {_fmt(spec, d)}")
    return {"gain": gain, "loss": loss, "deltas": deltas, "worse": worse}


def _dominates(q: dict, p: dict, specs: list[dict]) -> bool:
    """q가 p보다 모든 지표에서 낫다 (같은 기준선에서 잰 결과끼리만, 제약을 어긴 안은 지키는 안을 지배하지 못한다)."""
    if q["sim"].get("before") != p["sim"].get("before") or q["constrained"] > p["constrained"]:
        return False
    keys = [s for s in specs if s["key"] in q["deltas"] and s["key"] in p["deltas"]]
    return bool(keys) and all((q["deltas"][s["key"]] - p["deltas"][s["key"]]) * _sign(s) > EPS for s in keys)


def rank_proposals(proposals: list[dict], specs: list[dict], config: dict | None = None) -> dict:
    """proposals: [{id, status, errors, body{target_findings}, simulation}].

    반환 {order: [id], entries: {id: {tier, rank, gain, loss, worse, reasons}}, cut: [id], config}.
    tier: main(본안, rank 1..), cut(개수 초과), reference(참고), hidden(지배당함), pending(아직 미리 돌려보지 않음).
    """
    cfg = {**DEFAULTS, **(config or {})}
    primary = [s for s in specs if s.get("primary")]
    cfg["min_effect"] = min_effect_for(specs, cfg)
    entries, cands = {}, []
    for p in proposals:
        pid, sim = p["id"], p.get("simulation") or None
        entry = {"tier": "pending", "rank": None, "gain": None, "loss": None, "worse": [], "reasons": []}
        entries[pid] = entry
        if p.get("status") == "invalid" or p.get("errors"):
            entry.update(tier="reference", reasons=["적용 불가: " + "; ".join(map(str, p.get("errors") or ["검증 실패"]))])
            continue
        if not sim or "after" not in sim:
            entry["reasons"] = ["아직 미리 돌려보지 않음"]
            continue
        sc = _score(sim, specs)
        entry.update(gain=sc["gain"], loss=sc["loss"], worse=sc["worse"])
        vb, va = sim.get("violations_before") or 0, sim.get("violations_after") or 0
        gains = [f"{_label(s)} {_fmt(s, sc['deltas'][s['key']])}" for s in primary if s["key"] in sc["deltas"]]
        if va > vb:
            entry.update(tier="reference", reasons=[f"규칙 위반 증가 {vb}→{va}건"])
        elif sc["gain"] <= EPS:
            entry.update(tier="reference", reasons=["핵심 지표 개선 없음: " + (", ".join(gains) or "핵심 지표 없음")])
        elif sc["gain"] < cfg["min_effect"] - EPS:
            entry.update(tier="reference", reasons=[f"최소 효과 미만: {', '.join(gains)}"])
        else:
            constrained = bool(sim.get("constraint_violations"))
            reasons = ["핵심 지표 " + ", ".join(gains)]
            if "constraint_violations" in sim:   # 사람이 정한 제약이 있을 때만 (없으면 키가 없다)
                reasons.insert(0, ("사람 제약 위반: " + "; ".join(c.get("message", "") for c in sim["constraint_violations"]))
                               if constrained else "사람 제약 지킴")
            reasons.append("나빠진 지표 " + ", ".join(sc["worse"]) if sc["worse"] else "나빠진 지표 없음")
            entry["reasons"] = reasons
            cands.append({"id": pid, "sim": sim, "constrained": constrained, **sc,
                          "findings": list((p.get("body") or {}).get("target_findings") or [])})

    cands.sort(key=lambda c: (c["constrained"], -c["gain"], c["loss"]))
    for c in cands:
        by = next((q["id"] for q in cands if q is not c and _dominates(q, c, specs)), None)
        if by:
            entries[c["id"]].update(tier="hidden", reasons=[f"지배당한 안: 모든 지표에서 {by}보다 나쁨"])
    used, main, cut = {}, [], []
    for c in cands:
        e = entries[c["id"]]
        if e["tier"] == "hidden":
            continue
        full = [f for f in c["findings"] if used.get(f, [])[cfg["per_finding"] - 1:]] if cfg["per_finding"] > 0 else []
        if full:
            e.update(tier="reference",
                     reasons=[f"같은 발견({', '.join(full)})의 더 나은 안 {', '.join(used[full[0]])}이 있음"] + e["reasons"])
            continue
        if len(main) >= cfg["max_proposals"]:
            e["tier"] = "cut"
            e["reasons"] = [f"개수 상한 {cfg['max_proposals']}건 초과로 잘림"] + e["reasons"]
            cut.append(c["id"])
            continue
        e.update(tier="main", rank=len(main) + 1)
        main.append(c["id"])
        for f in c["findings"]:
            used.setdefault(f, []).append(c["id"])

    pos = {c["id"]: i for i, c in enumerate(cands)}
    order = sorted(entries, key=lambda pid: (TIERS.index(entries[pid]["tier"]), pos.get(pid, len(pos))))
    return {"order": order, "entries": entries, "cut": cut, "config": cfg}


# --- 최소 변경 추천 -------------------------------------------------------------------------------

def _single_change(body: dict) -> tuple[str, object, callable] | None:
    """숫자 하나만 바꾸는 안이면 (경로, 제안 값, 값을 바꾼 body를 만드는 함수). 아니면 None."""
    changes, rules = body.get("params_changes") or [], body.get("override_rules") or []
    if len(changes) == 1 and not rules:
        path, value = changes[0].get("path"), changes[0].get("value")

        def rebuild(v):
            b = copy.deepcopy(body)
            b["params_changes"][0]["value"] = v
            return b
    elif len(rules) == 1 and not changes and len(rules[0].get("set") or {}) == 1:
        path, value = next(iter(rules[0]["set"].items()))

        def rebuild(v):
            b = copy.deepcopy(body)
            b["override_rules"][0]["set"][path] = v
            return b
    else:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    return str(path), value, rebuild


def _between(current, proposed, steps: int) -> list:
    """현재 값에 가까운 쪽부터, 제안 값 직전까지의 후보."""
    if isinstance(current, int) and isinstance(proposed, int):
        step = 1 if proposed > current else -1
        return list(range(current + step, proposed, step))
    n = max(int(steps), 1)
    return [round(current + (proposed - current) * i / (n + 1), 6) for i in range(1, n + 1)]


def minimal_change(pack_factory, instance, params: dict, body: dict, simulation: dict, primary_keys: list[str],
                   steps: int | None = None) -> dict | None:
    """같은 핵심 지표를 내는 더 작은 변경. 숫자 하나를 바꾸는 안이 아니거나 더 작은 값이 없으면 None.

    반환 {path, current, proposed, recommended, same_primary: True, metrics, violations_after}.
    """
    single = _single_change(body)
    after = (simulation or {}).get("after") or {}
    if not single or not primary_keys or not all(k in after for k in primary_keys):
        return None
    path, proposed, rebuild = single
    try:
        current = get_path(params, path)
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    if not isinstance(current, (int, float)) or isinstance(current, bool) or current == proposed:
        return None
    steps = steps if steps is not None else load_ranking_config()["min_change_steps"]
    for value in _between(current, proposed, steps):
        cand = apply_params(params, rebuild(value))
        pack = pack_factory(cand)
        decisions = pack.solve(instance, cand)
        metrics = pack.metrics(instance, decisions)
        if all(abs(metrics.get(k, float("nan")) - after[k]) <= EPS for k in primary_keys):
            return {"path": path, "current": current, "proposed": proposed, "recommended": value,
                    "same_primary": True, "metrics": metrics,
                    "violations_after": len(pack.validate(instance, decisions))}
    return None

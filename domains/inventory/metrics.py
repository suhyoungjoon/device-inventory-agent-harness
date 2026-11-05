"""inventory 도메인 지표. 결정 레코드로 재고 흐름을 다시 계산하므로 규칙 agent와 AI agent에 똑같이 쓴다.

범위: 결정 범위(인스턴스 scope)에 들어 있는 지점×모델의 계획 기간 전체 주.
범위 밖 항목은 규칙으로 채워 재고 흐름을 잇는다 (rule_engine.simulate).
"""

from core.interfaces import DecisionRecord

from .models import Instance, pair_key, parse_item
from .rule_engine import effective_params, fixed_orders, forecast, simulate, validate


def scope_pairs(inst: Instance) -> set[tuple[str, str]]:
    return {(b, m) for _w, b, m in (parse_item(it) for it in inst.items())}


def outcome(inst: Instance, decisions: list[DecisionRecord], params: dict):
    """결정대로 시뮬레이션한 결과와 지표 범위 칸."""
    orders, _ = fixed_orders(inst, decisions)
    moq = params["order"]["moq"]
    ok = {it: q for it, q in orders.items() if q >= 0 and q % moq == 0}
    res = simulate(inst, params, ok, set(inst.items()) | set(ok))
    pairs = scope_pairs(inst)
    cells = [c for c in res.cells.values() if (c.branch, c.model) in pairs]
    return res, pairs, cells


def compute(inst: Instance, decisions: list[DecisionRecord], params: dict) -> dict[str, float]:
    res, pairs, cells = outcome(inst, decisions, params)
    demand = sum(c.demand for c in cells)
    lost = sum(c.lost for c in cells)
    with_demand = [c for c in cells if c.demand > 0]

    excess_weeks = params["evaluation"]["excess_weeks"]
    excess = 0.0
    for b, m in pairs:
        key = pair_key(b, m)
        actual = inst.actual(key)
        avg = sum(actual) / len(actual) if actual else 0.0
        final = res.end_on_hand.get(key, 0) + sum(res.pipeline.get(key, {}).values())
        excess += max(0.0, final - excess_weeks * avg) * inst.models[m].unit_cost

    scope_items = inst.items()
    purchase = sum(res.cells[it].order * inst.models[res.cells[it].model].unit_cost for it in scope_items)
    errors = []
    for it in scope_items:
        week, b, m = parse_item(it)
        actual = inst.actual(pair_key(b, m))[week - 1]
        if actual > 0:
            f = forecast(inst, week, b, m, effective_params(inst, week, b, m, params))
            errors.append(abs(f - actual) / actual)

    return {
        "stockout_rate": lost / demand if demand else 0.0,
        "fill_rate": sum(c.lost == 0 for c in with_demand) / len(with_demand) if with_demand else 0.0,
        "avg_stock_days": sum(c.end_stock for c in cells) / demand * 7 if demand else 0.0,
        "excess_stock_value": float(round(excess)),
        "purchase_amount": float(purchase),
        "forecast_mape": sum(errors) / len(errors) if errors else 0.0,
        "violation_count": float(len(validate(inst, decisions, params))),
    }

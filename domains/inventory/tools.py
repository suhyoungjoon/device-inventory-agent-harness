"""발주 AI agent(L2 이상)용 도구. 데이터 조회는 이 도구로만 한다.

모든 도구는 지금 결정 중인 항목의 주차 시점에서 본 값만 돌려준다.
계획 기간의 실제 수요는 그 주 이전 것만 보인다 (미래 정보 누설 금지).
"""

from core.interfaces import ToolContext

from .models import Instance, item_id, pair_key, parse_item
from .rule_engine import fixed_orders, lead_time, order_plan, simulate

_PAIR = {"branch": {"type": "string", "description": "지점 ID (생략하면 지금 항목의 지점)"},
         "model": {"type": "string", "description": "모델 ID (생략하면 지금 항목의 모델)"}}


def _state(inst: Instance, params: dict, ctx: ToolContext):
    """지금 항목 주차의 발주 전 상태 (지금까지의 결정 반영, 범위 밖은 규칙으로 채움)."""
    week, branch, model = parse_item(ctx.item_id)
    orders, _ = fixed_orders(inst, ctx.decisions)
    moq = params["order"]["moq"]
    ok = {it: q for it, q in orders.items() if q >= 0 and q % moq == 0}
    res = simulate(inst, params, ok, set(inst.items()) | set(ok), until_week=week)
    return week, branch, model, res


def _pick(inst: Instance, args: dict, branch: str, model: str) -> tuple[str, str]:
    b, m = args.get("branch") or branch, args.get("model") or model
    if b not in inst.branches or m not in inst.models:
        raise ValueError(f"알 수 없는 지점·모델: {b}, {m}")
    return b, m


def build_tools(inst: Instance, params: dict) -> list[dict]:
    def get_stock(args: dict, ctx: ToolContext) -> dict:
        week, branch, model, res = _state(inst, params, ctx)
        b, m = _pick(inst, args, branch, model)
        cell = res.cells[item_id(week, b, m)]
        info = inst.models[m]
        pipe = res.pipeline.get(pair_key(b, m), {})
        return {"week": week, "branch": b, "branch_name": inst.branches[b].name,
                "model": m, "model_name": info.name, "family": info.family, "maker": info.maker,
                "phase": info.phase, "unit_cost": info.unit_cost, "eol_week": info.eol_week,
                "lead_time_weeks": lead_time(info, params),
                "on_hand": cell.on_hand, "arrived_this_week": cell.arrivals, "on_order": cell.on_order,
                "on_order_by_week": [{"arrive_week": w, "qty": q} for w, q in sorted(pipe.items()) if q]}

    def get_demand_history(args: dict, ctx: ToolContext) -> dict:
        week, branch, model = parse_item(ctx.item_id)
        b, m = _pick(inst, args, branch, model)
        n = max(1, min(int(args.get("weeks") or 8), inst.history_weeks + week - 1))
        observed = inst.observed(pair_key(b, m), week)
        labels = [f"과거 {inst.history_weeks - i}주 전" for i in range(inst.history_weeks)] + \
                 [f"계획 {w}주" for w in range(1, week)]
        rows = [{"week": label, "demand": d} for label, d in zip(labels, observed)][-n:]
        return {"branch": b, "model": m, "as_of_week": week, "weekly_demand": rows,
                "note": "주간 수요 = 판매 + 재고가 없어 못 판 수요. 이번 주와 이후 수요는 아직 모른다"}

    def calc_forecast(args: dict, ctx: ToolContext) -> dict:
        week, branch, model, res = _state(inst, params, ctx)
        b, m = _pick(inst, args, branch, model)
        cell = res.cells[item_id(week, b, m)]
        plan = order_plan(inst, week, b, m, params, cell.on_hand, cell.on_order)
        return {"week": week, "branch": b, "model": m, **plan,
                "formula": "필요량 = max(0, 예측 × (리드타임 + 검토주기) + 안전재고 − 현재고 − 입고 예정), "
                           "최소 발주 단위 배수로 올림"}

    def get_limits(args: dict, ctx: ToolContext) -> dict:
        week, branch, model, res = _state(inst, params, ctx)
        limits = res.limits[week]
        maker = inst.models[model].maker
        return {"week": week, "moq": params["order"]["moq"],
                "budget_left": limits.budget, "budget_cap": params["budget"]["weekly_cap"],
                "supply_left": {k: v for k, v in limits.supply.items()},
                "supply_cap": {k: mk.supply_cap for k, mk in inst.makers.items()},
                "warehouse_left": {k: v for k, v in limits.warehouse.items()},
                "warehouse_capacity": {k: br.warehouse_capacity for k, br in inst.branches.items()},
                "this_item": {"branch": branch, "maker": maker, "unit_cost": inst.models[model].unit_cost},
                "note": "이번 주 지금까지 확정한 발주를 뺀 남은 한도. 예산은 만원, 공급·창고는 대"}

    obj = {"type": "object"}
    return [
        {"name": "get_stock", "handler": get_stock,
         "description": "지점·모델의 이번 주 현재고(입고 반영 후), 이번 주 입고, 입고 예정, 모델 정보(제조사·단가·리드타임·단종 주차).",
         "input_schema": {**obj, "properties": dict(_PAIR)}},
        {"name": "get_demand_history", "handler": get_demand_history,
         "description": "지점·모델의 과거 주간 수요(판매 + 못 판 수요). 지금 주 이전 기록만 보인다.",
         "input_schema": {**obj, "properties": {**_PAIR, "weeks": {"type": "integer", "minimum": 1, "maximum": 40,
                                                                    "description": "최근 몇 주 (기본 8)"}}}},
        {"name": "calc_forecast", "handler": calc_forecast,
         "description": "규칙 파라미터로 계산한 예측 수요(이동평균 × 신제품 보정), 목표 재고, 필요 발주량. 한도는 반영하지 않는다.",
         "input_schema": {**obj, "properties": dict(_PAIR)}},
        {"name": "get_limits", "handler": get_limits,
         "description": "이번 주 남은 예산, 제조사별 남은 공급 한도, 지점별 남은 창고 자리, 최소 발주 단위.",
         "input_schema": {**obj, "properties": {}}},
    ]

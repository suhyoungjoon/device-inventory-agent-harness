"""규칙 엔진: 재고 시뮬레이션, solve(기준선 발주), validate(필수조건 검증).

판단 순서는 domain-spec.md를 따르고, 수치는 모두 params로 받는다.

한 주의 흐름 (주차 → 지점 → 모델):
  1. 입고: 앞서 발주해 이번 주 도착하는 물량을 현재고에 더한다 (발주 주 + 리드타임 주에 도착)
  2. 발주: 정해진 결정(외부 결정)을 먼저 반영하고, 나머지 항목은 규칙이 결품 위험이 큰 순서로 남은 한도 안에서 정한다
  3. 판매: 실제 수요만큼 판다. 재고가 모자라면 못 판 수요(결품)로 잃는다 (이월 주문 없음)

외부 결정(AI 결정이나 저장된 결정)을 넣으면 그 항목은 결정대로, 범위 밖 항목은 규칙으로 채워 재고 흐름을 잇는다.
그래서 시범 10건만 AI가 정해도 같은 기간 전체의 결품·재고를 공정하게 비교할 수 있다.
"""

import math
from collections import defaultdict
from dataclasses import dataclass, field

from core.interfaces import DecisionRecord, Violation
from core.params import apply_overrides

from .models import DeviceModel, Instance, item_id, pair_key, parse_item

# 재고 흐름에 반영하는 상태. failed·blocked는 발주하지 않은 것으로 본다.
PLACED_STATUSES = {"success", "pending_approval"}
WEEK_BANDS = (("early", 3), ("middle", 6), ("late", 10**6))   # 1~3주 초반, 4~6주 중반, 7주~ 후반
LIMIT_REASONS = {"budget": "BUDGET_SHORT", "supply": "SUPPLY_CAP", "warehouse": "WAREHOUSE_FULL"}
LIMIT_NAMES = {"budget": "주간 예산", "supply": "제조사 공급 한도", "warehouse": "창고 용량"}


def week_band(week: int) -> str:
    return next(name for name, last in WEEK_BANDS if week <= last)


def dims_of(inst: Instance, week: int, branch: str, model: str) -> dict[str, str]:
    m = inst.models[model]
    return {"branch": branch, "family": m.family, "maker": m.maker, "phase": m.phase, "week_band": week_band(week)}


def effective_params(inst: Instance, week: int, branch: str, model: str, params: dict) -> dict:
    """항목에 해당하는 구간 조건(overrides)을 적용한 파라미터."""
    return apply_overrides(params, dims_of(inst, week, branch, model))


def lead_time(model: DeviceModel, params: dict) -> int:
    return int(params["supply"]["lead_time_weeks"][model.maker])


def forecast(inst: Instance, week: int, branch: str, model: str, params: dict) -> float:
    """예측 수요 = 최근 window_weeks주 관측 수요 이동평균 (출시 전 주 제외), 신규 모델은 × new_model_boost.
    params는 구간 조건을 적용한 값이어야 한다."""
    m = inst.models[model]
    observed = inst.observed(pair_key(branch, model), week)
    if m.phase == "new" and m.launch_offset is not None:
        observed = observed[max(0, inst.history_weeks - m.launch_offset):]
    window = observed[-int(params["forecast"]["window_weeks"]):]
    value = sum(window) / len(window) if window else 0.0
    if m.phase == "new":
        value *= params["forecast"]["new_model_boost"]
    return value


def round_up(qty: float, moq: int) -> int:
    return int(math.ceil(qty / moq - 1e-9) * moq) if qty > 0 else 0


def floor_to(qty: float, moq: int) -> int:
    return int(qty // moq * moq) if qty > 0 else 0


def order_plan(inst: Instance, week: int, branch: str, model: str, params: dict,
               on_hand: int, on_order: int) -> dict:
    """규칙 발주량: max(0, 예측 × (리드타임 + 검토주기) + 안전재고 − 현재고 − 입고 예정), 최소 발주 단위 배수로 올림."""
    p = effective_params(inst, week, branch, model, params)
    m = inst.models[model]
    f = forecast(inst, week, branch, model, p)
    lt = lead_time(m, p)
    cycle = p["review"]["cycle_weeks"]
    safety = f * p["safety"]["weeks"]
    target = f * (lt + cycle) + safety
    need = round_up(target - on_hand - on_order, p["order"]["moq"])
    return {"forecast": round(f, 2), "lead_time_weeks": lt, "cycle_weeks": cycle, "safety_stock": round(safety, 2),
            "target": round(target, 2), "on_hand": on_hand, "on_order": on_order, "need": need}


def parse_order(decision: dict | None) -> int | None:
    """결정의 발주량. 정수가 아니면 None."""
    if not isinstance(decision, dict):
        return None
    qty = decision.get("order_qty")
    if isinstance(qty, bool) or not isinstance(qty, int):
        return None
    return qty


# --- 시뮬레이션 -----------------------------------------------------------------

@dataclass
class Cell:                      # 한 주 × 지점 × 모델의 재고 흐름
    week: int
    branch: str
    model: str
    arrivals: int = 0            # 이번 주 입고
    on_hand: int = 0             # 입고 후, 판매 전 현재고
    on_order: int = 0            # 이번 주 발주 전 입고 예정 (다음 주 이후 도착)
    order: int = 0               # 이번 주 발주량
    demand: int = 0
    sales: int = 0
    lost: int = 0                # 결품 (못 판 수요)
    end_stock: int = 0


@dataclass
class WeekLimits:                # 한 주의 남은 한도
    budget: float
    supply: dict[str, int]
    warehouse: dict[str, int]    # 지점별 (용량 − 현재고 − 입고 예정 − 이번 주 발주)


@dataclass
class SimResult:
    cells: dict[str, Cell] = field(default_factory=dict)              # item_id → Cell
    rule_records: dict[str, DecisionRecord] = field(default_factory=dict)
    pipeline: dict[str, dict[int, int]] = field(default_factory=dict)  # 지점:모델 → {도착 주: 물량}
    limits: dict[int, WeekLimits] = field(default_factory=dict)        # 주차 → 외부 결정만 반영한 남은 한도
    end_on_hand: dict[str, int] = field(default_factory=dict)


def simulate(inst: Instance, params: dict, fixed: dict[str, int] | None = None,
             fixed_scope: set[str] | None = None, until_week: int | None = None) -> SimResult:
    """재고 흐름 시뮬레이션.

    fixed_scope: 외부 결정으로 정하는 항목. 그 안에서 fixed에 없는 항목은 발주 0으로 본다.
    fixed_scope 밖 항목은 규칙이 정한다 (rule_records에 남는다).
    until_week: 그 주차의 외부 결정까지만 반영하고 멈춘다 (도구 조회용: 규칙 결정·판매 전 상태와 남은 한도).
    """
    fixed = fixed or {}
    fixed_scope = fixed_scope or set()
    budget_cap = params["budget"]["weekly_cap"]
    moq = params["order"]["moq"]
    res = SimResult()
    stock = {pair_key(b, m): inst.initial_stock[pair_key(b, m)] for b, m in inst.pairs}
    pipeline: dict[str, dict[int, int]] = {k: defaultdict(int) for k in stock}
    rank = {it: i for i, it in enumerate(inst.all_items())}

    for week in range(1, inst.weeks + 1):
        cells = {}
        for b, m in inst.pairs:
            key = pair_key(b, m)
            arrivals = pipeline[key].pop(week, 0)
            stock[key] += arrivals
            cells[item_id(week, b, m)] = Cell(week, b, m, arrivals=arrivals, on_hand=stock[key],
                                              on_order=sum(pipeline[key].values()))
        position = defaultdict(int)
        for cell in cells.values():
            position[cell.branch] += cell.on_hand + cell.on_order
        limits = WeekLimits(budget=budget_cap, supply={k: mk.supply_cap for k, mk in inst.makers.items()},
                            warehouse={b: inst.branches[b].warehouse_capacity - position[b] for b in inst.branches})

        # 2-1. 외부 결정
        for it, cell in cells.items():
            if it not in fixed_scope:
                continue
            qty = max(0, fixed.get(it, 0) or 0)
            _take(inst, limits, cell, qty)
        res.limits[week] = WeekLimits(limits.budget, dict(limits.supply), dict(limits.warehouse))
        if until_week is not None and week == until_week:
            res.cells.update(cells)
            res.pipeline = {k: dict(v) for k, v in pipeline.items()}
            return res

        # 2-2. 규칙 결정: 결품 위험(현재고 + 입고 예정이 예측 몇 주 치인가)이 큰 순서로 한도를 나눈다
        plans = []
        for it, cell in cells.items():
            if it in fixed_scope:
                continue
            plan = order_plan(inst, week, cell.branch, cell.model, params, cell.on_hand, cell.on_order)
            cover = (cell.on_hand + cell.on_order) / plan["forecast"] if plan["forecast"] > 0 else math.inf
            plans.append((cover, rank[it], it, cell, plan))
        for _cover, _rank, it, cell, plan in sorted(plans, key=lambda x: (x[0], x[1])):
            res.rule_records[it] = _rule_decide(inst, week, cell, plan, limits, moq)

        # 3. 도착 예약과 판매
        for it, cell in cells.items():
            key = pair_key(cell.branch, cell.model)
            if cell.order > 0:
                pipeline[key][week + lead_time(inst.models[cell.model], params)] += cell.order
            cell.demand = inst.actual(key)[week - 1]
            cell.sales = min(cell.on_hand, cell.demand)
            cell.lost = cell.demand - cell.sales
            stock[key] = cell.on_hand - cell.sales
            cell.end_stock = stock[key]
        res.cells.update(cells)

    res.pipeline = {k: dict(v) for k, v in pipeline.items()}
    res.end_on_hand = dict(stock)
    return res


def _take(inst: Instance, limits: WeekLimits, cell: Cell, qty: int) -> None:
    m = inst.models[cell.model]
    cell.order = qty
    limits.budget -= qty * m.unit_cost
    limits.supply[m.maker] -= qty
    limits.warehouse[cell.branch] -= qty


def room(inst: Instance, limits: WeekLimits, cell: Cell, moq: int) -> dict[str, int]:
    """남은 한도로 이 항목에 발주할 수 있는 최대량 (최소 발주 단위 배수로 내림)."""
    m = inst.models[cell.model]
    return {"budget": floor_to(limits.budget / m.unit_cost, moq),
            "supply": floor_to(limits.supply[m.maker], moq),
            "warehouse": floor_to(limits.warehouse[cell.branch], moq)}


def _rule_decide(inst: Instance, week: int, cell: Cell, plan: dict, limits: WeekLimits, moq: int) -> DecisionRecord:
    it = item_id(week, cell.branch, cell.model)
    m = inst.models[cell.model]
    dims = dims_of(inst, week, cell.branch, cell.model)
    need = plan["need"]
    basis = (f"예측 {plan['forecast']:g}대/주, 목표 {plan['target']:g}대(리드타임 {plan['lead_time_weeks']}주 + "
             f"검토주기 {plan['cycle_weeks']}주 + 안전재고 {plan['safety_stock']:g}대), "
             f"현재고 {plan['on_hand']} + 입고 예정 {plan['on_order']} → 필요 {need}대")
    metrics = {"forecast": float(plan["forecast"]), "need": float(need), "short_qty": 0.0}
    if need > 0 and m.eol_week is not None and week >= m.eol_week:
        metrics["short_qty"] = float(need)
        return DecisionRecord(it, None, "failed", "EOL_BLOCKED",
                              f"{basis}. 단종 예정 모델이라 {m.eol_week}주부터 발주 금지", dims, metrics)
    caps = room(inst, limits, cell, moq)
    binding = min(caps, key=lambda k: (caps[k], list(caps).index(k)))
    qty = min(need, caps[binding])
    if qty < need and qty == 0:
        metrics["short_qty"] = float(need)
        return DecisionRecord(it, None, "failed", LIMIT_REASONS[binding],
                              f"{basis}. {LIMIT_NAMES[binding]}가 남지 않아 발주 못 함", dims, metrics)
    _take(inst, limits, cell, qty)
    text = f"{basis}. 발주 {qty}대 ({qty * m.unit_cost}만원)"
    if qty < need:
        metrics["short_qty"] = float(need - qty)
        text += f", {LIMIT_NAMES[binding]}에 걸려 {need - qty}대 못 삼"
    return DecisionRecord(it, {"order_qty": qty, "supplier": m.maker}, "success", None, text, dims, metrics)


# --- solve ------------------------------------------------------------------------

def solve(inst: Instance, params: dict) -> list[DecisionRecord]:
    res = simulate(inst, params)
    return [res.rule_records[it] for it in inst.items()]


# --- validate ----------------------------------------------------------------------

def fixed_orders(inst: Instance, decisions: list[DecisionRecord]) -> tuple[dict[str, int], list[Violation]]:
    """외부 결정을 발주량으로 바꾸고 형식 위반을 모은다. 위반한 결정은 발주 0으로 본다."""
    orders: dict[str, int] = {}
    violations: list[Violation] = []
    valid_items = set(inst.all_items())
    seen: set[str] = set()
    for d in decisions:
        if d.decision is None or d.status not in PLACED_STATUSES:
            continue
        parsed = parse_item(d.item_id)
        if d.item_id not in valid_items or parsed is None:
            violations.append(Violation(d.item_id, "INVALID_DECISION", f"알 수 없는 항목: {d.item_id}"))
            continue
        if d.item_id in seen:
            violations.append(Violation(d.item_id, "INVALID_DECISION", "같은 항목에 결정이 두 번 있음"))
            continue
        seen.add(d.item_id)
        _week, _branch, model = parsed
        qty = parse_order(d.decision)
        if qty is None:
            violations.append(Violation(d.item_id, "INVALID_DECISION", f"order_qty가 정수가 아님: {d.decision}"))
            continue
        maker = inst.models[model].maker
        if d.decision.get("supplier") != maker:
            violations.append(Violation(d.item_id, "INVALID_DECISION",
                                        f"supplier는 이 모델의 제조사 {maker}여야 함 (받은 값: {d.decision.get('supplier')})"))
            continue
        orders[d.item_id] = qty
    return orders, violations


def validate(inst: Instance, decisions: list[DecisionRecord], params: dict) -> list[Violation]:
    orders, violations = fixed_orders(inst, decisions)
    moq = params["order"]["moq"]
    ok: dict[str, int] = {}
    for it, qty in orders.items():
        if qty < 0 or qty % moq:
            violations.append(Violation(it, "MOQ", f"발주량 {qty}는 0 이상이고 {moq}의 배수여야 함"))
            continue
        week, _b, model = parse_item(it)
        m = inst.models[model]
        if qty > 0 and m.eol_week is not None and week >= m.eol_week:
            violations.append(Violation(it, "EOL", f"단종 예정 모델 {m.name}은 {m.eol_week}주부터 발주 금지"))
            continue
        ok[it] = qty

    scope = set(inst.items()) | set(ok)
    res = simulate(inst, params, ok, scope)
    cap = params["budget"]["weekly_cap"]
    order_of = {it: i for i, it in enumerate(inst.all_items())}
    by_week: dict[int, list[str]] = defaultdict(list)
    for it in sorted(ok, key=order_of.get):
        by_week[parse_item(it)[0]].append(it)
    for week, its in by_week.items():
        spent = 0
        supply = defaultdict(int)
        wh_used = defaultdict(int)
        week_cells = {k: c for k, c in res.cells.items() if c.week == week}
        base_position = defaultdict(int)
        for c in week_cells.values():
            base_position[c.branch] += c.on_hand + c.on_order
        for it in its:
            qty = ok[it]
            if qty <= 0:
                continue
            _w, branch, model = parse_item(it)
            m = inst.models[model]
            spent += qty * m.unit_cost
            supply[m.maker] += qty
            wh_used[branch] += qty
            if spent > cap:
                violations.append(Violation(it, "BUDGET", f"{week}주 발주 금액 합 {spent}만원 > 주간 예산 {cap}만원"))
            if supply[m.maker] > inst.makers[m.maker].supply_cap:
                violations.append(Violation(it, "SUPPLY", f"{week}주 {inst.makers[m.maker].name} 발주 합 "
                                                          f"{supply[m.maker]}대 > 공급 한도 {inst.makers[m.maker].supply_cap}대"))
            total = base_position[branch] + wh_used[branch]
            capacity = inst.branches[branch].warehouse_capacity
            if total > capacity:
                violations.append(Violation(it, "WAREHOUSE", f"{week}주 {inst.branches[branch].name} 현재고+입고 예정 "
                                                             f"{total}대 > 창고 용량 {capacity}대"))
    return violations

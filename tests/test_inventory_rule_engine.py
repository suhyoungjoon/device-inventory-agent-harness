"""inventory 규칙 엔진: 손으로 계산한 작은 사례로 solve·validate·지표를 고정한다.

작은 사례: 지점 A 하나, 모델 X(제조사 MA, 주력, 단가 10)와 Y(제조사 MB, 단종 예정 3주, 단가 20), 3주.
리드타임 1주, 이동평균 4주, 안전재고 1주, 검토주기 1주, 최소 발주 단위 5.
  1주: X 현재고 10, 예측 10, 목표 10×2+10=30 → 20대 / Y 현재고 12, 예측 8, 목표 24 → 12 → 15대
  2주: X 입고 20, 현재고 20 → 10대 / Y 입고 15, 현재고 22, 예측 7.25 → 0
  3주: X 입고 10, 현재고 20 → 10대 / Y 현재고 17, 예측 6.5, 목표 19.5 → 5 필요하지만 단종(3주부터 금지)
"""

import copy

import pytest

from core.interfaces import DecisionRecord
from core.storage.store import to_jsonable
from domains.inventory import metrics, rule_engine
from domains.inventory.models import Branch, DeviceModel, Instance, Maker
from domains.inventory.pack import get_pack

PARAMS = {
    "version": 1,
    "forecast": {"window_weeks": 4, "new_model_boost": 1.0},
    "safety": {"weeks": 1.0},
    "review": {"cycle_weeks": 1},
    "supply": {"lead_time_weeks": {"MA": 1, "MB": 1}},
    "order": {"moq": 5},
    "budget": {"weekly_cap": 1000},
    "approval": {"order_amount_gte": 250, "eol_order": True},
    "evaluation": {"excess_weeks": 4},
    "overrides": {"allowed_sections": ["forecast", "safety", "review"], "rules": []},
}


def make_small(capacity=100, supply=100) -> Instance:
    inst = Instance(
        weeks=3, history_weeks=4,
        branches={"A": Branch("A", "서초지점", capacity)},
        makers={"MA": Maker("MA", "제조사 A", supply), "MB": Maker("MB", "제조사 B", supply)},
        models={"X": DeviceModel("X", "A-보급형-9", "mid", "MA", "main", 10),
                "Y": DeviceModel("Y", "B-보급형-9", "mid", "MB", "eol", 20, eol_week=3)},
        history={"A:X": [10, 10, 10, 10], "A:Y": [8, 8, 8, 8]},
        initial_stock={"A:X": 10, "A:Y": 12},
    )
    inst.set_actual({"A:X": [10, 10, 10], "A:Y": [5, 5, 5]})
    return inst


@pytest.fixture
def small():
    return make_small()


def by_id(records):
    return {r.item_id: r for r in records}


def test_items_order_week_branch_model(small):
    assert small.items() == ["W1-A-X", "W1-A-Y", "W2-A-X", "W2-A-Y", "W3-A-X", "W3-A-Y"]


def test_solve_small_case(small):
    r = by_id(rule_engine.solve(small, PARAMS))
    assert r["W1-A-X"].decision == {"order_qty": 20, "supplier": "MA"}
    assert r["W1-A-Y"].decision == {"order_qty": 15, "supplier": "MB"}
    assert r["W2-A-X"].decision["order_qty"] == 10
    assert r["W2-A-Y"].decision["order_qty"] == 0 and r["W2-A-Y"].status == "success"
    assert r["W3-A-X"].decision["order_qty"] == 10
    assert r["W3-A-Y"].status == "failed" and r["W3-A-Y"].reason_code == "EOL_BLOCKED"
    assert r["W1-A-X"].dims == {"branch": "A", "family": "mid", "maker": "MA", "phase": "main", "week_band": "early"}
    assert "예측 10" in r["W1-A-X"].evidence
    assert rule_engine.validate(small, list(r.values()), PARAMS) == []


def test_budget_goes_to_higher_risk_first(small):
    params = copy.deepcopy(PARAMS)
    params["budget"]["weekly_cap"] = 250
    r = by_id(rule_engine.solve(small, params))
    # 결품 위험: X는 예측 1주 치(10/10), Y는 1.5주 치(12/8) → X가 먼저 200만원, 남은 50만원으로 Y는 5대(100만원)도 못 산다
    assert r["W1-A-X"].decision["order_qty"] == 20
    assert r["W1-A-Y"].status == "failed" and r["W1-A-Y"].reason_code == "BUDGET_SHORT"
    assert rule_engine.validate(small, list(r.values()), params) == []


def test_partial_order_when_limit_binds():
    inst = make_small(supply=15)
    r = by_id(rule_engine.solve(inst, PARAMS))
    assert r["W1-A-X"].status == "success" and r["W1-A-X"].decision["order_qty"] == 15
    assert r["W1-A-X"].metrics["short_qty"] == 5
    assert "제조사 공급 한도" in r["W1-A-X"].evidence
    assert rule_engine.validate(inst, list(r.values()), PARAMS) == []


def test_warehouse_limit_fails_with_reason():
    inst = make_small(capacity=40)
    r = by_id(rule_engine.solve(inst, PARAMS))
    # 1주 지점 재고 22 → 남은 자리 18 → X 15대(내림), Y는 자리 3 → 0대
    assert r["W1-A-X"].decision["order_qty"] == 15
    assert r["W1-A-Y"].reason_code == "WAREHOUSE_FULL"
    assert rule_engine.validate(inst, list(r.values()), PARAMS) == []


def test_overrides_apply_per_dims(small):
    params = copy.deepcopy(PARAMS)
    params["overrides"]["rules"] = [{"when": {"maker": "MA"}, "set": {"safety.weeks": 2.0}}]
    r = by_id(rule_engine.solve(small, params))
    assert r["W1-A-X"].decision["order_qty"] == 30      # 목표 10×2 + 20 = 40 − 10
    assert r["W1-A-Y"].decision["order_qty"] == 15      # MB는 그대로


def rec(item, qty, supplier, status="success"):
    return DecisionRecord(item, {"order_qty": qty, "supplier": supplier}, status, None, "", {})


def rules_of(violations):
    return sorted((v.item_id, v.rule) for v in violations)


def test_validate_moq_eol_invalid(small):
    decisions = [rec("W1-A-X", 7, "MA"), rec("W3-A-Y", 5, "MB"), rec("W2-A-X", 10, "MB"),
                 rec("W2-A-Y", 0, "MB"), rec("W2-A-Y", 0, "MB"), rec("W9-A-X", 5, "MA"),
                 DecisionRecord("W3-A-X", {"order_qty": "10", "supplier": "MA"}, "success", None, "", {})]
    assert rules_of(rule_engine.validate(small, decisions, PARAMS)) == [
        ("W1-A-X", "MOQ"), ("W2-A-X", "INVALID_DECISION"), ("W2-A-Y", "INVALID_DECISION"),
        ("W3-A-X", "INVALID_DECISION"), ("W3-A-Y", "EOL"), ("W9-A-X", "INVALID_DECISION")]


def test_validate_limits(small):
    params = copy.deepcopy(PARAMS)
    params["budget"]["weekly_cap"] = 250
    assert rules_of(rule_engine.validate(small, [rec("W1-A-X", 20, "MA"), rec("W1-A-Y", 15, "MB")], params)) == [
        ("W1-A-Y", "BUDGET")]
    assert rules_of(rule_engine.validate(make_small(supply=15), [rec("W1-A-X", 20, "MA")], PARAMS)) == [
        ("W1-A-X", "SUPPLY")]
    # 창고 50: 1주 재고 22 + X 20 = 42, + Y 15 = 57 > 50
    assert rules_of(rule_engine.validate(make_small(capacity=50), [rec("W1-A-X", 20, "MA"), rec("W1-A-Y", 15, "MB")],
                                         PARAMS)) == [("W1-A-Y", "WAREHOUSE")]


def test_failed_and_blocked_are_not_ordered(small):
    decisions = [DecisionRecord("W1-A-X", {"order_qty": 7, "supplier": "MA"}, "blocked", "BLOCKED_BY_GUARDRAIL", "", {}),
                 DecisionRecord("W1-A-Y", None, "failed", "BUDGET_SHORT", "", {})]
    assert rule_engine.validate(small, decisions, PARAMS) == []


def test_metrics_small_case(small):
    m = metrics.compute(small, rule_engine.solve(small, PARAMS), PARAMS)
    assert m["stockout_rate"] == 0 and m["fill_rate"] == 1.0
    # 주말 재고 X 0, 10, 10 / Y 7, 17, 12 → 56 / 수요 45 × 7
    assert m["avg_stock_days"] == pytest.approx(56 / 45 * 7)
    assert m["purchase_amount"] == (20 + 10 + 10) * 10 + 15 * 20
    assert m["excess_stock_value"] == 0
    # 예측 오차: X 0, 0, 0 / Y |8−5|/5, |7.25−5|/5, |6.5−5|/5
    assert m["forecast_mape"] == pytest.approx((0.6 + 0.45 + 0.3) / 6)
    assert m["violation_count"] == 0


def test_metrics_count_stockouts(small):
    decisions = [rec(it, 0, "MA" if it.endswith("X") else "MB") for it in small.items()]
    m = metrics.compute(small, decisions, PARAMS)
    # X: 1주 10 판매 후 0 → 2·3주 10씩 결품 / Y: 12 → 7 → 2 → 0 (3주 5 수요 중 2 판매)
    assert m["stockout_rate"] == pytest.approx((10 + 10 + 3) / 45)
    assert m["fill_rate"] == pytest.approx(3 / 6)


def test_subset_fills_rest_with_rule(small):
    pack = get_pack(PARAMS)
    sub = pack.subset(small, ["W1-A-X"])
    assert pack.items(sub) == ["W1-A-X"]
    full = metrics.compute(small, rule_engine.solve(small, PARAMS), PARAMS)
    # 범위 밖은 규칙으로 채우므로, 같은 결정이면 전체 규칙 결과와 같다 (범위의 지점×모델만 집계)
    assert metrics.compute(sub, [rec("W1-A-X", 20, "MA")], PARAMS)["stockout_rate"] == full["stockout_rate"]
    worse = metrics.compute(sub, [rec("W1-A-X", 0, "MA")], PARAMS)
    assert worse["stockout_rate"] > 0


def test_actual_demand_is_not_serialized(small):
    data = to_jsonable(small)
    assert "_hidden_actual" not in data and "actual" not in data
    assert small.observed("A:X", 2) == [10, 10, 10, 10, 10]


def test_approval_reasons(small):
    pack = get_pack(PARAMS)
    assert pack.approval_reasons(small, rec("W1-A-X", 20, "MA"), []) == []
    reasons = pack.approval_reasons(small, rec("W1-A-Y", 15, "MB"), [])
    assert any("300만원" in r for r in reasons) and any("단종" in r for r in reasons)
    assert pack.approval_reasons(small, rec("W1-A-Y", 0, "MB"), []) == []

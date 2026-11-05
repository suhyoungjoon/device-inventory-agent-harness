"""심어둔 패턴(P1~P4)이 inventory 규칙 agent 결과에 실제로 드러나는지.

드러나지 않으면 분석 agent의 탐지율 지표가 무의미해진다 (도메인 팩 가이드 4장).
결품은 발주 실패가 아니라 재고 흐름 결과라, 결품 구간은 도메인 분석 도구(stockout_by)로 본다.
"""

import copy

import pytest

from domains.inventory.pack import get_pack

SEED = 42


@pytest.fixture(scope="module")
def pack():
    return get_pack()


def run(pack, faults, params=None):
    params = params or pack.params
    p = get_pack(params)
    inst, truth = p.generate(SEED, faults)
    records = p.solve(inst, params)
    return p, inst, truth, records


def tool(p, inst, records, name):
    return next(t for t in p.analysis_tools(inst, records) if t["name"] == name)["handler"]


def stockout(p, inst, records, filters):
    return tool(p, inst, records, "stockout_by")({"group_by": [], "filters": filters})["stockout_rate"]


@pytest.fixture(scope="module")
def base(pack):
    return run(pack, [])


def test_base_has_few_stockouts_and_no_violations(base):
    p, inst, _, records = base
    assert p.validate(inst, records) == []
    assert p.metrics(inst, records)["stockout_rate"] < 0.01


def test_p1_new_model_surge_in_b_early(pack, base):
    sl = {"branch": ["B"], "phase": ["new"], "week_band": ["early"]}
    p, inst, truth, records = run(pack, ["P1"])
    assert stockout(p, inst, records, sl) >= stockout(*base[:2], base[3], sl) + 0.15
    assert len(truth["faults"]["P1"]["affected_items"]) == 6           # 신규 2모델 × 3주
    # 같은 지점의 다른 구간은 거의 그대로
    assert stockout(p, inst, records, {"branch": ["B"], "phase": ["main"]}) < 0.05


def test_p2_supply_cap_failures_only_for_maker_c(pack):
    p, inst, _, records = run(pack, ["P2"])
    failed = [r for r in records if r.reason_code == "SUPPLY_CAP"]
    assert len(failed) >= 15
    assert all(r.dims["maker"] == "MC" for r in failed)
    usage = {r["maker"]: r for r in tool(p, inst, records, "supply_usage")({})["rows"]}
    assert usage["MC"]["weeks_at_cap"] >= 6 and usage["MA"]["weeks_at_cap"] == 0


def test_p3_visible_in_stock_days_not_stockouts(pack, base):
    p, inst, _, records = run(pack, ["P3"])
    stats = {r["branch"]: r for r in tool(p, inst, records, "branch_stock_stats")({})["rows"]}
    base_stats = {r["branch"]: r for r in tool(base[0], base[1], base[3], "branch_stock_stats")({})["rows"]}
    assert stats["A"]["avg_stock_days"] >= base_stats["A"]["avg_stock_days"] + 3     # 서초 과잉
    assert stats["A"]["avg_stock_days"] >= stats["C"]["avg_stock_days"] + 4
    # 실패율(코어 집계)로는 거의 안 보인다: 한도 실패가 없다
    assert not [r for r in records if r.reason_code in ("SUPPLY_CAP", "BUDGET_SHORT", "WAREHOUSE_FULL")]


def test_p4_flagship_stockouts_recover_with_safety_override(pack, base):
    fl = {"family": ["flagship"]}
    p, inst, _, records = run(pack, ["P4"])
    before = stockout(p, inst, records, fl)
    assert before >= stockout(base[0], base[1], base[3], fl) + 0.03
    assert stockout(p, inst, records, {"family": ["mid"]}) < 0.01
    vol = tool(p, inst, records, "demand_volatility")({})["rows"]
    assert vol[0]["family"] == "flagship"

    # 정답표의 param_hint: 플래그십에만 안전재고를 늘리는 구간 조건(bounds 안)으로 결품률이 확실히 내려간다
    improved = copy.deepcopy(pack.params)
    improved["overrides"]["rules"] = [{"when": {"family": "flagship"}, "set": {"safety.weeks": 2.0}}]
    from core.params import check_params
    assert check_params(improved, pack.dimensions()) == []
    p2, inst2, _, after = run(pack, ["P4"], improved)
    assert stockout(p2, inst2, after, fl) <= before * 0.75
    assert p2.metrics(inst2, after)["stockout_rate"] < p.metrics(inst, records)["stockout_rate"]
    assert p2.validate(inst2, after) == []


def test_all_faults_together_no_violations(pack):
    p, inst, truth, records = run(pack, ["P1", "P2", "P3", "P4"])
    assert set(truth["faults"]) == {"P1", "P2", "P3", "P4"}
    assert p.validate(inst, records) == []

"""inventory 생성기와 기본 데이터: 결정론, 규모, 가상 이름, 규칙 결과 위반 0건."""

import json

import pytest

from core.interfaces import ToolContext
from core.storage.store import to_jsonable
from domains.inventory.pack import get_pack


@pytest.fixture(scope="module")
def pack():
    return get_pack()


def test_scale_is_3_branches_10_models_8_weeks(pack):
    inst, truth = pack.generate(42, [])
    assert len(inst.branches) == 3 and len(inst.models) == 10 and inst.weeks == 8
    assert len(pack.items(inst)) == 240
    assert truth == {"faults": {}}
    assert all(len(h) == inst.history_weeks == 26 for h in inst.history.values())


def test_same_seed_same_data(pack):
    a, _ = pack.generate(7, [])
    b, _ = pack.generate(7, [])
    assert to_jsonable(a) == to_jsonable(b)
    assert a._hidden_actual == b._hidden_actual
    c, _ = pack.generate(8, [])
    assert to_jsonable(a) != to_jsonable(c)


def test_model_phases(pack):
    inst, _ = pack.generate(0, [])
    phases = {m.phase for m in inst.models.values()}
    assert phases == {"new", "main", "eol"}
    for m in inst.models.values():
        hist = inst.history[f"A:{m.id}"]
        if m.phase == "new":
            assert hist[:inst.history_weeks - m.launch_offset] == [0] * (inst.history_weeks - m.launch_offset)
        if m.phase == "eol":
            assert m.eol_week is not None


def test_virtual_names_only(pack):
    inst, _ = pack.generate(0, [])
    names = [m.name for m in inst.models.values()] + [mk.name for mk in inst.makers.values()]
    assert all(n.startswith(("A-", "B-", "C-", "제조사 ")) for n in names)


def test_unknown_fault_rejected(pack):
    with pytest.raises(ValueError):
        pack.generate(0, ["P9"])


@pytest.mark.parametrize("seed", [0, 1, 42])
def test_rule_result_has_no_violations(pack, seed):
    inst, _ = pack.generate(seed, [])
    decisions = pack.solve(inst, pack.params)
    assert pack.validate(inst, decisions) == []
    m = pack.metrics(inst, decisions)
    assert 0 <= m["stockout_rate"] < 0.05     # 결함 없는 기본 데이터는 결품이 적다
    assert m["violation_count"] == 0


def test_l0_prompt_has_no_future_demand(pack):
    inst, _ = pack.generate(0, [])
    text = json.dumps(to_jsonable(inst), ensure_ascii=False)
    assert "_hidden_actual" not in text
    week8 = {k: v[7] for k, v in inst._hidden_actual.items()}
    assert set(json.loads(text)) == {"weeks", "history_weeks", "branches", "makers", "models", "history",
                                     "initial_stock", "scope"}
    assert week8   # 실제 수요는 인스턴스 안에만 있다


def test_tools_see_only_past_demand(pack):
    inst, _ = pack.generate(0, [])
    tools = {t["name"]: t["handler"] for t in pack.tools(inst)}
    ctx = ToolContext(item_id="W3-B-M01", decisions=[])
    rows = tools["get_demand_history"]({"weeks": 40}, ctx)["weekly_demand"]
    assert len(rows) == 26 + 2
    assert [r["demand"] for r in rows[-2:]] == inst._hidden_actual["B:M01"][:2]
    stock = tools["get_stock"]({}, ctx)
    assert stock["week"] == 3 and stock["model"] == "M01"
    plan = tools["calc_forecast"]({}, ctx)
    assert plan["need"] % pack.params["order"]["moq"] == 0
    limits = tools["get_limits"]({}, ctx)
    assert limits["budget_left"] == pack.params["budget"]["weekly_cap"]


def test_tools_reflect_decisions_so_far(pack):
    inst, _ = pack.generate(0, [])
    tools = {t["name"]: t["handler"] for t in pack.tools(inst)}
    placed = [pack.solve(inst, pack.params)[0]]          # W1-A-M01
    qty = placed[0].decision["order_qty"]
    limits = tools["get_limits"]({}, ToolContext(item_id="W1-A-M02", decisions=placed))
    assert limits["budget_left"] == pack.params["budget"]["weekly_cap"] - qty * inst.models["M01"].unit_cost
    assert limits["supply_left"]["MA"] == inst.makers["MA"].supply_cap - qty


def test_tool_input_errors_are_returned_not_raised(pack):
    """입력 오류는 {"error"}로 돌려준다. 예외를 던지면 러너가 LLM 오류로 세어 실행이 멈춘다 (실제 AI 실행에서 발생)."""
    inst, _ = pack.generate(0, [])
    tools = {t["name"]: t["handler"] for t in pack.tools(inst)}
    ctx = ToolContext(item_id="W1-A-M10", decisions=[])
    for name in ("get_stock", "get_demand_history", "calc_forecast"):
        out = tools[name]({"branch": "W1", "model": "M10"}, ctx)
        assert "error" in out and "branch는" in out["error"]
    # 항목 ID를 통째로 넣어도 알아듣는다
    assert tools["get_stock"]({"branch": "W1-A-M10"}, ctx)["model"] == "M10"
    assert tools["get_stock"]({"item_id": "W1-B-M02"}, ctx)["branch"] == "B"

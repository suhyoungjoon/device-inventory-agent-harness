"""inventory: 가짜 LLM으로 AI 하네스(L0~L5), 관점별 분석, 가상 구매 규정, 개선안 생성을 한 바퀴 돈다.

실제 API를 부르지 않는다 (tests/inventory_fake.py).
"""

from pathlib import Path

import pytest
import yaml

from core.analysis.aggregate_tools import Aggregator
from core.analysis.perspectives import analyze_perspectives, perspective_errors
from core.evaluation.fault_scorer import score
from core.harness.levels import get_level
from core.harness.runner import HarnessRunner
from core.improvement.constraints import constraint_errors
from core.improvement.proposer import propose
from core.llm.client import load_config
from core.registry import knowledge_dir, load_perspectives
from core.retrieval.documents import load_knowledge
from domains.inventory.pack import get_pack
from tests.fake_llm import FakeLLM
from tests.inventory_fake import FLAGSHIP_RULE, build_policy

FAULTS = ["P1", "P2", "P3", "P4"]


@pytest.fixture(scope="module")
def world():
    pack = get_pack()
    inst, truth = pack.generate(42, FAULTS)
    return pack, inst, truth


@pytest.fixture(scope="module")
def pilot(world):
    """시범 10건: 1주차 서초지점 모델 10종."""
    pack, inst, _ = world
    return pack.subset(inst, pack.items(inst)[:10])


def run(pack, inst, level, policy):
    llm = FakeLLM(policy)
    out = HarnessRunner(pack, llm, get_level(level)).run(inst, run_id="r1", salt="0")
    return out, llm, {d.item_id: d for d in out.decisions}


# --- 발주 agent: 하네스 레벨 ------------------------------------------------------

def test_l0_inlines_instance_without_future_demand(world, pilot):
    pack, _, _ = world
    out, llm, got = run(pack, pilot, "L0", build_policy(pack, pilot, wrong_every=0))
    first = llm.calls[0]
    text = first["messages"][0]["content"][0]["text"]
    assert text.startswith("# 인스턴스 데이터") and "_hidden_actual" not in text
    assert [t["name"] for t in first["tools"]] == ["submit_decision"]
    assert list(got) == pack.items(pilot)
    assert pack.validate(pilot, out.decisions) == []
    # 규칙과 같은 결정이면 지표도 같다 (범위 밖은 규칙으로 채운다)
    assert pack.metrics(pilot, out.decisions) == pack.metrics(pilot, pack.solve(pilot, pack.params))


def test_l2_exposes_domain_tools(world, pilot):
    pack, _, _ = world
    _, llm, _ = run(pack, pilot, "L2", build_policy(pack, pilot, wrong_every=0))
    names = {t["name"] for t in llm.calls[0]["tools"]}
    assert {"get_stock", "get_demand_history", "calc_forecast", "get_limits", "submit_decision"} <= names
    assert "도메인 명세" in llm.calls[0]["system"][0]["text"]


def test_without_validate_loop_moq_violations_remain(world, pilot):
    pack, _, _ = world
    out, _, _ = run(pack, pilot, "L2", build_policy(pack, pilot))
    rules = {v.rule for v in pack.validate(pilot, out.decisions)}
    assert rules == {"MOQ"}


def test_l3_retries_until_valid(world, pilot):
    pack, _, _ = world
    out, llm, _ = run(pack, pilot, "L3", build_policy(pack, pilot))
    assert pack.validate(pilot, out.decisions) == []
    assert len(llm.calls) > len(pack.items(pilot))       # 틀린 첫 제출마다 한 번 더


def test_l4_holds_eol_orders_for_approval(world, pilot):
    pack, _, _ = world
    out, _, got = run(pack, pilot, "L4", build_policy(pack, pilot))
    eol = [it for it, d in got.items() if pilot.models[it.split("-")[2]].phase == "eol"
           and d.decision and d.decision.get("order_qty")]
    assert eol and all(got[it].status == "pending_approval" for it in eol)
    assert pack.validate(pilot, out.decisions) == []


def test_l5_records_traces(world, pilot):
    pack, _, _ = world
    out, _, _ = run(pack, pilot, "L5", build_policy(pack, pilot))
    kinds = {t.kind for t in out.traces}
    assert {"llm", "validate", "retry"} <= kinds


# --- 분석: 관점 파일, 관점별 분석 ---------------------------------------------------

def test_perspectives_are_valid(world):
    pack, inst, _ = world
    decisions = pack.solve(inst, pack.params)
    names = {t["name"] for t in Aggregator(decisions, pack.dimensions()).tools() + pack.analysis_tools(inst, decisions)}
    ps = load_perspectives(pack)
    assert [p["id"] for p in ps] == ["stockout", "efficiency", "constraint"]
    assert perspective_errors(ps, names) == []


def test_perspective_analysis_merges_and_scores(world):
    pack, inst, truth = world
    decisions = pack.solve(inst, pack.params)
    report = analyze_perspectives(pack, inst, decisions, lambda: FakeLLM(build_policy(pack, inst)), load_config(),
                                  perspectives=[{"id": "all", "name": "전체", "question": "모두 본다",
                                                 "tools": ["overview", "aggregate", "stockout_by", "branch_stock_stats"]}])
    result = score(report["findings"], truth["faults"], report["calls"])
    assert (result["detected"], result["pending"]) == (3, 1)


# --- 가상 구매 규정 -------------------------------------------------------------------

def test_knowledge_is_fictional_and_consistent_with_params(world):
    pack, _, _ = world
    schema, chunks, errors = load_knowledge(knowledge_dir(pack))
    assert errors == []
    assert {c.meta["area"] for c in chunks} == set(schema["areas"])
    for c in chunks:
        for path in c.meta.get("params", []):
            section, key = path.split(".")
            assert key in pack.params[section], path
    text = {c.id: c.text for c in chunks}
    limits = yaml.safe_load((knowledge_dir(pack) / "limits.yaml").read_text(encoding="utf-8"))["limits"]
    assert constraint_errors([{k: v for k, v in c.items() if k != "clause"} for c in limits], pack.params, list(pack.dimensions()["metrics"]), pack.dimensions()) == []
    expected = {"STK-01": "21일", "STK-02": "3주", "STK-03": "2.0배"}
    for limit in limits:
        assert expected[limit["clause"]] in text[limit["clause"]]
    bounds = pack.params["safety"]["bounds"]["weeks"]
    assert bounds[0] <= 3 <= bounds[1]                     # 규정 한도가 허용 범위 안
    assert "주간 예산" in text["BUY-01"] and pack.params["budget"]["kinds"]["weekly_cap"] == "governance"


# --- 개선안 생성 -------------------------------------------------------------------

def test_propose_simulates_flagship_rule_and_rejects_governance(world):
    pack, inst, _ = world
    spec = Path(pack.spec_path()).read_text(encoding="utf-8")
    report = {"summary": "x", "findings": [
        {"id": "F1", "title": "신규", "description": "", "slice": {"branch": ["B"], "phase": ["new"]}},
        {"id": "F2", "title": "공급", "description": "", "slice": {"maker": ["MC"]}},
        {"id": "F4", "title": "플래그십 결품", "description": "", "slice": {"family": ["flagship"]}}]}
    out = propose(get_pack, inst, pack.params, spec, pack.dimensions(), report, FakeLLM(build_policy(pack, inst)),
                  load_config())
    ok, budget, spec_edit = out["proposals"]
    assert ok["errors"] == [] and spec_edit["errors"] == []
    assert any("governance" in e for e in budget["errors"])
    sim = next(c for c in out["calls"].values() if c["name"] == "simulate_params")["output"]
    f4 = sim["slices"]["F4"]
    assert f4["before"]["label"] == "결품률"                  # 구간 비교는 결품률 (pack.slice_rates)
    assert f4["after"]["fail_rate"] < f4["before"]["fail_rate"]
    assert sim["after"]["stockout_rate"] < sim["before"]["stockout_rate"]
    assert sim["violations_after"] == 0
    assert ok["proposal"]["override_rules"] == [FLAGSHIP_RULE]


def test_domain_min_effect_overrides_core_threshold():
    from core.improvement.ranking import rank_proposals
    sim = {"before": {"stockout_rate": 0.050}, "after": {"stockout_rate": 0.043}, "violations_before": 0,
           "violations_after": 0}
    props = [{"id": "1", "status": "simulated", "errors": [], "body": {"target_findings": ["F1"]}, "simulation": sim}]
    spec = {"key": "stockout_rate", "primary": True, "better": "down", "format": "pct"}
    assert rank_proposals(props, [spec])["entries"]["1"]["tier"] == "reference"          # 코어 기본 1%p 미만
    assert rank_proposals(props, [{**spec, "min_effect": 0.005}])["entries"]["1"]["tier"] == "main"

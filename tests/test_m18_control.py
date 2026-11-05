"""M18-a: 공통 실행 제어(반복 감지·도구 실패·실행 예산·표준 실패 상태·호출 재시도 설정)와 진단 신호 (가짜 LLM만)."""

import time

import pytest

from core.analysis.agent import finalize_findings
from core.harness.levels import get_level
from core.harness.runner import HarnessRunner
from core.improvement.diagnose import diagnose, dominating_points, missed_slices, target_changes, worsened_metrics
from core.interfaces import DecisionRecord
from core.llm.client import retry_options
from core.llm.control import FAILURES, Budget, RepeatGuard, failure_of_stop, load_budget_config
from core.llm.tool_loop import run_tool_loop
from domains.dispatch.pack import get_pack
from tests.fake_llm import FakeLLM, tool_use
from tests.test_dispatch_rule_engine import small  # noqa: F401 (fixture)

SUBMIT = {"name": "submit", "description": "제출", "input_schema": {"type": "object", "properties": {}}}


def tool(name="look", fail=False):
    return {"name": name, "description": "", "input_schema": {"type": "object", "properties": {}},
            "handler": (lambda a: {"error": "고장"}) if fail else (lambda a: {"ok": True, **a})}


def loop(policy, tools, **kw):
    return run_tool_loop(FakeLLM(policy), system="s", user="u", tools=tools, submit_tool=SUBMIT, max_calls=10, **kw)


# --- 반복·도구 실패 감지 ---

def test_repeat_guard_counts_consecutive_same_calls_only():
    g = RepeatGuard()
    assert g.check("a", {"x": 1}, False) is None
    assert g.check("a", {"x": 2}, False) is None          # 인자가 다르면 처음부터
    assert g.check("a", {"x": 2}, False) is None
    assert g.check("a", {"x": 2}, False) == "repeated"
    g = RepeatGuard()
    assert [g.check("b", {"i": i}, True) for i in range(3)] == [None, None, "tool_failure"]
    assert "AI 응답 3번 연속으로 실패" in g.reason


def test_tool_loop_stops_on_repeat_with_failure_status():
    events = []
    r = loop(lambda item, n, m, t: tool_use("look", {"q": "same"}), [tool()], on_event=events.append)
    assert r.stop == "repeated" and r.llm_calls == 3 and r.submission is None
    assert r.failure == {"status": "repeated", "label": "반복 실패", "reason": "look을(를) 같은 인자로 3번 연속 호출"}
    assert events[-1]["type"] == "end" and events[-1]["failure"]["label"] == "반복 실패"


def test_tool_loop_stops_on_tool_failure():
    r = loop(lambda item, n, m, t: tool_use("broken", {"i": n}), [tool("broken", fail=True)])
    assert r.stop == "tool_failure" and r.failure["label"] == "도구 실패" and r.llm_calls == 3


def test_parallel_errors_in_one_turn_count_once():
    """회귀 (2026-10-20 실사용): 개선 에이전트가 한 턴에 simulate_params를 4번 불러 3번 형식이 틀리자 바로 멈췄다.
    오류는 AI 턴 단위로 센다: 한 턴의 여러 오류는 1번, 다음 턴에 고칠 기회를 준다."""
    g = RepeatGuard()
    assert [g.check("sim", {"i": i}, True, turn=1) for i in range(3)] == [None, None, None]
    assert g.check("sim", {"i": 9}, False, turn=1) is None and g.errors["sim"] == 0
    assert [g.check("sim", {"t": t}, True, turn=t) for t in (2, 3, 4)] == [None, None, "tool_failure"]

    def policy(item, n, m, t):     # 1턴: 병렬 4개 중 3개 오류 → 2턴: 제출
        if n == 0:
            return [tool_use("broken", {"i": i}) for i in range(3)] + [tool_use("look", {"ok": 1})]
        return tool_use("submit", {})
    r = loop(policy, [tool("broken", fail=True), tool()])
    assert r.stop == "submitted" and r.failure is None


def test_tool_loop_budget_stops_before_next_call():
    r = loop(lambda item, n, m, t: tool_use("look", {"i": n}), [tool()], budget=Budget(max_seconds=0))
    assert r.stop == "budget" and r.llm_calls == 0 and r.failure["status"] == "budget_exceeded"


def test_submitted_has_no_failure_and_unresolved_otherwise():
    r = loop(lambda item, n, m, t: tool_use("submit", {}), [tool()])
    assert r.stop == "submitted" and r.failure is None
    assert failure_of_stop("no_submit")["label"] == "해결 불가" and failure_of_stop("max_calls")["label"] == "해결 불가"
    assert set(FAILURES.values()) == {"근거 부족", "도구 실패", "반복 실패", "예산 초과", "해결 불가"}


# --- 실행 예산 ---

class Resp:
    def __init__(self, inp, out):
        self.usage = {"input_tokens": inp, "output_tokens": out}
        self.from_cache = False


def test_budget_charges_estimated_cost_and_time():
    cfg = {"pricing_per_mtok": {"m": {"input": 1.0, "output": 10.0}}}
    b = Budget(max_usd=1.0)
    b.charge(Resp(400_000, 50_000), "m", cfg)                     # 0.4 + 0.5
    assert b.spent_usd == pytest.approx(0.9) and b.exceeded() is None
    b.charge(Resp(100_000, 0), "m", cfg)
    assert "상한 $1.00" in b.exceeded()
    unpriced = Budget(max_usd=0.01)
    unpriced.charge(Resp(10**9, 10**9), "unknown", cfg)           # 단가를 모르면 비용은 세지 않는다
    assert unpriced.exceeded() is None
    assert "상한" in Budget(max_seconds=0.0, started=time.time() - 1).exceeded()


def test_budget_defaults_from_workflow_config():
    # M21-e: 이 레포는 실제 실행 여유로 1.5 → 5.0달러 (사용자 허용 2026-11-05)
    assert load_budget_config() == {"max_usd": 5.0, "max_seconds": 1200}
    b = Budget.from_config()
    assert (b.max_usd, b.max_seconds) == (5.0, 1200)


def test_retry_options_from_llm_config():
    assert retry_options({"retries": 2, "timeout_s": 180}) == {"max_retries": 2, "timeout": 180.0}
    assert retry_options({}) == {}


# --- LangGraph 도구 에이전트 ---

def test_langgraph_tool_agent_stops_on_repeat():
    pytest.importorskip("langgraph")
    from workflow.agents.context import AgentContext
    from workflow.agents.tool_agent import build_tool_agent, run_tool_agent

    ctx = AgentContext()
    llm = FakeLLM(lambda item, n, m, t: tool_use("look", {"q": "same"}))
    g = build_tool_agent(ctx, "a", llm=llm, system="s", tools=[tool()], submit_tool=SUBMIT, max_calls=10)
    out = run_tool_agent(g, "u")
    assert out["stop"] == "repeated" and out["failure"]["label"] == "반복 실패" and out["llm_calls"] == 3
    assert any("멈춤" in e["text"] for e in ctx.events)
    ctx = AgentContext(data={"budget": Budget(max_seconds=0)})   # 워크플로우가 나눠 쓰는 예산
    out = run_tool_agent(build_tool_agent(ctx, "a", llm=llm, system="s", tools=[tool()], submit_tool=SUBMIT), "u")
    assert out["stop"] == "budget" and out["failure"]["label"] == "예산 초과"


# --- 배정 러너: 항목 단위로 반복을 끊는다 ---

def test_dispatch_runner_fails_item_on_repeat(small):  # noqa: F811
    pack = get_pack()
    llm = FakeLLM(lambda it, n, m, t: tool_use("get_order", {"order_id": it}))
    out = HarnessRunner(pack, llm, get_level("L2")).run(small, run_id="r1", salt="0")
    assert all(d.status == "failed" and d.reason_code == "LLM_REPEATED" and d.metrics["llm_calls"] == 3
               for d in out.decisions)


# --- 근거 부족 발견은 지우지 않는다 ---

def test_dropped_findings_keep_insufficient_evidence_status():
    kept, dropped = finalize_findings([{"title": "x", "description": "실패 99건", "cited_calls": []}], {}, {})
    assert not kept and dropped[0]["status"] == "insufficient_evidence"


# --- 진단 신호 ---

DIMS = {"dimensions": {"zone": {"values": ["a", "b", "c"]}, "kind": {"values": ["p", "q"]}},
        "metrics": {"rate": {"primary": True, "better": "up"}, "on_time": {"better": "up", "label": "정시"},
                    "travel": {"better": "down"}}}


def rec(i, zone, kind, ok):
    return DecisionRecord(f"i{i}", {} if ok else None, "success" if ok else "failed", None if ok else "X", "",
                          {"zone": zone, "kind": kind})


def test_target_changes_and_worsened_metrics():
    sim = {"before": {"rate": 0.8, "on_time": 0.5, "travel": 10}, "after": {"rate": 0.85, "on_time": 0.47, "travel": 9},
           "slices": {"F1": {"before": {"fail_rate": 0.4, "failed": 8}, "after": {"fail_rate": 0.4, "failed": 8}},
                      "F2": {"before": {"fail_rate": 0.3, "failed": 6}, "after": {"fail_rate": 0.1, "failed": 2}}}}
    t = {c["finding"]: c for c in target_changes(sim)}
    assert t["F1"]["improved"] is False and t["F2"]["improved"] is True and t["F2"]["delta"] == -0.2
    assert [c["finding"] for c in target_changes(sim, ["F2"])] == ["F2"]
    w = worsened_metrics(sim, DIMS)
    assert [x["metric"] for x in w] == ["on_time"] and w[0]["label"] == "정시"   # travel은 줄어서 좋아짐, rate는 핵심


def test_missed_slices_skip_slices_covered_by_findings():
    decisions = ([rec(i, "a", "p", False) for i in range(6)] + [rec(10 + i, "b", "q", False) for i in range(3)]
                 + [rec(20 + i, "c", "q", True) for i in range(5)])
    findings = [{"id": "F1", "slice": {"zone": ["a"]}}]
    got = missed_slices(decisions, DIMS, findings)
    assert ("zone", "a") not in {(r["dimension"], r["value"]) for r in got}
    assert got[0] == {"dimension": "kind", "value": "p", "failed": 6, "items": 6, "fail_rate": 1.0, "share_of_failed": 0.6667}
    assert [(r["dimension"], r["value"], r["failed"]) for r in got[1:]] == [("kind", "q", 3), ("zone", "b", 3)]
    assert missed_slices([rec(1, "a", "p", True)], DIMS, []) == []


def test_dominating_points_respect_direction_and_violations():
    cand = {"rate": 0.8, "on_time": 0.5, "travel": 10}
    points = [{"values": {"x": 1}, "metrics": {"rate": 0.82, "on_time": 0.5, "travel": 9}, "violations": 0},   # 지배
              {"values": {"x": 2}, "metrics": {"rate": 0.9, "on_time": 0.4, "travel": 8}, "violations": 0},    # 득실
              {"values": {"x": 3}, "metrics": {"rate": 0.9, "on_time": 0.6, "travel": 5}, "violations": 2},    # 위반
              {"values": {"x": 4}, "metrics": dict(cand), "violations": 0}]                                     # 같음
    assert [p["values"]["x"] for p in dominating_points(points, cand, DIMS)] == [1]


def test_diagnose_marks_missing_inputs_none():
    sim = {"before": {"rate": 0.8}, "after": {"rate": 0.9}, "slices": {}}
    d = diagnose(sim, DIMS, [])
    assert d == {"targeted": False, "target_changes": [], "worsened_metrics": [], "missed_slices": None, "dominated_by": None}

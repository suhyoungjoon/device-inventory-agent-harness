"""M18-b: 분석·개선 Supervisor (가짜 LLM만). 기존 분석·개선 에이전트·계산 도구를 도구로 부르고,
추천 조건·호출 상한·예산·판단 보고서 형식은 코드가 지킨다."""

import pytest

from core.improvement.supervisor import LIMITS, judgment_tool, supervise
from core.llm.control import Budget
from core.registry import load_pack, load_params, load_perspectives
from scripts.rehearsal_bundle import build_policy
from tests.fake_llm import FakeLLM, tool_use

FAULTS = ["P1", "P2", "P3", "P4"]


@pytest.fixture(scope="module")
def world():
    pack = load_pack("dispatch")
    params = load_params(pack)
    pack = load_pack("dispatch", params)
    instance, _ = pack.generate(42, FAULTS)
    decisions = pack.solve(instance, params)
    spec = open(pack.spec_path(), encoding="utf-8").read()
    return pack, params, instance, decisions, spec, build_policy(pack, instance)


def judgment(recs, **kw):
    return tool_use("submit_judgment", {
        "summary": "요약", "recommendations": recs,
        "hypotheses": [{"statement": "경계 지역 거리 제한", "support": "c1", "against": "없음", "confidence": "중간",
                        "would_flip": "경계 지역만 완화해도 실패율이 그대로면"}],
        "attempts": [{"what": "분석 → 개선 → 미리 돌려보기", "why": "기본 순서", "learned": "경계 구간 개선"}],
        "questions_for_human": [], "end_reason": "good_enough", **kw})


def rec(pid, ref="c3", effect="경계 지역 배정이 늘어남"):
    return {"proposal_id": pid, "cited_calls": [ref], "expected_effect": effect, "loses": "거의 없음", "confidence": "중간"}


def run(world, script, sub_policy=None, **kw):
    """script(n, messages) → Supervisor 응답. 분석·개선은 리허설 가짜 정책 (sub_policy로 바꿀 수 있다)."""
    pack, params, instance, decisions, spec, policy = world
    policy = sub_policy or policy
    sup = FakeLLM(lambda item, n, m, t: script(n, m))

    def make_llm(role):   # 하위 에이전트는 부를 때마다 새 클라이언트 (대화 상태를 나누지 않게)
        return sup if role == "supervisor" else FakeLLM(policy)
    out = supervise(pack, lambda p: load_pack("dispatch", p), instance, decisions, params, spec, make_llm, {},
                    perspectives=load_perspectives(pack), salt="t", **kw)
    return out, sup


def happy(n, m):
    return [tool_use("run_analysis", {}), tool_use("run_proposals", {}), tool_use("simulate", {"proposal_id": "P1"}),
            judgment([rec("P1")])][min(n, 3)]


def test_supervisor_runs_existing_agents_as_tools_and_reports(world):
    events = []
    out, sup = run(world, happy, on_event=events.append)
    assert out["failure"] is None and out["problems"] == [] and out["judgment"]["recommendations"][0]["proposal_id"] == "P1"
    assert list(out["reports"]) == ["R1"] and all(fid.startswith("R1-") for fid in out["findings"])
    assert [p["proposal"]["title"] for p in out["proposals"].values()][0].startswith("경계 지역만")
    sim = out["simulations"]["P1"]
    assert sim["result"]["after"]["assignment_rate"] > sim["result"]["before"]["assignment_rate"]
    assert set(sim["diagnosis"]) == {"targeted", "target_changes", "worsened_metrics", "missed_slices", "dominated_by"}
    assert sim["diagnosis"]["targeted"] and [t["finding"] for t in sim["diagnosis"]["target_changes"]] == ["R1-F3"]   # F3 → R1-F3
    assert sim["diagnosis"]["target_changes"] and isinstance(sim["diagnosis"]["missed_slices"], list)
    assert out["counts"] == {"total": 3, "run_analysis": 1, "run_proposals": 1}
    assert [a["tool"] for a in out["attempts_log"]] == ["run_analysis", "run_proposals", "simulate"]
    # 하위 에이전트의 진행도 같은 타임라인에 (어느 호출인지 item으로)
    assert {e.get("item") for e in events} >= {"분석 R1", "개선 B1"}
    assert [t["name"] for t in sup.calls[0]["tools"]] == ["run_analysis", "run_proposals", "simulate", "sweep",
                                                         "submit_judgment"]
    # 규칙을 바꾸거나 승인하는 도구는 없다
    assert not {"approve", "apply_params", "update_params"} & {t["name"] for t in sup.calls[0]["tools"]}


def test_cannot_recommend_unsimulated_or_invalid_and_ends_unresolved(world):
    def script(n, m):
        return [tool_use("run_analysis", {}), tool_use("run_proposals", {}), tool_use("simulate", {"proposal_id": "P2"}),
                judgment([rec("P1"), rec("P2")])][min(n, 3)]
    out, sup = run(world, script)
    assert out["simulations"]["P2"]["errors"]                       # 허용 범위 밖 → 적용 불가
    assert out["judgment"] is None and out["failure"]["label"] == "해결 불가"
    assert any("simulate로 돌리지 않은" in p for p in out["problems"])
    assert any("적용 불가 안은 추천할 수 없다" in p for p in out["problems"])
    assert out["draft"]["recommendations"]                          # 그때까지의 보고서·시도 기록은 남는다
    assert out["attempts_log"]
    # 한 번 돌려보냈다 (반려 메시지가 AI에게 갔다)
    assert any("제출을 반려한다" in str(c["messages"][-1]) for c in sup.calls)


def test_numbers_in_effect_must_come_from_cited_calls(world):
    def script(n, m):
        return [tool_use("run_analysis", {}), tool_use("run_proposals", {}), tool_use("simulate", {"proposal_id": "P1"}),
                judgment([rec("P1", effect="배정률 12.345%p 상승")])][min(n, 3)]
    out, _ = run(world, script)
    assert any("12.345%" in p and "인용한 도구 결과에 없다" in p for p in out["problems"])


def test_call_limits_are_enforced_by_code(world):
    def script(n, m):
        return tool_use("run_analysis", {"question": f"질문 {n}"}) if n < 4 else judgment([])
    out, _ = run(world, script)
    assert len(out["reports"]) == LIMITS["run_analysis"]
    assert out["counts"]["run_analysis"] == LIMITS["run_analysis"] + 1   # 넘은 호출은 오류로 돌려준다


def test_custom_question_and_slice_reanalysis(world):
    def script(n, m):
        return [tool_use("run_analysis", {"question": "경계 지역만 다시 보라", "slice": {"area_zone": ["boundary"]}}),
                judgment([])][min(n, 1)]
    def overview_only(item, n, m, t):   # 리허설 분석 정책은 전체 데이터를 가정하므로 최소 분석으로
        return tool_use("overview", {}) if n == 0 else tool_use("submit_report", {"summary": "s", "findings": []})
    out, _ = run(world, script, sub_policy=overview_only)
    r = out["reports"]["R1"]
    boundary = sum(d.dims.get("area_zone") == "boundary" for d in world[3])
    assert r["items"] == boundary < len(world[3]) and r["args"]["slice"] == {"area_zone": ["boundary"]}
    assert next(iter(r["calls"].values()))["output"]["items"] == boundary   # 분석 에이전트가 구간만 봤다
    out2, _ = run(world, lambda n, m: [tool_use("run_analysis", {"slice": {"area_zone": ["nowhere"]}}), judgment([])][min(n, 1)])
    assert not out2["reports"]                                          # 해당 항목 없음 → 오류로 돌려줌


def test_direct_change_simulation_gets_s_id_and_perspectives_are_checked(world):
    def script(n, m):
        return [tool_use("run_analysis", {"perspectives": ["nope"]}),
                tool_use("simulate", {"params_changes": [{"path": "matching.area_extension_km[2]", "value": 4}]}),
                judgment([rec("S1", ref="c2")])][min(n, 2)]
    out, _ = run(world, script)
    assert not out["reports"] and "S1" in out["simulations"] and out["judgment"] is not None


def test_budget_is_shared_and_stops_supervisor(world):
    out, sup = run(world, happy, budget=Budget(max_seconds=0))
    assert out["stop"] == "budget" and out["failure"]["label"] == "예산 초과" and not sup.calls


def test_judgment_tool_requires_core_fields():
    req = judgment_tool()["input_schema"]["required"]
    assert {"recommendations", "hypotheses", "attempts", "end_reason"} <= set(req)


def test_same_tool_same_args_three_times_stops_as_repeated(world):
    def script(n, m):
        return tool_use("sweep", {"axes": [{"path": "matching.area_extension_km[2]", "values": [3, 4]}]})
    out, sup = run(world, script)
    assert out["stop"] == "repeated" and out["failure"]["label"] == "반복 실패" and len(sup.calls) == 3
    assert out["judgment"] is None and [a["tool"] for a in out["attempts_log"]] == ["sweep"] * 3


def test_budget_shared_with_called_agents_stops_mid_run(world):
    """하위 에이전트(분석·개선)의 비용도 같은 예산에서 나간다. 넘으면 Supervisor가 다음 턴 전에 멈춘다."""
    priced = {"pricing_per_mtok": {"fake-model": {"input": 1000.0, "output": 1000.0}}}   # 호출 하나에 약 $0.16
    pack, params, instance, decisions, spec, policy = world
    sup = FakeLLM(lambda item, n, m, t: happy(n, m))

    def make_llm(role):
        llm = sup if role == "supervisor" else FakeLLM(policy)
        llm.config = priced
        return llm
    budget = Budget(max_usd=0.5)
    out = supervise(pack, lambda p: load_pack("dispatch", p), instance, decisions, params, spec, make_llm, priced,
                    perspectives=load_perspectives(pack), salt="t", budget=budget)
    assert out["stop"] == "budget" and out["failure"]["label"] == "예산 초과" and out["judgment"] is None
    assert budget.spent_usd >= 0.5 and len(sup.calls) < 4             # 보고서까지 가지 못함
    assert out["reports"]                                              # 그때까지의 결과는 남는다


def test_numbers_from_the_recommended_change_and_rounding_are_grounded():
    """회귀 (2026-10-20 실제 API S3): 기대 효과의 '10시만'에서 10이 지표 수치로 오인돼 해결 불가가 됐다.
    추천한 안의 변경값(구간 조건 값)은 근거로 인정하고, 반올림한 수치도 인정한다."""
    from core.improvement.supervisor import judgment_problems

    calls = {"t1": {"ref": "c3", "name": "simulate", "output": {"after": {"rate": 0.6681985}}}}
    state = {"simulations": {"S4": {"errors": [], "change": {"override_rules": [
        {"when": {"branch": ["B"], "hour": ["10"]}, "set": {"matching.time_window_min[1]": 45}}]}}}}
    base = {"hypotheses": [{"confidence": "중간"}], "attempts": [{}], "end_reason": "good_enough"}
    ok = {"proposal_id": "S4", "cited_calls": ["c3"], "expected_effect": "B지점 10시만 허용오차 45분, 배정 성공률 66.8%",
          "loses": "정시 배정 0.668 수준", "confidence": "중간"}
    assert judgment_problems({**base, "recommendations": [ok]}, calls, state) == []
    bad = {**ok, "expected_effect": "배정 성공률 71.2%"}
    assert any("71.2%" in p for p in judgment_problems({**base, "recommendations": [bad]}, calls, state))


# --- 분석에서 개선할 문제가 없으면 더 진행하지 않는다 (시연 케이스) ---

def no_findings_policy(item, n, messages, tools):
    """분석 에이전트가 발견 0건으로 리포트를 낸다 (결함 없는 데이터에서 바꿀 거리가 없는 상황)."""
    names = {t["name"] for t in tools}
    if "submit_report" in names:
        return tool_use("submit_report", {"summary": "개선할 구간 패턴 없음", "findings": []})
    return tool_use("submit_proposals", {"proposals": []})


def test_analysis_without_findings_tells_supervisor_to_stop(world):
    """발견 0건이면 run_analysis가 '여기서 끝내라'를 돌려주고, run_proposals는 거절한다."""
    seen = {}

    def script(n, m):
        if n == 0:
            return tool_use("run_analysis", {})
        if n == 1:
            return tool_use("run_proposals", {})          # 그래도 불러 보면 거절당한다
        return judgment([], end_reason="no_further_gain")

    out, sup = run(world, script, sub_policy=no_findings_policy)
    results = [b for msg in sup.calls[-1]["messages"] if isinstance(msg.get("content"), list)
               for b in msg["content"] if b.get("type") == "tool_result"]
    texts = [str(b.get("content")) for b in results]
    assert any("stop_here" in t and "run_proposals로 넘어가지 말고" in t for t in texts), texts
    assert any("개선안을 만들지 말고" in t for t in texts), texts
    assert out["judgment"] and out["judgment"]["end_reason"] == "no_further_gain"
    assert out["judgment"]["recommendations"] == []
    assert out["counts"]["run_proposals"] == 1 and not out["proposals"]   # 호출은 셌지만 안은 만들어지지 않았다
    seen.clear()


def test_recommendation_below_min_effect_is_rejected(world):
    """효과가 최소 효과 기준 미만인 안은 추천할 수 없다 (고정 흐름 순위와 같은 기준)."""
    import core.improvement.supervisor as sup_mod

    real = sup_mod._primary_gain
    sup_mod._primary_gain = lambda sim, state: 0.001        # +0.1%p: 기준(1%p) 미만
    try:
        out, _ = run(world, happy)
    finally:
        sup_mod._primary_gain = real
    assert out["judgment"] is None
    assert any("최소 효과" in p and "추천할 수 없다" in p for p in out["problems"]), out["problems"]

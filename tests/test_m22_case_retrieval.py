"""M22: LangGraph 회차 루프의 과거 사례 검색과 사람 결정 → 사례 (가짜 AI, 네트워크·키 없음).

1. use_cases에 따라 루프 개선 단계의 검색 도구에 사례(case)가 붙고 빠진다.
2. 루프에서 반려한 결정이 다음 실행의 사례 조각이 된다 (시연 모드에서는 쓰지 않는다).
3. 받지 않은 사례 id를 인용한 안은 적용 불가가 된다.
4. use_memory=false면 같은 실행 안의 반려가 개선 제안 입력에 들어가지 않는다 (화면 기록은 남는다).
"""

import shutil
import time

import pytest

pytest.importorskip("langgraph")

from core.improvement.proposer import CASE_NOTE  # noqa: E402
from core.registry import set_domain_files_root  # noqa: E402
from core.retrieval import search_tool  # noqa: E402
from core.storage.store import Store  # noqa: E402
from scripts.rehearsal_bundle import BOUNDARY_RULE  # noqa: E402
from tests.fake_llm import FakeLLM, tool_use  # noqa: E402
from workflow.agents.api import AgentRuns, AgentsStart  # noqa: E402
from workflow.api import StepRequest  # noqa: E402

METRICS = [{"key": "assignment_rate", "label": "배정 성공률", "format": "pct", "primary": True, "better": "up"}]
NOTE = "규정 한도를 먼저 확인할 것"


@pytest.fixture
def env(tmp_path):
    """규칙 파일은 임시 사본 (승인해도 레포 파일이 바뀌지 않게), DB·색인·기록도 임시."""
    root = tmp_path / "domains"
    shutil.copytree("domains/dispatch", root / "dispatch")
    set_domain_files_root(root)
    store = Store(tmp_path / "harness.db")
    try:
        yield {"store": store, "tmp": tmp_path,
               "runs": lambda demo=False: AgentRuns(demo, tmp_path / "retrieval.sqlite", store, tmp_path / "flows")}
    finally:
        set_domain_files_root(None)


def start(runs, **kw):
    req = AgentsStart(domain="dispatch", seed=42, faults=["P1", "P2", "P3", "P4"], items=10, level="L3",
                      metrics=METRICS, pace=0, llm="fake", **kw)
    snap = runs.start(req)
    ctx = runs.runs.flows[snap["id"]]["_ctx"]
    made: list = []
    base = ctx.make_llm

    def make(role=None):      # 만든 가짜 AI를 모아 둔다 (입력·도구 확인용)
        llm = base(role)
        made.append((role, llm))
        return llm
    ctx.make_llm = make
    return snap, ctx, made


def step(runs, flow_id, action="next", note=""):
    runs.step(flow_id, StepRequest(action=action, note=note))
    deadline = time.time() + 120
    while (snap := runs.snapshot(flow_id))["status"] == "running":
        assert time.time() < deadline
        time.sleep(0.02)
    assert snap["error"] is None, snap["error"]
    return snap


def until(runs, snap, stop):
    while not stop(snap) and snap["status"] != "done":
        snap = step(runs, snap["id"])
    return snap


def proposal_calls(made):
    return [c for role, llm in made if role == "proposals" for c in llm.calls
            if any(t["name"] == "submit_proposals" for t in c["tools"])]


def search_kinds(call) -> list[str] | None:
    tool = next((t for t in call["tools"] if t["name"] == "search_knowledge"), None)
    return None if tool is None else tool["input_schema"]["properties"]["kinds"]["items"]["enum"]


def at_review(snap):
    return snap["waiting"] == "approval"


def test_case_search_attaches_by_use_cases(env):
    for kw, want in (({}, ["regulation", "case", "opinion"]), ({"use_cases": False}, ["regulation", "opinion"]),
                     ({"use_knowledge": False}, None)):
        runs = env["runs"]()
        snap, ctx, made = start(runs, **kw)
        snap = until(runs, snap, lambda s: any(x["node"] == "proposal_agent" for x in s["steps"]))
        call = proposal_calls(made)[0]
        kinds = search_kinds(call)
        user = call["messages"][0]["content"]
        assert (sorted(kinds) if kinds else None) == (sorted(want) if want else None), kw
        assert (CASE_NOTE in user) == bool(want and "case" in want), kw
        assert snap["loop"]["retrieval_options"]["kinds"] == sorted(want or [])
        if want:   # 개선 단계 줄에 "검색: 규정 n · 사례 n · 의견 n"
            line = next(x for s in snap["steps"] if s["node"] == "proposal_agent" for x in s["lines"]
                        if x.startswith("검색: "))
            assert line.startswith("검색: 규정 ") and (("사례 0" in line) == ("case" in want))


def test_rejection_becomes_case_for_next_run(env):
    store = env["store"]
    runs = env["runs"]()
    snap, _ctx, _ = start(runs)
    snap = until(runs, snap, at_review)
    title = snap["approval"]["title"]
    snap = step(runs, snap["id"], "reject", NOTE)
    rows = store.loop_cases("dispatch")
    assert len(rows) == 1 and rows[0]["status"] == "rejected" and rows[0]["flow_id"] == snap["id"]
    body = rows[0]["body"]
    assert body["decision"]["note"] == NOTE and body["body"]["title"] == title
    assert set(body["simulation"]["before"]) == {"assignment_rate"}      # 핵심 지표만 (정답표·가상 실적 없음)
    assert "truth" not in str(body) and "faults" not in body
    cid = f"case-{rows[0]['id'][-8:]}"
    assert snap["loop"]["cases_written"] == [cid]

    # 다음 실행 (같은 데이터, 새 기억): 사례 검색으로만 이전 반려를 찾는다
    runs2 = env["runs"]()
    snap2, ctx2, _ = start(runs2)
    snap2 = step(runs2, snap2["id"])           # prepare
    retrieval = ctx2.data["retrieval"]
    chunk = next(c for c in retrieval["index"].chunks(["case"]) if c.id == cid)
    assert chunk.title == f"[반려] {title}" and NOTE in chunk.text
    hits = search_tool(retrieval["index"], retrieval["kinds"])["handler"]({"query": "경계 지역 반려", "kinds": ["case"]})
    assert cid in [h["ref"] for h in hits["hits"]]
    assert ctx2.data["rejections"] == []      # 같은 실행 안의 기억은 비어 있다

    # 시연 모드(저장된 결과 재생)에서는 사례를 쓰지 않는다
    demo = env["runs"](demo=True)
    snap3, _, _ = start(demo)
    snap3 = until(demo, snap3, at_review)
    step(demo, snap3["id"], "reject", "시연 반려")
    assert len(store.loop_cases("dispatch")) == 1


def test_citing_unreceived_case_is_not_applicable(env):
    store = env["store"]
    store.save_loop_case("prev0000aaaa1111", "dispatch", "rejected", {
        "body": {"title": "경계 지역만 3단계 지역 범위 +2km", "kind": "params", "override_rules": [BOUNDARY_RULE]},
        "simulation": {"before": {"assignment_rate": 0.8}, "after": {"assignment_rate": 0.82}},
        "decision": {"action": "reject", "note": NOTE}, "findings": [], "params_version": 1})
    received = "case-aaaa1111"
    runs = env["runs"]()
    snap, ctx, made = start(runs)
    base_make = ctx.make_llm

    def proposer(item, n, messages, tools):
        if n == 0:
            return tool_use("search_knowledge", {"query": "반려된 경계 지역 안", "kinds": ["case"]})
        return tool_use("submit_proposals", {"proposals": [
            {"title": "받은 사례를 근거로 한 안", "kind": "params", "target_findings": ["F3"], "rationale": "r",
             "params_changes": [{"path": "matching.area_extension_km[2]", "value": 4}], "cited_docs": [received]},
            {"title": "받지 않은 사례를 인용한 안", "kind": "params", "target_findings": ["F3"], "rationale": "r",
             "params_changes": [{"path": "matching.area_extension_km[2]", "value": 4}], "cited_docs": ["case-deadbeef"]}]})

    def make(role=None):
        return FakeLLM(proposer) if role == "proposals" else base_make(role)
    ctx.make_llm = make
    snap = until(runs, snap, lambda s: any(x["node"] == "proposal_agent" for x in s["steps"]))
    by_title = {p["title"]: p for p in snap["proposals"]}
    assert by_title["받은 사례를 근거로 한 안"]["status"] == "proposed"
    bad = by_title["받지 않은 사례를 인용한 안"]
    assert bad["status"] == "invalid" and "검색 결과에 없는 문서 조각 인용: case-deadbeef" in bad["errors"][0]
    ret = snap["loop"]["retrieval"]
    assert received in [c["id"] for c in ret["chunks"]] and received in ret["cited"]
    step_rec = next(s for s in snap["steps"] if s["node"] == "proposal_agent")
    assert step_rec["retrieval"]["counts"].get("case") == 1
    assert step_rec["retrieval"]["cases"][0]["ref"] == received and step_rec["retrieval"]["cases"][0]["cited"]


@pytest.mark.parametrize("use_memory", [True, False])
def test_use_memory_false_keeps_rejections_out_of_prompt(env, use_memory):
    runs = env["runs"]()
    snap, _ctx, made = start(runs, use_cases=False, use_memory=use_memory)
    reason = "사유XYZ 경계 거리 과함"
    while sum(x["node"] == "proposal_agent" for x in snap["steps"]) < 2 and snap["status"] != "done":
        snap = step(runs, snap["id"], "reject", reason) if at_review(snap) else step(runs, snap["id"])
    users = [c["messages"][0]["content"] for c in proposal_calls(made)]
    assert len(users) >= 2, "모두 반려 → 다시 제안까지 가야 한다"
    assert (reason in users[-1]) == use_memory
    if not use_memory:      # 기억을 끄면 다시 제안의 입력이 첫 제안과 같다
        assert users[-1] == users[0]
    assert all(d["note"] == reason for d in snap["loop"]["decisions"] if d["action"] == "reject")
    assert snap["loop"]["decisions"], "화면의 반려 기록은 기억을 꺼도 남는다"
    assert snap["loop"]["retrieval_options"]["use_memory"] is use_memory


@pytest.mark.parametrize("use_cases", [True, False])
def test_supervisor_mode_gets_the_same_case_search(env, use_cases):
    """Supervisor가 부르는 개선 에이전트(core propose)와 Supervisor 자신의 검색에도 사례가 같은 규칙으로 붙는다."""
    runs = env["runs"]()
    snap, _ctx, made = start(runs, mode="supervisor", use_cases=use_cases)
    snap = until(runs, snap, lambda s: any(x["node"] == "supervisor_agent" for x in s["steps"]))
    sub = proposal_calls(made)[0]
    sup = next(c for role, llm in made if role == "supervisor" for c in llm.calls)
    for call in (sub, sup):
        assert ("case" in search_kinds(call)) == use_cases
    assert (CASE_NOTE in sub["messages"][0]["content"]) == use_cases
    assert any(x.startswith("검색: ") for s in snap["steps"] if s["node"] == "supervisor_agent" for x in s["lines"])


def test_m22_eval_fake_runs_end_to_end(tmp_path):
    """평가 스크립트를 가짜 AI로 (비용 0): 준비(반려 → 승인) → 사례 끔/켬 각 1회 → 결과 파일."""
    from scripts.m22_eval import main

    out = main(["--fake", "--repeats", "1", "--note-mode", "specific", "--out", str(tmp_path / "m22")])
    rej = out["prepare"]["decisions"][0]
    assert rej["note"].startswith("matching.area_extension_km는 어느 구간에서도 바꾸지 말 것")
    assert all(r["touched_rejected"] for r in out["rows"])     # 가짜 AI는 같은 안을 다시 낸다
    assert len(list((tmp_path / "m22" / "flows").glob("*.json"))) == 3   # 준비 1 + 비교 2 실행 기록
    # 가짜 AI는 같은 안을 다시 낸다 → 반려 사유와 어긋나는 승인 대신 같은 사유로 반려 (승인 없이 끝날 수 있다)
    acts = [x["action"] for x in out["prepare"]["decisions"]]
    assert acts and set(acts) == {"reject"}
    assert len(out["prepare"]["stored_cases"]) == len(acts)
    assert [r["use_cases"] for r in out["rows"]] == [False, True]
    assert out["rows"][1]["retrieval_options"]["kinds"] == ["case", "opinion", "regulation"]
    assert (tmp_path / "m22" / "summary.md").is_file()


def test_m22_eval_2x2_fake(tmp_path):
    """2×2 모드 (가짜 AI): 조건마다 새 저장소에서 반려 → 모두 반려 → 다시 제안 묶음까지, 실행 기록 저장."""
    from scripts.m22_eval import main

    out = main(["--fake", "--mode", "2x2", "--note-mode", "specific", "--repeats", "1", "--out", str(tmp_path / "x")])
    rows = out["rows"]
    assert [(r["use_memory"], r["use_cases"]) for r in rows] == [(True, True), (True, False), (False, True), (False, False)]
    assert all(r["reproposed"] and r["decisions"][0]["note"].startswith("matching.area_extension_km") for r in rows)
    assert len(list((tmp_path / "x").glob("r1-*/flows/*.json"))) == 4
    assert (tmp_path / "x" / "summary.md").read_text(encoding="utf-8").startswith("# M22 평가 2×2")

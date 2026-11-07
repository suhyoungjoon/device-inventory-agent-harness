"""M22(과거 사례 검색)가 두 번째 도메인(inventory)의 LangGraph 회차 루프에서도 동작하는지 (가짜 AI, 키 없음).

출동 쪽 검사는 tests/test_m22_case_retrieval.py. 여기서는 같은 흐름을 재고 도메인 가짜 AI(tests/inventory_fake.py)로:
사례 검색이 개선 단계에 붙고, 사람 반려가 사례로 남고(핵심 지표만, 정답표 없음), 다음 실행이 그 사례를 검색한다.
"""

import shutil
import time

import pytest

pytest.importorskip("langgraph")

from core.registry import set_domain_files_root  # noqa: E402
from core.retrieval import search_tool  # noqa: E402
from core.storage.store import Store  # noqa: E402
from workflow.agents.api import AgentRuns, AgentsStart  # noqa: E402
from workflow.api import StepRequest  # noqa: E402

METRICS = [{"key": "stockout_rate", "label": "결품률", "format": "pct", "primary": True, "better": "down"}]
NOTE = "안전재고 상한 규정을 먼저 확인할 것"


@pytest.fixture
def env(tmp_path):
    root = tmp_path / "domains"
    shutil.copytree("domains/inventory", root / "inventory")
    set_domain_files_root(root)
    store = Store(tmp_path / "harness.db")
    try:
        yield {"store": store, "runs": lambda: AgentRuns(False, tmp_path / "retrieval.sqlite", store, tmp_path / "flows")}
    finally:
        set_domain_files_root(None)


def start(runs, **kw):
    return runs.start(AgentsStart(domain="inventory", seed=42, faults=["P1", "P2", "P3", "P4"], items=10, level="L3",
                                  metrics=METRICS, pace=0, llm="fake", **kw))


def step(runs, flow_id, action="next", note=""):
    runs.step(flow_id, StepRequest(action=action, note=note))
    deadline = time.time() + 120
    while (snap := runs.snapshot(flow_id))["status"] == "running":
        assert time.time() < deadline
        time.sleep(0.02)
    assert snap["error"] is None, snap["error"]
    return snap


def until_review(runs, snap):
    while snap["waiting"] != "approval" and snap["status"] != "done":
        snap = step(runs, snap["id"])
    return snap


def test_inventory_loop_searches_cases_and_rejection_becomes_case(env):
    runs = env["runs"]()
    snap = until_review(runs, start(runs))
    assert snap["loop"]["retrieval_options"]["kinds"] == ["case", "opinion", "regulation"]
    line = next(x for s in snap["steps"] if s["node"] == "proposal_agent" for x in s["lines"] if x.startswith("검색: "))
    assert "사례 0" in line                                    # 첫 실행: 아직 사례 없음
    title = snap["approval"]["title"]
    snap = step(runs, snap["id"], "reject", NOTE)

    rows = env["store"].loop_cases("inventory")
    assert len(rows) == 1 and rows[0]["status"] == "rejected"
    body = rows[0]["body"]
    assert body["decision"]["note"] == NOTE and body["body"]["title"] == title
    assert set(body["simulation"]["before"]) == {"stockout_rate"}        # 핵심 지표만
    assert "truth" not in str(body) and "faults" not in body
    cid = f"case-{rows[0]['id'][-8:]}"
    assert snap["loop"]["cases_written"] == [cid]
    assert env["store"].loop_cases("dispatch") == []                    # 도메인별로 따로 남는다

    # 다음 실행: 같은 실행 안의 기억은 비어 있고, 사례 검색으로만 이전 반려를 찾는다
    runs2 = env["runs"]()
    snap2 = step(runs2, start(runs2)["id"])                              # prepare
    retrieval = runs2.runs.flows[snap2["id"]]["_ctx"].data["retrieval"]
    chunk = next(c for c in retrieval["index"].chunks(["case"]) if c.id == cid)
    assert chunk.title == f"[반려] {title}" and NOTE in chunk.text
    hits = search_tool(retrieval["index"], retrieval["kinds"])["handler"]({"query": "플래그십 안전재고 반려", "kinds": ["case"]})
    assert cid in [h["ref"] for h in hits["hits"]]


def test_inventory_use_cases_false_drops_case_search(env):
    runs = env["runs"]()
    snap = until_review(runs, start(runs, use_cases=False))
    assert snap["loop"]["retrieval_options"]["kinds"] == ["opinion", "regulation"]

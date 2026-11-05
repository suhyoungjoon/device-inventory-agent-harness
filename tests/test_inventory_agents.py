"""inventory: LangGraph agents 흐름(발주 → 평가 → 분석 → 개선 → 미리 돌려보기 → 사람 승인 → 반영 → 재평가)을
가짜 LLM으로 한 바퀴 돈다. 규칙 파일은 임시 사본에만 반영한다."""

import shutil
import time

import pytest

pytest.importorskip("langgraph")

from fastapi.testclient import TestClient  # noqa: E402

from api.main import create_app  # noqa: E402
from core.registry import DOMAINS_DIR, load_pack, load_params, set_domain_files_root  # noqa: E402
from tests.fake_llm import FakeLLM  # noqa: E402
from tests.inventory_fake import build_policy  # noqa: E402

FAULTS = ["P1", "P2", "P3", "P4"]
METRICS = [{"key": "stockout_rate", "label": "결품률", "format": "pct", "primary": True, "better": "down"},
           {"key": "purchase_amount", "label": "구매 금액", "better": "down"}]
TOP = ["prepare", "dispatch_agent", "evaluate", "rule_full", "analysis_agent", "proposal_agent", "simulate"]


@pytest.fixture
def client(tmp_path):
    work = tmp_path / "domains"
    (work / "inventory").mkdir(parents=True)
    for name in ("params.yaml", "domain-spec.md"):
        shutil.copy(DOMAINS_DIR / "inventory" / name, work / "inventory" / name)
    set_domain_files_root(work)
    pack = load_pack("inventory")
    inst, _ = pack.generate(42, FAULTS)
    policy = build_policy(pack, inst)
    try:
        yield TestClient(create_app(tmp_path / "harness.db", serve_web=False, llm_factory=lambda: FakeLLM(policy)))
    finally:
        set_domain_files_root(None)


def wait(client, flow_id):
    deadline = time.time() + 120
    while (snap := client.get(f"/agents/runs/{flow_id}").json())["status"] == "running":
        assert time.time() < deadline
        time.sleep(0.05)
    assert snap["error"] is None, snap["error"]
    return snap


def step(client, flow_id, action="next", note=""):
    res = client.post(f"/agents/runs/{flow_id}/step", json={"action": action, "note": note})
    assert res.status_code == 200, res.text
    return wait(client, flow_id)


def lines(snap, node):
    return [line for s in snap["steps"] if s["node"] == node for line in s["lines"]]


def test_inventory_flow_runs_all_agents_and_applies_approval(client):
    res = client.post("/agents/runs", json={"domain": "inventory", "seed": 42, "faults": FAULTS, "items": 10,
                                            "level": "L3", "metrics": METRICS, "pace": 0})
    assert res.status_code == 200, res.text
    snap = res.json()
    for node in TOP:
        assert snap["next"] == [node]
        snap = step(client, snap["id"])
    inner = snap["counts"]["dispatch_agent"]
    assert inner["record"] == 10 and inner["retry"] >= 1          # 틀린 첫 제출(MOQ)은 검증 루프로 교정
    assert "규칙 위반 0건" in lines(snap, "evaluate")[1]
    assert "심어둔 문제 4개 중 3개 찾음" in lines(snap, "analysis_agent")[0]
    assert [p["status"] for p in snap["proposals"]][:2] == ["simulated", "invalid"]   # 예산 증액은 governance라 적용 불가
    assert any("결품률" in line and "→" in line for line in lines(snap, "simulate"))
    assert snap["waiting"] == "approval" and snap["approval"]["title"] == "플래그십만 안전재고 2주"

    snap = step(client, snap["id"], "approve")
    snap = step(client, snap["id"])
    assert "v1 → v2" in lines(snap, "apply")[0]
    params = load_params(load_pack("inventory"))                   # 임시 사본
    assert params["version"] == 2 and params["overrides"]["rules"][0]["when"] == {"family": ["flagship"]}
    # 반영 후 재평가 → 종료 판정 (고정 흐름)
    snap = step(client, snap["id"])
    assert snap["steps"][-1]["node"] == "reevaluate"
    assert any("결품률" in line for line in lines(snap, "reevaluate"))
    snap = step(client, snap["id"])
    assert snap["steps"][-1]["node"] == "check_end"


def test_inventory_supervisor_mode_reaches_approval(client):
    res = client.post("/agents/runs", json={"domain": "inventory", "seed": 42, "faults": FAULTS, "items": 10,
                                            "level": "L3", "metrics": METRICS, "pace": 0, "mode": "supervisor"})
    assert res.status_code == 200, res.text
    snap = res.json()
    for _ in range(12):
        if snap.get("waiting") == "approval":
            break
        snap = step(client, snap["id"])
    assert snap.get("waiting") == "approval", [s["node"] for s in snap["steps"]]
    assert snap["approval"]["title"] == "플래그십만 안전재고 2주"

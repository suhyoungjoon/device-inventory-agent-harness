"""inventory 도메인이 코어 API에서 출동과 나란히 도는지: 데이터셋 생성, 규칙 실행, 결정 조회."""

import json

import pytest
from fastapi.testclient import TestClient

from api.main import create_app
from tests.fake_llm import FakeLLM, submit


@pytest.fixture
def client(tmp_path):
    return TestClient(create_app(tmp_path / "harness.db", serve_web=False,
                                 llm_factory=lambda: FakeLLM(lambda item, n, m, t: submit(item, reason="BUDGET_SHORT"))))


def test_both_domains_listed(client):
    names = {d["name"] if isinstance(d, dict) else d for d in client.get("/domains").json()}
    assert {"dispatch", "inventory"} <= names


def test_inventory_rule_run(client):
    ds = client.post("/domains/inventory/datasets", json={"seed": 42}).json()
    body = client.get(f"/domains/inventory/datasets/{ds['id']}").json()
    assert len(body["item_ids"]) == 240
    assert "_hidden_actual" not in json.dumps(body["instance"], ensure_ascii=False)
    run = client.post("/runs", json={"dataset_id": ds["id"], "agent": "rule"}).json()
    assert run["metrics"]["violation_count"] == 0
    assert 0 <= run["metrics"]["stockout_rate"] < 0.05
    decisions = client.get(f"/runs/{run['run_id']}/decisions").json()
    assert len(decisions) == 240


def test_run_view_for_human_screen(client):
    ds = client.post("/domains/inventory/datasets", json={"seed": 42, "faults": ["P2"]}).json()
    body = client.get(f"/domains/inventory/datasets/{ds['id']}").json()
    run = client.post("/runs", json={"dataset_id": ds["id"], "agent": "rule", "scope": body["item_ids"][:10]}).json()
    view = client.get(f"/runs/{run['run_id']}/view").json()
    assert len(view["plan"]) == 10 and len(view["pairs"]) == 10 and len(view["cells"]) == 80   # 서초 × 10모델 × 8주
    row = view["plan"][0]
    assert {"forecast", "on_hand", "on_order", "need", "order", "short", "constraint", "evidence"} <= set(row)
    full = client.post("/runs", json={"dataset_id": ds["id"], "agent": "rule"}).json()
    plan = client.get(f"/runs/{full['run_id']}/view").json()["plan"]
    assert any(r["constraint"] == "제조사 공급 한도 초과" for r in plan)      # P2: 제조사 C 공급 한도


def test_run_view_missing_for_dispatch(client):
    ds = client.post("/domains/dispatch/datasets", json={"seed": 1}).json()
    run = client.post("/runs", json={"dataset_id": ds["id"], "agent": "rule"}).json()
    assert client.get(f"/runs/{run['run_id']}/view").status_code == 404

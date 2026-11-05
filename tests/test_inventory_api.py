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

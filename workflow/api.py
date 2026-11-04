"""워크플로우 API (M9): LangGraph 그래프를 한 단계씩 실행하고 상태를 화면에 내준다.

LangGraph는 선택 설치(pip install -e ".[workflow]")다. 없으면 /workflow/graph가 이유를 돌려주고
나머지 API·화면은 그대로 동작한다. 노드는 같은 앱의 API를 프로세스 안에서 부른다 (네트워크 없음).
"""

from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


class StartRequest(BaseModel):
    domain: str
    seed: int = 42
    faults: list[str] = Field(default_factory=list)
    items: int = Field(default=10, ge=1, le=100)  # 처리 순서 앞 N건 (AI 비용 때문에 일부만, 화면도 1~100)
    level: str = "L3"
    metrics: list[dict] = Field(default_factory=list)   # 도메인 어댑터의 지표 정의 (요약 문장·좋아짐 판정)


class StepRequest(BaseModel):
    action: Literal["next", "approve", "reject", "opinion", "confirm"] = "next"
    # opinion: 의견 한 줄(note) → 제약 (agents 탭, M15-B). confirm: 정리된 제약 확정 (constraints를 주면 고친 제약으로)
    note: str = ""
    constraints: list[dict] | None = None


def _unavailable() -> str | None:
    try:
        import httpx  # noqa: F401  (노드가 같은 앱 API를 부를 때 TestClient가 쓴다)
        import langgraph  # noqa: F401
    except ImportError as exc:
        return f'LangGraph가 설치되어 있지 않음: pip install -e ".[workflow]" ({exc.name})'
    return None


class Flows:
    """M9 워크플로우 실행 (그래프 하나를 모든 실행이 같이 쓴다)."""

    def __init__(self, app: FastAPI):
        from fastapi.testclient import TestClient
        from langgraph.types import Command

        from .graph import Api, build
        from .runs import GraphRuns

        client = TestClient(app)

        def call(method: str, path: str, body: dict | None = None):
            res = client.request(method, path, json=body)
            if res.status_code >= 400:
                detail = res.json().get("detail") if res.headers.get("content-type", "").startswith(
                    "application/json") else res.text
                raise RuntimeError(f"{method} {path} → {res.status_code}: {detail}")
            return res.json()

        self.api = Api(lambda p: call("GET", p), lambda p, b: call("POST", p, b))
        self.graph = build(self.api)
        self.runs = GraphRuns(Command)

    def progress(self, flow_id: str) -> dict | None:
        """AI 방식 실행 단계가 도는 중이면 몇 건째인지 (없으면 None)."""
        run_id = self.api.live.get(flow_id)
        if not run_id:
            return None
        try:
            p = self.api.get(f"/runs/{run_id}").get("progress") or {}
        except RuntimeError:
            return None
        return {"run_id": run_id, "done": p.get("done"), "total": p.get("total")}

    def snapshot(self, flow_id: str) -> dict:
        snap, values = self.runs.base_snapshot(flow_id)
        return {**snap, "steps": values.get("log", []), "progress": self.progress(flow_id),
                "ids": {k: values.get(k) for k in ("dataset_id", "rule_run_id", "ai_run_id", "full_rule_run_id",
                                                    "report_id", "batch_id", "proposal_id") if values.get(k)},
                "inputs": {k: values.get(k) for k in ("domain", "seed", "faults", "items", "level", "scope")}}

    def start(self, req: StartRequest) -> dict:
        return self.snapshot(self.runs.start(self.graph, {**req.model_dump(), "log": []}))

    def step(self, flow_id: str, req: StepRequest) -> dict:
        if req.action in ("opinion", "confirm"):   # 의견 → 제약 순환은 LangGraph agents 탭에만 있다 (docs/langgraph-agents.md)
            raise HTTPException(400, "이 워크플로우는 승인·반려만 받는다 (의견은 LangGraph agents 탭)")
        return self.runs.step(flow_id, req.action, req.note, self.snapshot)


def register(app: FastAPI) -> None:
    flows: list[Flows] = []     # 첫 요청 때 만든다 (LangGraph가 없으면 만들지 않음)

    def get_flows() -> Flows:
        reason = _unavailable()
        if reason:
            raise HTTPException(501, reason)
        if not flows:
            flows.append(Flows(app))
        return flows[0]

    @app.get("/workflow/graph")
    def workflow_graph():
        reason = _unavailable()
        if reason:
            return {"available": False, "reason": reason}
        from .graph import describe

        return {"available": True, **describe(get_flows().graph)}

    @app.post("/workflow/runs")
    def start_workflow(req: StartRequest):
        return get_flows().start(req)

    @app.get("/workflow/runs/{flow_id}")
    def get_workflow(flow_id: str):
        return get_flows().snapshot(flow_id)

    @app.post("/workflow/runs/{flow_id}/step")
    def step_workflow(flow_id: str, req: StepRequest):
        return get_flows().step(flow_id, req)

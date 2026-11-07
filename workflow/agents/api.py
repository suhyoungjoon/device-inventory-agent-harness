"""LangGraph agents API (M10).

- GET  /agents/graph?level=L3      상위 그래프 + 에이전트 하위 그래프 (레벨에 따라 배정 에이전트 모양이 바뀐다)
                                    &mode=supervisor 이면 분석·개선 구간이 Supervisor 노드 하나 (M18)
                                    &domain=dispatch&perspectives=true 이면 분석 에이전트를 관점별 병렬 → 합치기로
- POST /agents/runs                 첫 단계 앞에서 멈춘 새 실행
- GET  /agents/runs/{id}?after=N    상태 + 에이전트 내부 진행 기록 (N번 이후)
- POST /agents/runs/{id}/step       다음 단계(에이전트 하나) 실행 / 사람 승인
- POST /agents/runs/{id}/save       실행 기록을 파일로 저장 (M20, <DB 폴더>/agents_flows/<id>.json, DB에는 넣지 않음)
- GET  /agents/records              저장한 기록 목록 (시연 모드는 번들의 기록 포함)
- GET  /agents/records/{id}         기록 하나 (화면이 타임라인·그래프 진행을 재생, AI 호출 없음)

AI는 기존 LLM 클라이언트를 쓴다: claude = 실제 API (비용), fake = 리허설용 가짜 AI (네트워크·키 없음).
시연 모드(--demo)에서는 항상 가짜 AI다. 결과는 이 탭에만 있다 (DB에 저장하지 않음, 승인 반영만 규칙 파일에).
"""

import json
import re
import time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from ..api import StepRequest, _unavailable


class AgentsStart(BaseModel):
    domain: str
    seed: int = 42
    faults: list[str] = Field(default_factory=list)
    items: int = Field(default=10, ge=1, le=100)    # 배정 에이전트가 처리할 앞 N건 (AI 비용·시간 때문, 화면도 1~100)
    level: str = "L3"
    metrics: list[dict] = Field(default_factory=list)
    llm: Literal["fake", "claude"] = "fake"
    perspectives: bool = False     # 분석 에이전트를 관점별로 나눠 병렬 실행 (M12-b)
    pace: float = Field(default=0.2, ge=0, le=2)     # 내부 단계 사이 간격 (초)
    use_knowledge: bool = True    # 개선 제안·의견 정리 에이전트에 문서 검색 도구 (M15-C). RAG 비교 실험은 false
    use_cases: bool = True        # 문서 검색에 과거 사례(이전 실행·개선 탭의 승인·반려)를 포함 (M22). use_knowledge가 false면 함께 꺼짐
    use_memory: bool = True       # 같은 실행 안의 반려·의견을 개선 제안 입력에 넣는다 (M22 실험용, 꺼도 화면 기록은 남는다)
    end_check: Literal["fixed", "supervisor"] | None = None   # 종료 판정 (M15-D). 없으면 configs/workflow.yaml
    use_saved_constraints: bool = True   # 이전에 확정해 저장한 제약을 불러와 처음부터 쓴다 (M15 후속)
    mode: Literal["fixed", "supervisor"] = "fixed"   # M18: supervisor면 분석·개선 구간을 Supervisor가 지휘 (기본 꺼짐)


def _fake_llm_factory(ctx):
    """리허설 번들과 같은 가짜 AI (scripts/rehearsal_bundle.py의 정책). 레포에서 실행할 때만 쓸 수 있다.
    수치는 AI 성능과 무관하다 (흐름 확인용)."""
    from scripts.rehearsal_bundle import build_policy
    from tests.fake_llm import FakeLLM, tool_use

    def policy(base):
        # 조회 도구가 있는 레벨이면 결정 전에 후보 조회를 한 번 한다 (화면에서 "조회 도구" 노드가 보이게)
        def wrapped(item, n, messages, tools):
            names = {t["name"] for t in tools}
            if "find_candidates" in names and "submit_decision" in names:
                if n == 0:
                    return tool_use("find_candidates", {"order_id": item, "stage": 1})
                return base(item, n - 1, messages, tools)
            return base(item, n, messages, tools)
        return wrapped

    def make(role=None):
        if "fake_policy" not in ctx.data:
            ctx.data["fake_policy"] = policy(build_policy(ctx.data["pack"], ctx.data["instance"]))
        return FakeLLM(ctx.data["fake_policy"])

    return make


def _perspectives(domain: str) -> list[dict]:
    from core.registry import load_pack, load_perspectives

    try:
        return load_perspectives(load_pack(domain))
    except KeyError:
        raise HTTPException(404, f"unknown domain: {domain}")


RECORD_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class AgentRuns:
    def __init__(self, demo: bool, retrieval_path=None, store=None, records_dir=None):
        from langgraph.types import Command

        from ..runs import GraphRuns

        self.demo = demo
        self.retrieval_path = retrieval_path    # 검색 색인 (M15-C). 현장 의견이 쌓여 다음 실행에서도 찾을 수 있다
        self.store = store                      # 확정한 제약을 저장하고 다음 실행이 불러온다 (M15 후속)
        self.runs = GraphRuns(Command)
        self.records_dir = Path(records_dir) if records_dir else None   # 실행 기록 파일 (M20)

    def start(self, req: AgentsStart) -> dict:
        from core.harness.levels import load_levels
        from core.llm.client import load_config, make_client

        from .context import AgentContext
        from .flow import build_flow

        levels = load_levels()
        if req.level not in levels:
            raise HTTPException(400, f"unknown harness level: {req.level}")
        if req.perspectives and not _perspectives(req.domain):
            raise HTTPException(400, "이 도메인에는 분석 관점 파일(analysis_perspectives.yaml)이 없음")
        config = load_config()
        ctx = AgentContext(llm_config=config, pace=req.pace)
        kind = "fake" if self.demo else req.llm
        if self.store is not None:
            ctx.data.update(store=self.store, use_saved_constraints=req.use_saved_constraints)
        # M22: 과거 사례 검색·기억 켜고 끄기. 시연 모드는 사람의 결정을 사례로 쓰지 않는다 (저장된 결과 재생)
        ctx.data.update(use_cases=req.use_knowledge and req.use_cases, use_memory=req.use_memory,
                        record_cases=not self.demo)
        if self.retrieval_path is not None and req.use_knowledge:
            from core.llm.embeddings import make_embedder
            from core.retrieval import open_index

            # 가짜 AI(리허설)는 임베딩도 부르지 않는다 (키워드 검색만, 네트워크 없음)
            ctx.data["index"] = open_index(self.retrieval_path, make_embedder if kind == "claude" else None)
        if kind == "fake":
            try:
                ctx.make_llm = _fake_llm_factory(ctx)
            except ImportError as exc:
                raise HTTPException(501, f"가짜 AI를 쓸 수 없음 (레포에서 실행해야 함): {exc}")
        else:
            try:
                clients = {role: make_client(load_config(role=role))
                           for role in (None, "analysis", "proposals", "supervisor")}
            except Exception as exc:  # 자격 증명이 없는 경우 등
                raise HTTPException(503, f"LLM 클라이언트를 만들 수 없음: {exc}")
            ctx.make_llm = lambda role=None: clients[role]
        graph = build_flow(ctx, levels, end_check=req.end_check, mode=req.mode)
        inputs = req.model_dump(exclude={"llm", "pace", "use_knowledge", "end_check", "use_saved_constraints", "mode",
                                          "use_cases", "use_memory"})
        flow_id = self.runs.start(graph, {**inputs, "log": []}, llm=kind, end_check=req.end_check, mode=req.mode,
                                  _ctx=ctx)
        ctx.data["flow_id"] = flow_id          # 사례 기록에 남긴다 (어느 실행에서 내린 결정인지)
        return self.snapshot(flow_id)

    def snapshot(self, flow_id: str, after: int = -1) -> dict:
        snap, values = self.runs.base_snapshot(flow_id)
        ctx = self.runs.flows[flow_id]["_ctx"]
        proposals = [{"title": p["body"].get("title"), "kind": p["body"].get("kind"), "status": p["status"],
                      "errors": p["errors"], "rank": p.get("rank"),
                      "minimal_change": (p.get("simulation") or {}).get("minimal_change")}
                     for p in ctx.data.get("proposals", [])]
        d = ctx.data
        loop = {"round": values.get("round"), "rounds": d.get("rounds") or [], "constraints": d.get("constraints") or [],
                "stop_reason": values.get("stop_reason"), "report": d.get("final_report"),
                "decisions": d.get("round_decisions") or [], "retrieval": d.get("retrieval_meta"),
                # M22: 검색한 종류·기억 사용 여부(재현 조건), 이 실행이 남긴 사례 id
                "retrieval_options": {"kinds": sorted((d.get("retrieval") or {}).get("kinds") or []),
                                      "use_memory": d.get("use_memory", True)},
                "cases_written": d.get("cases_written") or [],
                "pending_constraints": d.get("pending_constraints") or [],
                "saved_loaded": d.get("saved_loaded") or [], "saved_skipped": d.get("saved_skipped") or [],
                "judgment": d.get("judgment")}    # M18 Supervisor 판단 보고서 (마지막 호출)
        last = ctx.recent(limit=1)
        return {**snap, "steps": values.get("log", []), "events": ctx.recent(after),
                "counts": ctx.counts(), "last_event": last[0] if last else None, "proposals": proposals, "loop": loop,
                "inputs": {k: values.get(k) for k in ("domain", "seed", "faults", "items", "level", "perspectives")}}

    def step(self, flow_id: str, req: StepRequest) -> dict:
        return self.runs.step(flow_id, req.action, req.note, self.snapshot,
                              {"constraints": req.constraints} if req.constraints is not None else None)

    # --- 실행 기록 저장·열기 (M20): 메모리에만 있는 실행을 파일로. 서버를 다시 켜도, 시연 모드에서도 다시 연다 ---
    def save(self, flow_id: str) -> dict:
        if self.records_dir is None:
            raise HTTPException(501, "기록 폴더가 없음")
        snap = self.snapshot(flow_id)
        if snap["status"] == "running":
            raise HTTPException(409, "단계가 실행 중이다. 끝나거나 멈춘 뒤 저장한다")
        flow = self.runs.flows[flow_id]
        inputs = snap["inputs"]
        record = {"id": flow_id, "saved_at": time.time(), "status": snap["status"], "llm": snap.get("llm"),
                  # 그래프 모양: /agents/graph를 다시 부를 값 (그림 자체는 저장하지 않는다)
                  "graph": {"level": inputs.get("level"), "perspectives": bool(inputs.get("perspectives")),
                            "end_check": flow.get("end_check"), "mode": flow.get("mode") or "fixed"},
                  **{k: snap[k] for k in ("inputs", "steps", "loop", "proposals")},
                  "events": self.runs.flows[flow_id]["_ctx"].recent(limit=None)}
        self.records_dir.mkdir(parents=True, exist_ok=True)
        (self.records_dir / f"{flow_id}.json").write_text(json.dumps(record, ensure_ascii=False, default=str),
                                                          encoding="utf-8")
        return {"id": flow_id, "steps": len(record["steps"])}

    def records(self) -> list[dict]:
        if self.records_dir is None or not self.records_dir.is_dir():
            return []
        out = []
        for path in self.records_dir.glob("*.json"):
            try:
                r = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            steps = r.get("steps") or []
            cost = [s["cost_usd"] for s in steps if s.get("cost_usd") is not None]
            out.append({"id": r.get("id", path.stem), "saved_at": r.get("saved_at"), "status": r.get("status"),
                        "llm": r.get("llm"), "mode": (r.get("graph") or {}).get("mode"), "steps": len(steps),
                        "rounds": max((s.get("round") or 1 for s in steps), default=0),
                        "cost_usd": round(sum(cost), 4) if cost else None})
        return sorted(out, key=lambda r: r["saved_at"] or 0, reverse=True)

    def record(self, record_id: str) -> dict:
        if not RECORD_ID.match(record_id) or self.records_dir is None:
            raise HTTPException(404, f"unknown record: {record_id}")
        path = self.records_dir / f"{record_id}.json"
        if not path.is_file():
            raise HTTPException(404, f"unknown record: {record_id}")
        return json.loads(path.read_text(encoding="utf-8"))


def register(app: FastAPI, demo: bool = False, retrieval_path=None, store=None, records_dir=None) -> None:
    holder: list[AgentRuns] = []

    def get_runs() -> AgentRuns:
        reason = _unavailable()
        if reason:
            raise HTTPException(501, reason)
        if not holder:
            holder.append(AgentRuns(demo, retrieval_path, store, records_dir))
        return holder[0]

    @app.get("/agents/graph")
    def agents_graph(level: str = "L3", domain: str | None = None, perspectives: bool = False,
                     end_check: Literal["fixed", "supervisor"] | None = None,
                     mode: Literal["fixed", "supervisor"] = "fixed"):
        reason = _unavailable()
        if reason:
            return {"available": False, "reason": reason}
        from core.harness.levels import load_levels

        from .flow import describe_all

        levels = load_levels()
        if level not in levels:
            raise HTTPException(400, f"unknown harness level: {level}")
        ps = _perspectives(domain) if perspectives and domain else None
        return {"available": True, "demo": demo, "level": level, "perspectives": bool(ps),
                **describe_all(levels, level, ps, end_check, mode)}

    @app.post("/agents/runs")
    def start_agents(req: AgentsStart):
        return get_runs().start(req)

    @app.get("/agents/runs/{flow_id}")
    def get_agents(flow_id: str, after: int = -1):
        return get_runs().snapshot(flow_id, after)

    @app.post("/agents/runs/{flow_id}/step")
    def step_agents(flow_id: str, req: StepRequest):
        return get_runs().step(flow_id, req)

    @app.post("/agents/runs/{flow_id}/save")
    def save_agents(flow_id: str):
        return get_runs().save(flow_id)

    @app.get("/agents/records")
    def list_records():
        return get_runs().records()

    @app.get("/agents/records/{record_id}")
    def get_record(record_id: str):
        return get_runs().record(record_id)

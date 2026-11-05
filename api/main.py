"""FastAPI 백엔드. 모든 경로는 도메인 이름을 받아 도메인 무관하게 동작한다.

실행: python -m api.main  (web/dist가 있으면 프런트엔드도 함께 서빙)
"""

import inspect
import json
import os
import threading
import time
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from core.evaluation.compare import compare
from core.evaluation.runner import create_ai_run, run_ai_agent, run_rule_agent
from core.harness.levels import load_levels
from core.harness.runner import CORE_REASON_CODES
from core.improvement.changes import spec_sections
from core.interfaces import DecisionRecord
from core.llm.client import LLMClient, load_config, make_client
from core.llm.events import LiveLog
from core.registry import list_domains, list_faults, load_faults, load_pack, load_params, set_domain_files_root
from core.storage.store import Store, to_jsonable

from workflow.agents.api import register as register_agents
from workflow.api import register as register_workflow

from . import improvement
from .agent_tab import register as register_agent_tab
from .replay import REPLAY_SECONDS, DemoBundle, ReplayClock

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "runs" / "harness.db"
WEB_DIST = ROOT / "web" / "dist"


class DatasetRequest(BaseModel):
    seed: int
    faults: list[str] = Field(default_factory=list)


class RunRequest(BaseModel):
    dataset_id: str
    agent: Literal["rule", "ai"] = "rule"
    level: str | None = None
    repeats: int = Field(default=1, ge=1, le=10)
    scope: list[str] | None = None      # 실행할 항목 ID (없으면 전체)
    group_id: str | None = None         # 같은 실험으로 묶을 때
    cached: bool = False                # AI: 같은 조건의 저장된 실행을 재생 (시연 모드에서는 항상)


class Progress:
    """백그라운드 AI run의 진행 상황 (메모리, 프로세스 재시작 시 사라짐)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._state: dict[str, dict] = {}

    def set(self, run_id: str, **fields) -> None:
        with self._lock:
            self._state[run_id] = {**self._state.get(run_id, {}), **fields}

    def get(self, run_id: str) -> dict | None:
        with self._lock:
            return dict(self._state[run_id]) if run_id in self._state else None


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)          # 시연 모드 작업 복사본 등 레포 밖


def _no_llm_in_demo(role=None):
    raise RuntimeError("시연 모드에서는 LLM을 호출하지 않는다 (저장된 결과만 재생)")


def accepts_role(factory: Callable) -> bool:
    """llm_factory가 역할 인자를 받는지 (테스트의 인자 없는 팩토리도 그대로 쓰기 위해)."""
    try:
        return len(inspect.signature(factory).parameters) > 0
    except (TypeError, ValueError):
        return False


class CacheToggle(BaseModel):
    enabled: bool


def create_app(db_path: str | Path | None = None, serve_web: bool = True,
               llm_factory: Callable[..., LLMClient] | None = None,
               demo_bundle: str | Path | None = None, demo_work_root: str | Path | None = None,
               replay_seconds: float = REPLAY_SECONDS) -> FastAPI:
    """demo_bundle을 주면 시연 모드: 번들의 작업 복사본을 쓰고, LLM은 만들지 않고, AI 결과는 재생만 한다."""
    demo = DemoBundle(demo_bundle, demo_work_root or ROOT / "runs") if demo_bundle else None
    if demo:
        set_domain_files_root(demo.domain_root)
        store = Store(demo.db_path)
        make_llm = _no_llm_in_demo
    else:
        store = Store(db_path or os.environ.get("HARNESS_DB", DEFAULT_DB))
    llm_config = load_config()
    if not demo:
        # role: None(배정), "analysis", "proposals" — configs/llm.yaml의 roles로 역할별 모델
        if llm_factory is None:
            make_llm = lambda role=None: make_client(load_config(role=role))  # noqa: E731
        elif accepts_role(llm_factory):
            make_llm = llm_factory
        else:
            make_llm = lambda role=None: llm_factory()  # noqa: E731
    executor = ThreadPoolExecutor(max_workers=llm_config.get("concurrency", 4))
    progress = Progress()
    live = LiveLog()      # 실행 중 타임라인 (M16 에이전트 탭)
    replay = ReplayClock(replay_seconds)
    app = FastAPI(title="optimization-agent-harness")

    def view(run: dict) -> dict:
        """재생 중인 실행은 진행률이 끝날 때까지 running으로 보인다."""
        state = replay.state(run["run_id"])
        if state is None:
            return {**run, "progress": progress.get(run["run_id"])}
        return {**run, "status": run["status"] if state["finished"] else "running", "progress": state,
                "replayed": True}

    def pack_or_404(domain: str):
        try:
            return load_pack(domain)
        except KeyError:
            raise HTTPException(404, f"unknown domain: {domain}")

    def run_or_404(run_id: str) -> dict:
        run = store.get_run(run_id)
        if run is None:
            raise HTTPException(404, f"unknown run: {run_id}")
        return run

    @app.get("/domains")
    def domains():
        return [{"name": name, "dimensions": load_pack(name).dimensions(), "faults": list_faults(load_pack(name)),
                 "core_reason_codes": CORE_REASON_CODES} for name in list_domains()]

    @app.get("/harness/levels")
    def levels():
        return {"levels": {name: to_jsonable(level) for name, level in load_levels().items()},
                "llm": {**{k: llm_config.get(k) for k in ("provider", "model", "thinking", "effort", "cache", "concurrency",
                                                            "max_llm_calls_per_item")},
                        "roles": {role: {k: cfg.get(k) for k in ("model", "thinking", "effort")}
                                  for role in (llm_config.get("roles") or {}) for cfg in [load_config(role=role)]}},
                "demo": demo.manifest if demo else None,
                "cache": bool(load_config().get("cache"))}   # 지금 값 (서버에서 켜고 끌 수 있다)

    # --- AI 응답 캐시 켜고 끄기 (서버 전체, 다음 실행부터) ---
    # 클라이언트는 실행할 때마다 load_config로 만들고, load_config는 환경변수 LLM_CACHE를 먼저 본다.
    def cache_state() -> dict:
        return {"enabled": bool(load_config().get("cache")), "demo": bool(demo),
                "source": "이 서버에서 바꿈 (LLM_CACHE)" if "LLM_CACHE" in os.environ else "configs/llm.yaml"}

    @app.get("/llm/cache")
    def get_llm_cache():
        return cache_state()

    @app.post("/llm/cache")
    def set_llm_cache(req: CacheToggle):
        if demo:
            raise HTTPException(400, "저장된 결과 보기에서는 AI를 부르지 않아 캐시 설정이 필요 없음")
        os.environ["LLM_CACHE"] = "1" if req.enabled else "0"
        return cache_state()

    @app.get("/demo")
    def demo_info():
        if not demo:
            return {"demo": False}
        return {"demo": True, "manifest": demo.manifest, "work_dir": str(demo.work), "catalog": demo.catalog(store)}

    @app.post("/domains/{domain}/datasets")
    def create_dataset(domain: str, req: DatasetRequest):
        pack = pack_or_404(domain)
        try:
            instance, _truth = pack.generate(req.seed, req.faults)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return store.save_dataset(domain, req.seed, req.faults, len(pack.items(instance)))

    @app.get("/domains/{domain}/datasets/{dataset_id}")
    def get_dataset(domain: str, dataset_id: str):
        pack = pack_or_404(domain)
        dataset = store.get_dataset(dataset_id)
        if dataset is None or dataset["domain"] != domain:
            raise HTTPException(404, f"unknown dataset: {dataset_id}")
        instance, _truth = pack.generate(dataset["seed"], dataset["faults"])  # 정답표는 노출하지 않는다
        return {**dataset, "instance": to_jsonable(instance), "item_ids": pack.items(instance)}

    @app.get("/domains/{domain}/params")
    def get_params(domain: str):
        """현재 규칙 파라미터와 도메인 명세 섹션 (개선안 diff 표시용)."""
        pack = pack_or_404(domain)
        spec = Path(pack.spec_path()).read_text(encoding="utf-8")
        return {"params": load_params(pack), "spec_sections": spec_sections(spec)}

    @app.get("/domains/{domain}/definition")
    def get_definition(domain: str, answers: bool = False):
        """도메인 탭용: 규칙 파라미터(허용 범위·설명), 명세, 차원·사유코드·필수조건, 결함 패턴.
        결함의 주입 방식(generation)과 정답(answer)은 answers=true일 때만 넣는다: 주입 방식만 봐도
        정답을 알 수 있으므로, 분석 장면 전에 노출되지 않게 기본은 이름과 기대 현상만."""
        pack = pack_or_404(domain)
        spec = Path(pack.spec_path()).read_text(encoding="utf-8")
        faults = [{"id": fid, "name": f.get("name", fid), "expected": f.get("expected"),
                   **({"generation": f.get("generation"), "answer": f.get("answer")} if answers else {})}
                  for fid, f in load_faults(pack).items()]
        # 도구 목록(이름·설명)은 인스턴스에 따라 바뀌지 않으므로 기본 인스턴스(seed 0, 결함 없음)로 만든다
        base, _truth = pack.generate(0, [])
        tools = [{"name": t["name"], "description": t.get("description", "")} for t in pack.tools(base)]
        return {"domain": domain, "params": load_params(pack), "spec_sections": spec_sections(spec),
                "tools": tools,
                "dimensions": pack.dimensions(), "core_reason_codes": CORE_REASON_CODES, "faults": faults,
                "files": {name: _rel(Path(pack.params_path()).parent / name)
                          for name in ("params.yaml", "domain-spec.md", "dimensions.yaml", "faults.yaml")}}

    @app.post("/runs")
    def create_run(req: RunRequest):
        dataset = store.get_dataset(req.dataset_id)
        if dataset is None:
            raise HTTPException(404, f"unknown dataset: {req.dataset_id}")
        pack = pack_or_404(dataset["domain"])
        if req.scope is not None:
            instance, _ = pack.generate(dataset["seed"], dataset["faults"])
            unknown = set(req.scope) - set(pack.items(instance))
            if unknown or not req.scope:
                raise HTTPException(400, f"scope가 비었거나 알 수 없는 항목이 있음: {sorted(unknown)[:5]}")
        if req.agent == "rule":
            run_id = run_rule_agent(store, pack, dataset, load_params(pack), scope=req.scope,
                                    group_id=req.group_id)
            return store.get_run(run_id)

        if req.level not in load_levels():
            raise HTTPException(400, f"unknown harness level: {req.level}")
        if demo or req.cached:
            stored = store.done_runs(dataset["id"], "ai", req.level, req.scope)
            if not stored:
                raise HTTPException(404, f"저장된 AI 실행이 없음: {dataset['id']} · {req.level} · "
                                         f"{'전체' if req.scope is None else f'{len(req.scope)}건'} 범위"
                                         + (" (시연 모드: 번들에 저장된 조건으로만 실행할 수 있음)" if demo else ""))
            runs = stored[:req.repeats]
            for run in runs:
                replay.start(run["run_id"], (run.get("meta") or {}).get("items") or len(req.scope or []))
            return JSONResponse(status_code=202, content={"group_id": runs[0].get("group_id"), "replayed": True,
                                                          "runs": [view(r) for r in runs]})
        try:
            llm = make_llm()
        except Exception as exc:  # 자격 증명이 없는 경우 등
            raise HTTPException(503, f"LLM 클라이언트를 만들 수 없음: {exc}")
        group_id = req.group_id or uuid.uuid4().hex[:8]
        total = len(req.scope) if req.scope is not None else dataset["items"]
        run_ids = []
        for repeat in range(req.repeats):
            run_id = create_ai_run(store, pack, dataset, req.level, llm, req.scope, repeat, group_id)
            progress.set(run_id, done=0, total=total, state="queued")
            executor.submit(_background, run_id, pack, dataset, req, llm, repeat, group_id)
            run_ids.append(run_id)
        return JSONResponse(status_code=202,
                            content={"group_id": group_id, "runs": [store.get_run(r) for r in run_ids]})

    def _background(run_id, pack, dataset, req, llm, repeat, group_id):
        progress.set(run_id, state="running")
        try:
            run_ai_agent(store, pack, dataset, req.level, llm, llm_config, scope=req.scope, repeat=repeat,
                         group_id=group_id, run_id=run_id,
                         progress=lambda done, total: progress.set(run_id, done=done, total=total),
                         on_event=live.sink(f"dispatch:{run_id}"))
            progress.set(run_id, state="done")
        except Exception as exc:  # run 레코드에는 run_ai_agent가 오류를 남긴다
            progress.set(run_id, state="error", error=repr(exc))

    @app.get("/runs")
    def list_runs(group_id: str | None = None, dataset_id: str | None = None):
        return store.list_runs(group_id=group_id, dataset_id=dataset_id)

    @app.get("/runs/{run_id}")
    def get_run(run_id: str):
        return view(run_or_404(run_id))

    @app.get("/runs/{run_id}/decisions")
    def get_decisions(run_id: str):
        run_or_404(run_id)
        return store.get_decisions(run_id)

    @app.get("/runs/{run_id}/view")
    def get_run_view(run_id: str):
        """결과 화면용 도메인 데이터 (선택, M21): 팩에 result_view(instance, decisions)가 있을 때만.
        사람이 보는 화면 전용이다 (재고 도메인: 실제 수요·재고 흐름·발주 권고표). AI 입력에는 쓰지 않는다."""
        run = run_or_404(run_id)
        params = run.get("params")
        pack = load_pack(run["domain"], json.loads(params) if isinstance(params, str) else params)
        if not hasattr(pack, "result_view"):
            raise HTTPException(404, f"{run['domain']} 도메인은 결과 화면 데이터를 제공하지 않음")
        dataset = store.get_dataset(run["dataset_id"])
        instance, _truth = pack.generate(dataset["seed"], dataset["faults"])
        scope = run.get("scope")
        scope = json.loads(scope) if isinstance(scope, str) else scope
        if scope:
            instance = pack.subset(instance, scope)
        decisions = [DecisionRecord(**{k: d[k] for k in ("item_id", "decision", "status", "reason_code", "evidence",
                                                          "dims", "metrics") if k in d})
                     for d in store.get_decisions(run_id)]
        return pack.result_view(instance, decisions)

    @app.get("/runs/{run_id}/traces/{item_id}")
    def get_traces(run_id: str, item_id: str):
        run_or_404(run_id)
        return store.get_traces(run_id, item_id)

    @app.get("/runs/{run_id}/stream")
    def stream(run_id: str, interval: float = 0.5):
        """진행 상황 SSE. run이 끝나면(done/error) 마지막 이벤트를 보내고 닫는다."""
        run_or_404(run_id)

        def events():
            last = None
            while True:
                run = view(store.get_run(run_id))
                state = {"run_id": run_id, "status": run["status"], **(run.get("progress") or {})}
                state.pop("finished", None)
                if state != last:
                    yield f"data: {json.dumps(state, ensure_ascii=False)}\n\n"
                    last = state
                if run["status"] in ("done", "error"):
                    return
                time.sleep(interval)

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/compare")
    def compare_runs(runs: str):
        run_ids = [r for r in runs.split(",") if r]
        if not run_ids:
            raise HTTPException(400, "runs 파라미터가 비어 있음")
        return compare(store, run_ids)

    improvement_ctx = improvement.Context(store, executor, make_llm, llm_config, replay=bool(demo),
                                          retrieval_path=store.path.parent / "retrieval.sqlite", live=live)
    improvement.register(app, improvement_ctx)
    register_agent_tab(app, improvement_ctx, demo=bool(demo))   # M16: 에이전트별 단독 실행과 타임라인
    register_workflow(app)   # LangGraph가 없으면 /workflow/graph가 이유만 돌려준다
    register_agents(app, demo=bool(demo),   # M10: 모든 에이전트를 LangGraph로 (시연 모드는 가짜 AI)
                    retrieval_path=store.path.parent / "retrieval.sqlite",   # M15-C: 규정·현장 의견 검색
                    store=store,   # M15 후속: 확정한 제약 저장·불러오기
                    records_dir=store.path.parent / "agents_flows")   # M20: 실행 기록 (시연 모드는 번들 복사본 안)

    if serve_web and WEB_DIST.is_dir():   # 정적 파일은 모든 API 경로 뒤에 붙인다
        app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="web")
    return app


if __name__ == "__main__":
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(description="API + 빌드된 프런트엔드 서버")
    parser.add_argument("--demo", help="시연 번들 폴더 (저장된 결과만 재생, 네트워크 사용 안 함)")
    args = parser.parse_args()
    uvicorn.run(create_app(demo_bundle=args.demo), host=os.environ.get("HOST", "127.0.0.1"),
                port=int(os.environ.get("PORT", "8000")))

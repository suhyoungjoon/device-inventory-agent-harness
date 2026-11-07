"""분석·개선 API: 분석 리포트(채점 포함), 개선안 생성·시뮬레이션·승인·반려, 개선 이력.

분석 agent에게는 정답표를 주지 않는다. 채점 결과는 사람이 보는 화면에만 나간다.
"""

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from core.analysis.agent import analyze
from core.analysis.perspectives import analyze_perspectives
from core.evaluation.fault_scorer import apply_labels, score
from core.evaluation.runner import create_ai_run, run_ai_agent
from core.harness.levels import load_levels
from core.improvement.approval import write_params, write_spec
from core.improvement.cases import case_records as load_case_records
from core.improvement.changes import apply_params, apply_spec, params_errors
from core.improvement.history import change_card, change_record
from core.improvement.constraints import constraint_errors, constraint_violations
from core.improvement.memory import analysis_memory_text, collect_memory, proposal_memory_text
from core.improvement.opinion_hints import opinion_hints
from core.improvement.proposer import finding_slices, propose
from core.improvement.ranking import load_ranking_config, metric_specs, minimal_change, rank_proposals
from core.improvement.simulate import simulate_params
from core.improvement.sweep import sensitivity, sweep_params
from core.interfaces import DecisionRecord
from core.improvement.ranking import metric_specs as _metric_specs
from core.llm.embeddings import make_embedder
from core.llm.events import LiveLog
from core.registry import knowledge_dir, load_pack, load_params, load_perspectives
from core.retrieval import open_index, prepare, retrieval_meta, search_tool
from core.storage.store import Store

from .replay import equivalent_run_ids

SWEEP_CACHE_MAX = 64   # 탐색 결과 캐시 항목 수 상한


class AnalysisRequest(BaseModel):
    run_id: str
    cached: bool = False      # 같은 조건 실행의 저장된 리포트를 재생 (시연 모드에서는 항상)
    use_memory: bool = True   # 이전 회차에서 사람이 내린 판정을 입력에 넣는다 (M12-c). 비교 실험은 false
    use_knowledge: bool = True   # 과거 사례 검색 도구를 붙인다 (M15-C, 사례가 있을 때만). RAG 비교 실험은 false
    perspectives: bool = False   # 관점별 분석 (M12-b): 도메인의 analysis_perspectives.yaml 관점마다 병렬로 돌려 합친다


class LabelRequest(BaseModel):
    finding_id: str
    label: Literal["valid", "false_positive", "cause_ok", "cause_wrong"] | None   # cause_*: 원인 확인 대상 발견


class SweepRequest(BaseModel):
    dataset_id: str
    axes: list[dict]                       # [{path, values}] 1~2개
    metrics: list[str] | None = None       # 없으면 도메인 지표 전부


class ProposalRequest(BaseModel):
    report_id: str
    cached: bool = False
    constraints: list[dict] | None = None   # 사람이 정한 한도 (core.improvement.constraints 형식). 개선안 묶음에 저장
    use_memory: bool = True                 # 이전 회차에서 반려된 개선안과 사유를 입력에 넣는다 (M12-c)
    use_knowledge: bool = True              # 규정·과거 사례 검색 도구를 붙인다 (M15-C). RAG 비교 실험은 false
    use_saved_constraints: bool = True      # 사람이 확정해 저장한 제약을 요청의 제약에 더한다 (M15 후속)


class SimulateRequest(BaseModel):
    level: str = "L3"                 # spec 개선안: AI agent를 돌릴 레벨
    scope: list[str] | None = None    # spec 개선안: 실행 범위 (없으면 분석한 run의 범위)
    confirm: bool = False             # spec 개선안: 비용 확인 후 true로 다시 요청
    cached: bool = False              # spec 개선안: 저장된 시뮬레이션 결과를 재생


class OutcomeRequest(BaseModel):
    profile: str | None = None        # 현실 모델 (lenient | normal | sensitive). 없으면 도메인 설정 기본값


class DecisionRequest(BaseModel):
    note: str = ""
    force: bool = False               # 시뮬레이션 없이 승인 (사유를 note에 남긴다)
    approver: str = ""                # 승인자 이름 (선택, 로그인이 없어 자기 기재. 변경 이력 카드에 보인다)


@dataclass
class Context:
    store: Store
    executor: Any
    make_llm: Any
    llm_config: dict
    replay: bool = False      # 시연 모드: LLM 대신 저장된 결과를 재생
    retrieval_path: Path | None = None   # 검색 색인 파일 (M15-C). 없으면 검색 도구를 붙이지 않는다
    live: LiveLog = field(default_factory=LiveLog)   # 실행 중 타임라인 (M16 에이전트 탭)
    knowledge: Any = None     # (domain, kinds) → 검색 묶음. register가 채운다 (에이전트 탭 의견 정리가 같이 쓴다)


def recorder(live: LiveLog, key: str):
    """실행 중 타임라인: 화면용(live)과 저장용(목록)에 같이 쌓는다. 저장 목록은 끝날 때 기록에 넣는다."""
    sink, kept = live.sink(key), []

    def add(event: dict) -> None:
        kept.append({**event, "seq": len(kept)})
        sink(event)
    return add, kept


def _run_context(store: Store, run_id: str):
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(404, f"unknown run: {run_id}")
    if run["status"] != "done":
        raise HTTPException(400, "끝난 실행만 분석할 수 있음")
    dataset = store.get_dataset(run["dataset_id"])
    pack = load_pack(run["domain"])
    instance, truth = pack.generate(dataset["seed"], dataset["faults"])
    if run.get("scope"):
        instance = pack.subset(instance, run["scope"])
    decisions = [DecisionRecord(**d) for d in store.get_decisions(run_id)]
    return run, dataset, pack, instance, truth, decisions


def _with_labels(report: dict) -> dict:
    labels = report.get("labels") or {}
    s = report.get("score")
    if s is not None:
        s = apply_labels(s, labels)
        unmatched = s.get("unmatched_findings", [])
        s = {**s, "labels": labels,
             "false_positives": sum(labels.get(f) == "false_positive" for f in unmatched),
             "valid_unmatched": sum(labels.get(f) == "valid" for f in unmatched),
             "unlabeled": sum(f not in labels for f in unmatched)}
    return {**report, "score": s}


def estimate_spec_cost(store: Store, level: str, items: int) -> dict:
    """같은 레벨 AI 실행의 건당 비용 평균 × 항목 수 × 2회(개선 전·후)."""
    runs = [r for r in store.list_runs() if r["agent"] == "ai" and r["status"] == "done"
            and (r.get("meta") or {}).get("usage", {}).get("cost_usd") is not None]
    same = [r for r in runs if r["level"] == level] or runs
    per_item = [r["meta"]["usage"]["cost_usd"] / r["meta"]["items"] for r in same if r["meta"].get("items")]
    if not per_item:
        return {"level": level, "items": items, "runs": 2, "estimate_usd": None,
                "note": "이전 AI 실행 기록이 없어 추정할 수 없음"}
    avg = sum(per_item) / len(per_item)
    return {"level": level, "items": items, "runs": 2, "per_item_usd": avg, "estimate_usd": avg * items * 2,
            "based_on_runs": len(per_item)}


def register(app: FastAPI, ctx: Context) -> None:
    store = ctx.store
    sweep_cache: dict[str, dict] = {}     # (데이터셋, params 버전, 축) → 결과. 규칙 엔진이라 다시 계산해도 비용 0
    approve_lock = threading.Lock()
    index_holder: list = []                # 검색 색인 (M15-C, 처음 쓸 때 연다)
    index_lock = threading.Lock()

    # --- 저장된 제약 (M15 후속): 사람이 확정한 제약을 다음 요청이 불러온다 ---
    def usable_saved_constraints(pack, params: dict, metric_names: list[str], given: list[dict]):
        """켜진 저장 제약 중 지금 규칙으로도 형식이 맞고, 요청에 같은 한도가 없는 것. (제약 목록, id 목록)"""
        have = {store.constraint_id(pack.name, c) for c in given}
        out, ids = [], []
        for row in store.list_constraints(pack.name):
            if row["id"] in have or constraint_errors([row["body"]], params, metric_names, pack.dimensions()):
                continue
            out.append(row["body"])
            ids.append(row["id"])
        return out, ids

    @app.get("/constraints")
    def list_saved_constraints(domain: str, all: bool = False):   # noqa: A002 (쿼리 이름)
        """저장된 제약 (켜진 것만, all=true면 꺼진 것도)."""
        return store.list_constraints(domain, active_only=not all)

    @app.post("/constraints/{cid}/{state}")
    def toggle_saved_constraint(cid: str, state: Literal["activate", "deactivate"]):
        if store.get_constraint(cid) is None:
            raise HTTPException(404, f"unknown constraint: {cid}")
        return store.set_constraint_active(cid, state == "activate")

    # --- 문서 검색 (M15-C) ---
    def case_records(domain: str, pack) -> list:
        """과거 사례 조각: 개선 탭 결정 + 회차 루프 결정 (core.improvement.cases, M22에서 루프와 같이 쓰게 옮김)."""
        return load_case_records(store, domain, [m["key"] for m in _metric_specs(pack.dimensions()) if m.get("primary")])

    def knowledge(domain: str, kinds: list[str]) -> dict | None:
        """검색 도구에 넘길 묶음. 색인 파일이나 도메인 문서 선언이 없으면 None."""
        if ctx.retrieval_path is None:
            return None
        pack = load_pack(domain)
        with index_lock:
            if not index_holder:
                index_holder.append(open_index(ctx.retrieval_path, make_embedder))
            return prepare(index_holder[0], knowledge_dir(pack), domain, kinds,
                           {"case": case_records(domain, pack)} if "case" in kinds else None)

    ctx.knowledge = knowledge

    # --- 파라미터 탐색 (M13) ---
    def _sweep_context(dataset_id: str):
        dataset = store.get_dataset(dataset_id)
        if dataset is None:
            raise HTTPException(404, f"unknown dataset: {dataset_id}")
        params = load_params(load_pack(dataset["domain"]))
        pack = load_pack(dataset["domain"], params)
        instance, _truth = pack.generate(dataset["seed"], dataset["faults"])
        return dataset, params, instance, (lambda p: load_pack(dataset["domain"], p))

    def _cached(key: str, compute):
        if key in sweep_cache:
            return {**sweep_cache[key], "cached": True}
        try:
            result = compute()
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        sweep_cache[key] = result
        while len(sweep_cache) > SWEEP_CACHE_MAX:   # 오래된 것부터 버린다 (dict는 넣은 순서)
            sweep_cache.pop(next(iter(sweep_cache)))
        return {**result, "cached": False}

    @app.post("/params/sweep")
    def params_sweep(req: SweepRequest):
        """파라미터를 1~2개 축으로 바꿔 가며 규칙 엔진으로 돌린 점 목록 (AI 비용 0)."""
        dataset, params, instance, factory = _sweep_context(req.dataset_id)
        key = json.dumps(["sweep", req.dataset_id, params.get("version"), req.axes, req.metrics], sort_keys=True)
        out = _cached(key, lambda: sweep_params(factory, instance, params, req.axes, req.metrics))
        return {**out, "dataset_id": req.dataset_id, "params_version": params.get("version")}

    @app.get("/params/sensitivity")
    def params_sensitivity(dataset_id: str):
        """policy 파라미터별 1차원 민감도: 허용 범위를 몇 단계로 돌려 지표가 움직인 폭."""
        dataset, params, instance, factory = _sweep_context(dataset_id)
        key = json.dumps(["sensitivity", dataset_id, params.get("version")])
        out = _cached(key, lambda: sensitivity(factory, instance, params))
        return {**out, "dataset_id": dataset_id, "params_version": params.get("version")}

    # --- 분석 ---
    @app.post("/analysis")
    def create_analysis(req: AnalysisRequest):
        run, *_ = _run_context(store, req.run_id)
        if ctx.replay or req.cached:
            stored = store.latest_report(equivalent_run_ids(store, run))
            if stored is None:
                raise HTTPException(404, "같은 조건의 실행에 대한 저장된 분석 리포트가 없음")
            # 요청한 실행에 붙인 사본을 만든다 (화면이 분석 대상 실행의 결과를 함께 보여주므로).
            # 개선안 재생은 replayed_from으로 원본 리포트의 개선안을 찾는다.
            source = stored["body"].get("replayed_from", stored["id"])
            report_id = store.create_report(req.run_id)
            store.finish_report(report_id, {**stored["body"], "replayed_from": source}, stored["score"])
            return JSONResponse(status_code=202, content={"id": report_id, "status": "done", "replayed": True})
        llm = _llm_or_503(ctx, "analysis")
        perspectives = None
        if req.perspectives:
            perspectives = load_perspectives(load_pack(run["domain"]))
            if not perspectives:
                raise HTTPException(400, "이 도메인에는 분석 관점 파일(analysis_perspectives.yaml)이 없음")
        memory = current_memory(run["domain"]) if req.use_memory else None
        retrieval = knowledge(run["domain"], ["case"]) if req.use_knowledge and not perspectives else None
        if retrieval and not retrieval["index"].chunks(["case"]):
            retrieval = None          # 사례가 아직 없으면 도구를 붙이지 않는다 (입력이 이전과 같다)
        report_id = store.create_report(req.run_id)
        ctx.executor.submit(_analyze_job, report_id, req.run_id, llm, memory, perspectives, retrieval)
        return JSONResponse(status_code=202, content={"id": report_id, "status": "running"})

    def current_memory(domain: str) -> dict:
        """사람이 내린 판단을 지금 규칙 버전 기준으로 모은다. 쓴 기억은 리포트·개선안 묶음에 그대로 남긴다 (재현 조건)."""
        return collect_memory(store, domain, load_params(load_pack(domain)).get("version"))

    @app.get("/memory")
    def get_memory(domain: str):
        """다음 회차 에이전트 입력에 들어갈 기억 (반려 개선안, 발견 판정)."""
        try:
            return current_memory(domain)
        except KeyError:
            raise HTTPException(404, f"unknown domain: {domain}")

    def _analyze_job(report_id: str, run_id: str, llm, memory: dict | None = None, perspectives: list | None = None,
                     retrieval: dict | None = None):
        on_event, timeline = recorder(ctx.live, f"analysis:{report_id}")
        try:
            _run, dataset, pack, instance, truth, decisions = _run_context(store, run_id)
            if perspectives:
                # 관점마다 클라이언트를 따로 만든다 (첫 관점은 요청 때 만든 것). 대화 상태를 나누지 않게
                first = [llm]
                body = analyze_perspectives(pack, instance, decisions,
                                            lambda: first.pop() if first else ctx.make_llm("analysis"),
                                            ctx.llm_config, perspectives, salt=f"analysis:{run_id}",
                                            memory_text=analysis_memory_text(memory), on_event=on_event)
            else:
                extra = [search_tool(retrieval["index"], retrieval["kinds"], record=retrieval["record"])] if retrieval else None
                body = analyze(pack, instance, decisions, llm, ctx.llm_config, salt=f"analysis:{run_id}",
                               memory_text=analysis_memory_text(memory), extra_tools=extra, on_event=on_event)
            body["memory"] = memory
            body["timeline"] = timeline      # 턴 → 도구 → 검사 (M16 에이전트 탭이 다시 볼 때)
            if retrieval:
                body["retrieval"] = retrieval_meta(retrieval["index"], retrieval["record"])
            store.finish_report(report_id, body, score(body["findings"], truth.get("faults", {}), body["calls"]))
        except Exception as exc:
            store.fail_report(report_id, repr(exc))

    @app.get("/analysis/{report_id}")
    def get_analysis(report_id: str):
        report = store.get_report(report_id)
        if report is None:
            raise HTTPException(404, f"unknown report: {report_id}")
        return _with_labels(report)

    @app.post("/analysis/{report_id}/labels")
    def label_finding(report_id: str, req: LabelRequest):
        report = get_analysis(report_id)
        if report["status"] != "done" or req.finding_id not in {f["id"] for f in report["body"]["findings"]}:
            raise HTTPException(400, f"없는 발견: {req.finding_id}")
        store.set_label(report_id, req.finding_id, req.label)
        return get_analysis(report_id)

    # --- 개선안 생성 ---
    @app.post("/proposals")
    def create_proposals(req: ProposalRequest):
        report = get_analysis(req.report_id)
        if report["status"] != "done":
            raise HTTPException(400, "끝난 리포트로만 개선안을 만들 수 있음")
        if ctx.replay or req.cached:
            batch = store.latest_batch((report["body"] or {}).get("replayed_from", req.report_id))
            if batch is None:
                raise HTTPException(404, "이 리포트로 만든 저장된 개선안이 없음")
            return JSONResponse(status_code=202, content={"id": batch["id"], "status": "done", "replayed": True})
        constraints, saved_ids = list(req.constraints or []), []
        if req.constraints or req.use_saved_constraints:
            _run, _dataset, pack, instance, _truth, decisions = _run_context(store, report["run_id"])
            params, metric_names = load_params(pack), sorted(pack.metrics(instance, decisions))
            errors = constraint_errors(constraints, params, metric_names, pack.dimensions())
            if errors:
                raise HTTPException(400, "; ".join(errors))
            if req.use_saved_constraints:
                extra, saved_ids = usable_saved_constraints(pack, params, metric_names, constraints)
                constraints += extra
        llm = _llm_or_503(ctx, "proposals")
        memory = current_memory(store.get_run(report["run_id"])["domain"]) if req.use_memory else None
        domain = store.get_run(report["run_id"])["domain"]
        retrieval = knowledge(domain, ["regulation", "case", "opinion"]) if req.use_knowledge else None
        batch_id = store.create_batch(req.report_id)
        ctx.executor.submit(_propose_job, batch_id, report, llm, constraints or None, memory, retrieval, saved_ids)
        return JSONResponse(status_code=202, content={"id": batch_id, "status": "running"})

    def _propose_job(batch_id: str, report: dict, llm, constraints: list[dict] | None = None,
                     memory: dict | None = None, retrieval: dict | None = None, saved_ids: list[str] | None = None):
        on_event, timeline = recorder(ctx.live, f"proposals:{batch_id}")
        try:
            _run, dataset, pack, instance, _truth, _decisions = _run_context(store, report["run_id"])
            params = load_params(pack)
            spec_text = Path(pack.spec_path()).read_text(encoding="utf-8")
            out = propose(lambda p: load_pack(pack.name, p), instance, params, spec_text, pack.dimensions(),
                          report["body"], llm, ctx.llm_config, salt=f"proposals:{report['id']}",
                          constraints=constraints, memory_text=proposal_memory_text(memory), retrieval=retrieval,
                          on_event=on_event)
            meta = {"usage": out["usage"], "trials": out["trials"], "stop": out["stop"], "failure": out.get("failure"),
                    "params_version": params.get("version"),
                    "calls": out["calls"], "timeline": timeline}   # 도구 호출·타임라인 (M16 에이전트 탭)
            if constraints:
                meta["constraints"] = constraints
            if saved_ids:   # 저장된 제약 중 이 묶음에 쓴 것 (재현 조건)
                meta["saved_constraints"] = saved_ids
            meta["memory"] = memory
            if retrieval:   # 쓴 문서 조각 id·해시, 인용한 id, 검색 방식·임베딩 모델 (재현 조건)
                cited = [str(c) for p in out["proposals"] if isinstance(p["proposal"], dict)
                         and isinstance(p["proposal"].get("cited_docs"), list) for c in p["proposal"]["cited_docs"]]
                meta["retrieval"] = retrieval_meta(retrieval["index"], retrieval["record"], cited)
            store.finish_batch(batch_id, report["id"], out["proposals"], meta)
        except Exception as exc:
            store.fail_batch(batch_id, repr(exc))

    @app.get("/proposals/batches/{batch_id}")
    def get_batch(batch_id: str):
        batch = store.get_batch(batch_id)
        if batch is None:
            raise HTTPException(404, f"unknown batch: {batch_id}")
        return {**batch, "ranking": batch_ranking(batch)}

    def batch_ranking(batch: dict) -> dict | None:
        """제시 기준 (M15-A): 순위·참고·숨김·잘림. 도메인 지표 정의가 없으면 None."""
        report = store.get_report(batch["report_id"]) if batch.get("report_id") else None
        run = store.get_run(report["run_id"]) if report else None
        if run is None:
            return None
        specs = metric_specs(load_pack(run["domain"]).dimensions())
        return rank_proposals(batch.get("proposals") or [], specs, load_ranking_config()) if specs else None

    def batch_constraints(p: dict) -> list[dict]:
        return ((store.get_batch(p["batch_id"]) or {}).get("meta") or {}).get("constraints") or []

    def with_constraint_check(result: dict, constraints: list[dict], candidate_params: dict | None) -> dict:
        """제약이 있으면 시뮬레이션 결과에 위반 목록을 붙인다 (표시만, 승인은 막지 않음)."""
        if constraints:
            result["constraint_violations"] = constraint_violations(constraints, candidate_params or {}, result)
        return result

    def proposal_or_404(proposal_id: str) -> dict:
        p = store.get_proposal(proposal_id)
        if p is None:
            raise HTTPException(404, f"unknown proposal: {proposal_id}")
        return p

    @app.get("/proposals/{proposal_id}")
    def get_proposal(proposal_id: str):
        return proposal_or_404(proposal_id)

    # --- 시뮬레이션 ---
    # --- 계획 vs 실적 (M17): 참고용. DB에 저장하지 않고, AI 입력·순위·검사에 쓰지 않는다 ---
    outcome_cache: dict[str, dict] = {}          # "현재" 기준값 (데이터셋·범위·params 버전·현실 모델·seed)
    outcome_lock = threading.Lock()

    @app.post("/proposals/{proposal_id}/outcome")
    def proposal_outcome(proposal_id: str, req: OutcomeRequest):
        p = proposal_or_404(proposal_id)
        if p["kind"] != "params":
            raise HTTPException(400, "실적 비교는 규칙 설정값 개선안만 (업무 규칙 문서 개선안은 AI 배정 실행이라 대상이 아님)")
        report = store.get_report(p["report_id"])
        run, dataset, pack, instance, _truth, _decisions = _run_context(store, report["run_id"])
        if not hasattr(pack, "outcome"):
            raise HTTPException(404, f"이 도메인({pack.name})에는 실적 기능이 없음")
        params = load_params(pack)
        if errors := params_errors(params, p["body"], pack.dimensions()):
            raise HTTPException(400, "지금 규칙 기준으로 적용할 수 없음: " + "; ".join(errors))
        try:
            key = json.dumps([dataset["id"], run.get("scope"), params.get("version"), req.profile], sort_keys=True)
            with outcome_lock:
                current = outcome_cache.get(key)
            if current is None:
                current = pack.outcome(instance, profile=req.profile)
                with outcome_lock:
                    outcome_cache[key] = current
            started = time.monotonic()
            candidate = load_pack(pack.name, apply_params(params, p["body"])).outcome(instance, profile=req.profile)
        except ValueError as exc:      # 알 수 없는 현실 모델 등
            raise HTTPException(400, str(exc))
        delta = {part: {k: candidate[part][k] - current[part][k] for k in candidate[part]
                        if isinstance(candidate[part][k], (int, float)) and k in current[part]}
                 for part in ("plan", "outcome")}
        return {"proposal_id": proposal_id, "params_version": params.get("version"), "profile": candidate["profile"],
                "seeds": candidate["seeds"], "promise_window_min": candidate["promise_window_min"],
                "current": {"plan": current["plan"], "outcome": current["outcome"]},
                "proposal": {"plan": candidate["plan"], "outcome": candidate["outcome"]}, "delta": delta,
                "seconds": round(time.monotonic() - started, 2),
                "note": "참고용: 가상 고객 반응으로 만든 실적. AI에게 보여 주지 않고 승인 조건·순위·검사에 쓰지 않는다"}

    @app.get("/proposals/{proposal_id}/opinion-hints")
    def proposal_opinion_hints(proposal_id: str):
        """의견 추천 재료 (에이전트 탭 의견 정리): 이 안의 변경값과 미리 돌려본 결과에서 쓸 만한 한도. AI 없음.
        미리 돌려본 적이 없는 설정값 안은 여기서 규칙 엔진으로 한 번 돌려 본다 (저장하지 않음)."""
        p = proposal_or_404(proposal_id)
        if p["kind"] != "params":
            return {"hints": []}
        report = store.get_report(p["report_id"])
        _run, _dataset, pack, instance, _truth, _decisions = _run_context(store, report["run_id"])
        params = load_params(pack)
        sim = p.get("simulation")
        if not sim and not params_errors(params, p["body"], pack.dimensions()):
            sim = simulate_params(lambda q: load_pack(pack.name, q), instance, params, apply_params(params, p["body"]))
        return {"hints": opinion_hints(params, p["body"], sim, pack.dimensions())}

    @app.post("/proposals/{proposal_id}/simulate")
    def simulate(proposal_id: str, req: SimulateRequest):
        p = proposal_or_404(proposal_id)
        if p["status"] not in ("proposed", "simulated"):
            raise HTTPException(400, f"시뮬레이션할 수 없는 상태: {p['status']}")
        report = store.get_report(p["report_id"])
        run, dataset, pack, instance, _truth, _decisions = _run_context(store, report["run_id"])
        if p["kind"] == "params":
            params = load_params(pack)
            # 저장된 개선안도 지금 규칙으로 다시 검사한다 (분류 도입 전에 만든 안, 다른 안이 먼저 반영된 경우)
            if errors := params_errors(params, p["body"], pack.dimensions()):
                raise HTTPException(400, "지금 규칙 기준으로 적용할 수 없음: " + "; ".join(errors))
            candidate = apply_params(params, p["body"])
            result = simulate_params(lambda q: load_pack(pack.name, q), instance, params,
                                     candidate, finding_slices(report["body"]))
            result["params_version"] = params.get("version")
            with_constraint_check(result, batch_constraints(p), candidate)
            primary = [m["key"] for m in metric_specs(pack.dimensions()) if m.get("primary")]
            result["minimal_change"] = minimal_change(lambda q: load_pack(pack.name, q), instance, params,
                                                      p["body"], result, primary)
            return store.update_proposal(proposal_id, status="simulated", simulation=result)

        # spec: AI agent를 개선 전·후 명세로 한 번씩 실행 (비용 발생 → 확인 필요)
        if req.level not in load_levels():
            raise HTTPException(400, f"unknown harness level: {req.level}")
        scope = req.scope or run.get("scope")
        if not scope:
            raise HTTPException(400, "명세 개선안 시뮬레이션에는 실행 범위(scope)가 필요함 (비용 때문)")
        stored = p.get("simulation") or {}
        if ctx.replay or req.cached:
            if not stored.get("run_ids"):
                raise HTTPException(404, "이 명세 개선안의 저장된 시뮬레이션 결과가 없음")
            if not req.confirm:
                return {"needs_confirmation": True, "estimate": {
                    "level": stored.get("level"), "items": stored.get("items"), "runs": 2,
                    "estimate_usd": stored.get("cost_usd"), "replayed": True,
                    "note": "저장된 결과를 재생합니다 (실제 비용 없음)"}}
            return store.update_proposal(proposal_id, status="simulated", simulation={**stored, "replayed": True})
        estimate = estimate_spec_cost(store, req.level, len(scope))
        if not req.confirm:
            return {"needs_confirmation": True, "estimate": estimate}
        llm = _llm_or_503(ctx)
        store.update_proposal(proposal_id, status="simulating")
        ctx.executor.submit(_simulate_spec_job, proposal_id, p, pack, dataset, req.level, scope, llm)
        return JSONResponse(status_code=202, content={"id": proposal_id, "status": "simulating", "estimate": estimate})

    def _simulate_spec_job(proposal_id, p, pack, dataset, level, scope, llm):
        started = time.time()
        try:
            spec_now = Path(pack.spec_path()).read_text(encoding="utf-8")
            spec_new = apply_spec(spec_now, p["body"])
            runs = {}
            for label, text in (("before", None), ("after", spec_new)):
                run_id = create_ai_run(store, pack, dataset, level, llm, scope, 0, f"spec-{proposal_id}")
                run_ai_agent(store, pack, dataset, level, llm, ctx.llm_config, scope=scope, run_id=run_id,
                             group_id=f"spec-{proposal_id}", spec_text=text)
                runs[label] = store.get_run(run_id)
            cost = sum((r["meta"]["usage"].get("cost_usd") or 0) for r in runs.values())
            result = {"kind": "spec", "level": level, "items": len(scope),
                      "before": runs["before"]["metrics"], "after": runs["after"]["metrics"],
                      "violations_before": len(runs["before"]["violations"] or []),
                      "violations_after": len(runs["after"]["violations"] or []),
                      "run_ids": {k: r["run_id"] for k, r in runs.items()},
                      "cost_usd": cost, "seconds": time.time() - started}
            with_constraint_check(result, batch_constraints(p), None)   # 명세 개선안: 지표 제약만
            store.update_proposal(proposal_id, status="simulated", simulation=result)
        except Exception as exc:
            store.update_proposal(proposal_id, status="proposed",
                                  simulation={"error": repr(exc), "seconds": time.time() - started})

    # --- 승인·반려 ---
    @app.post("/proposals/{proposal_id}/approve")
    def approve(proposal_id: str, req: DecisionRequest):
        p = proposal_or_404(proposal_id)
        if p["status"] != "simulated" and not (req.force and p["status"] == "proposed"):
            raise HTTPException(400, "시뮬레이션을 마친 개선안만 승인할 수 있음 (강제 승인은 force와 사유 필요)")
        if req.force and not req.note.strip():
            raise HTTPException(400, "강제 승인에는 사유(note)가 필요함")
        with approve_lock:   # 승인은 한 번에 하나 (같은 기준 파일에 두 안이 겹쳐 쓰이지 않게)
            p = proposal_or_404(proposal_id)
            if p["status"] in ("approved", "rejected", "stale"):
                raise HTTPException(400, f"이미 결정됨: {p['status']}")
            report = store.get_report(p["report_id"])
            pack = load_pack(store.get_run(report["run_id"])["domain"])
            decision = {"action": "approved", "note": req.note, "forced": req.force, "at": time.time(),
                        "approver": req.approver.strip() or None}
            if p["kind"] == "params":
                params = load_params(pack)
                # 강제 승인도 지금 규칙으로 다시 검사한다 (분류상 바꿀 수 없는 값, 허용 범위)
                if errors := params_errors(params, p["body"], pack.dimensions()):
                    raise HTTPException(400, "지금 규칙 기준으로 적용할 수 없음: " + "; ".join(errors))
                decision.update(change_record(params, p["body"]))   # 바뀌기 전 값 (변경 이력 카드)
                before, after = write_params(pack.params_path(), p["body"])
                decision.update(params_version_before=before, params_version_after=after)
            else:
                write_spec(pack.spec_path(), p["body"])
            store.mark_stale(p["kind"], proposal_id)
            return store.update_proposal(proposal_id, status="approved", decision=decision)

    @app.post("/proposals/{proposal_id}/reject")
    def reject(proposal_id: str, req: DecisionRequest):
        p = proposal_or_404(proposal_id)
        if p["status"] in ("approved", "rejected"):
            raise HTTPException(400, f"이미 결정됨: {p['status']}")
        return store.update_proposal(proposal_id, status="rejected",
                                     decision={"action": "rejected", "note": req.note, "at": time.time()})

    @app.get("/params/history")
    def params_history(domain: str):
        """변경 이력 카드: 승인으로 params 버전이 오를 때마다 하나 (최근 것부터)."""
        cards = []
        for p in store.decided_proposals():
            report = store.get_report(p["report_id"])
            run = store.get_run(report["run_id"]) if report else None
            if not run or run["domain"] != domain:
                continue
            if card := change_card(p, report):
                cards.append(card)
        return sorted(cards, key=lambda c: c["version_after"] or 0, reverse=True)

    # --- 이력 ---
    @app.get("/history")
    def history():
        rows, approved = [], 0
        for p in store.decided_proposals():
            report = store.get_report(p["report_id"])
            batch = store.get_batch(p["batch_id"])
            if p["status"] == "approved":
                approved += 1
            sim = p.get("simulation") or {}
            analysis_usage = (report.get("body") or {}).get("usage", {})
            proposal_usage = (batch.get("meta") or {}).get("usage", {})
            costs = [analysis_usage.get("cost_usd"), proposal_usage.get("cost_usd"), sim.get("cost_usd")]
            rows.append({
                "proposal_id": p["id"], "round": approved if p["status"] == "approved" else None,
                "status": p["status"], "kind": p["kind"], "title": p["body"].get("title"),
                "target_findings": p["body"].get("target_findings"), "decision": p["decision"],
                "before": sim.get("before"), "after": sim.get("after"),
                "cycle": {
                    "analysis_seconds": analysis_usage.get("seconds"),
                    "proposal_seconds": proposal_usage.get("seconds"),
                    "simulation_seconds": sim.get("seconds"),
                    "llm_cost_usd": sum(c for c in costs if c is not None) if any(c is not None for c in costs)
                    else None,
                },
            })
        return rows


def _llm_or_503(ctx: Context, role: str | None = None):
    """role: None(배정), "analysis", "proposals" — configs/llm.yaml roles의 역할별 모델."""
    try:
        return ctx.make_llm(role)
    except Exception as exc:
        raise HTTPException(503, f"LLM 클라이언트를 만들 수 없음: {exc}")

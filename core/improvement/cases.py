"""과거 사례 조각 (M22): 사람이 결정한 개선안 → 검색 조각. 개선 탭과 회차 루프(LangGraph agents)가 같이 쓴다.

재료는 두 곳이다.
- 개선 탭에서 결정한 개선안: DB 개선안(proposals) + 그 리포트의 발견 + 묶음의 규칙 버전
- 회차 루프에서 결정한 개선안: loop_cases (루프는 DB 리포트·묶음을 만들지 않아 따로 둔다)
두 곳을 늘 함께 모아 색인의 사례 모음을 맞춘다 (한쪽만 맞추면 다른 쪽 사례가 지워진다).
사례에 들어가는 것은 바뀐 파라미터, 미리 돌려본 핵심 지표 변화, 사람의 결정과 사유뿐이다 (정답표·가상 실적 없음).
"""

from core.retrieval.index import Chunk
from core.retrieval.records import case_chunk

FINDING_KEYS = ("id", "title", "slice")    # 사례에 남기는 발견 요약 (대상 발견만)


def case_records(store, domain: str, primary: list[str]) -> list[Chunk]:
    """결정된 개선안 → 과거 사례 조각 (기록에서 매번 다시 만든다. 해시가 같으면 색인에 다시 쓰지 않는다).
    primary: 사례 문장에 넣을 핵심 지표 키."""
    out = []
    for p in store.decided_proposals():
        report = store.get_report(p["report_id"])
        run = store.get_run(report["run_id"]) if report else None
        if not run or run["domain"] != domain:
            continue
        meta = (store.get_batch(p["batch_id"]) or {}).get("meta") or {}
        out.append(case_chunk(p, (report.get("body") or {}).get("findings") or [], primary, meta.get("params_version")))
    for row in store.loop_cases(domain):
        b = row["body"]
        out.append(case_chunk({"id": row["id"], "status": row["status"], "body": b.get("body") or {},
                               "simulation": b.get("simulation") or {}, "decision": b.get("decision") or {}},
                              b.get("findings") or [], primary, b.get("params_version")))
    return out


def loop_case(body: dict, simulation: dict | None, action: str, note: str,
              findings: list[dict], primary: list[str], params_version=None, at: float | None = None) -> dict:
    """회차 루프의 사람 결정 하나 → loop_cases에 저장할 본문 (case_records가 다시 조각으로 만든다).
    action: approve | reject | opinion. 미리 돌려본 결과는 핵심 지표 전·후만 남긴다."""
    sim = simulation or {}
    keep = lambda m: {k: m[k] for k in primary if k in (m or {})}   # noqa: E731
    targets = [{k: f.get(k) for k in FINDING_KEYS if f.get(k) is not None}
               for f in findings if f.get("id") in (body.get("target_findings") or [])]
    return {"body": body, "simulation": {"before": keep(sim.get("before")), "after": keep(sim.get("after"))},
            "decision": {"action": action, "note": note, "at": at}, "findings": targets,
            "params_version": params_version}


def case_id(proposal_id: str) -> str:
    """사례 조각 id (case_chunk와 같은 규칙)."""
    return f"case-{str(proposal_id)[-8:]}"

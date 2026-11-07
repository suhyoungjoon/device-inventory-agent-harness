"""에이전트 도구: search_knowledge. 결과마다 짧은 인용 번호(ref = 조각 id)를 붙이고, 인용 검사는 받은 번호만 인정한다.

record(사전)를 넘기면 이 실행에서 돌려준 조각의 id → 해시를 모은다 (재현 메타데이터: retrieval_meta).
"""

import re

from .index import Index

SEARCH = "search_knowledge"
TEXT_LIMIT = 400


def _strip_index(path: str) -> str:
    return re.sub(r"\[\d+\]$", "", path)


def search_tool(index: Index, kinds: dict[str, str], record: dict | None = None, k: int = 5,
                name: str = SEARCH) -> dict:
    """kinds: {문서 종류: 설명} (도메인 선언 중 이 에이전트가 볼 것). 도구 정의 + handler."""

    def handler(args: dict) -> dict:
        query = str(args.get("query") or "").strip()
        if not query:
            return {"error": "query가 필요함"}
        want = [x for x in args.get("kinds") or list(kinds) if x in kinds] or list(kinds)
        filters = {}
        if args.get("params"):
            filters["params"] = [_strip_index(str(p)) for p in args["params"]]
        if isinstance(args.get("dims"), dict) and args["dims"]:
            filters["dims"] = args["dims"]
        hits = index.search(query, k=min(int(args.get("k") or k), 10), kinds=want, filters=filters)
        if record is not None:
            record.update({h["id"]: h["hash"] for h in hits})
        return {"mode": index.mode, "hits": [
            {"ref": h["id"], "kind": h["kind"], "title": h["title"], "text": h["text"][:TEXT_LIMIT],
             "meta": h["meta"]} for h in hits]}

    return {"name": name, "handler": handler,
            "description": "규정·과거 사례·현장 의견 같은 문장 지식을 찾는다 (숫자 집계는 하지 않는다). "
                           "결과의 ref를 cited_docs에 적어 근거로 인용한다. 인용하지 않은 문서는 근거가 아니다. "
                           "종류: " + "; ".join(f"{k}={v}" for k, v in kinds.items()),
            "input_schema": {"type": "object", "required": ["query"], "properties": {
                "query": {"type": "string", "description": "찾을 내용 (문장 또는 키워드)"},
                "kinds": {"type": "array", "items": {"type": "string", "enum": list(kinds)}},
                "params": {"type": "array", "items": {"type": "string"}, "description": "관련 파라미터 경로로 거르기"},
                "dims": {"type": "object", "description": "관련 차원 구간으로 거르기 {차원: [값]}"},
                "k": {"type": "integer", "minimum": 1, "maximum": 10}}}}


def returned_refs(calls: dict, name: str = SEARCH) -> set[str]:
    """도구 호출 기록(calls: tool_use id → {name, output, is_error})에서 검색이 돌려준 ref."""
    return {h["ref"] for c in (calls or {}).values() if c.get("name") == name and not c.get("is_error")
            for h in (c.get("output") or {}).get("hits") or []}


def retrieval_summary(index: Index, record: dict, cited=None) -> dict:
    """한 단계에서 받은 검색 조각 요약 (M22 화면): 종류별 개수, 인용한 ref, 받은 사례 조각(펼쳐 보기용).
    record: 그 단계의 search_tool record (조각 id → 해시)."""
    got = [c for c in index.chunks() if c.id in record]
    counts: dict[str, int] = {}
    for c in got:
        counts[c.kind] = counts.get(c.kind, 0) + 1
    cited = sorted({str(x) for x in cited or []})
    return {"counts": counts, "cited": cited,
            "cases": [{"ref": c.id, "title": c.title, "text": c.text, "cited": c.id in cited}
                      for c in got if c.kind == "case"]}


def citation_errors(cited, calls: dict, where: str = "", name: str = SEARCH) -> list[str]:
    """cited_docs 검사: 검색 결과로 받은 ref만 인용할 수 있다."""
    if cited in (None, []):
        return []
    if not isinstance(cited, list):
        return [f"{where}cited_docs는 목록이어야 함"]
    seen = returned_refs(calls, name)
    bad = [str(c) for c in cited if str(c) not in seen]
    return [f"{where}검색 결과에 없는 문서 조각 인용: {', '.join(bad)}"] if bad else []


def retrieval_meta(index: Index | None, record: dict, cited: list[str] | None = None) -> dict | None:
    """리포트·개선안 묶음에 남길 재현 정보: 쓴 조각 id·해시, 인용한 id, 검색 방식, 임베딩 모델."""
    if index is None:
        return None
    return {"mode": index.mode, "embedding_model": index.embedding_model,
            "chunks": [{"id": i, "hash": h} for i, h in sorted(record.items())],
            "cited": sorted(set(cited or []))}

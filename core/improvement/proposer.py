"""개선안 생성: 분석 리포트를 읽고 규칙 파라미터 또는 도메인 명세 변경안을 만든다.

제안하는 AI는 simulate_params 도구로 파라미터 변경을 직접 시험해 볼 수 있다 (규칙 엔진 재실행, 추가 비용 없음).
제출된 안은 코드로 다시 검증해 허용 범위를 벗어나거나 구조가 틀린 안은 invalid로 표시한다.
"""

import json

from core.llm.client import LLMClient
from core.llm.control import Budget
from core.llm.events import check_event
from core.llm.tool_loop import run_tool_loop, usage_dict
from core.params import params_view
from core.retrieval.tool import citation_errors, search_tool

from .changes import apply_params, params_errors, spec_errors, spec_sections
from .constraints import constraint_violations
from .simulate import simulate_params

SUBMIT = "submit_proposals"

SYSTEM = """너는 최적화 규칙의 개선안을 설계한다. 분석 리포트의 발견을 해소하는 변경을 제안한다.

개선안 종류:
- params: 규칙 파라미터 변경. params_changes(전역 값 변경)와 override_rules(특정 구간에만 적용할 규칙)를 쓴다.
  - 경로 형식: "섹션.키" 또는 "섹션.키[인덱스]". 값은 각 섹션 bounds 안이어야 한다.
  - 바꿀 수 있는 것은 분류(kinds)가 policy인 파라미터뿐이다 (get_params의 changeable).
    estimate(현실 추정값)·fixed·governance(승인 조건 같은 통제)는 참고 정보이며, 바꾸는 안은 적용 불가다.
  - override_rules의 when은 선언된 차원만, set은 overrides.allowed_sections의 섹션만 바꿀 수 있다.
  - 문제가 특정 구간에만 있으면 전역 변경보다 override_rules를 우선한다 (다른 구간 지표를 흔들지 않도록).
- spec: AI agent가 읽는 도메인 명세(고정 섹션)의 본문 수정. spec_edits에 섹션 제목과 새 본문 전체를 쓴다.
  효과 검증에 AI 재실행 비용이 들므로 파라미터로 풀 수 없는 판단 문제일 때만 제안한다.

절차:
1. get_params, get_spec으로 현재 값을 확인한다.
2. params 안은 simulate_params로 먼저 시험해 지표가 좋아지는지 확인하고, 시험 결과 수치를 rationale에 인용한다.
3. 1~3개 안을 submit_proposals로 제출한다. 각 안은 target_findings에 해소하려는 발견 id를 적는다."""


_CHANGES = {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "value": {}},
                                       "required": ["path", "value"]}}
_RULES = {"type": "array", "items": {"type": "object", "properties": {
    "when": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}}},
    "set": {"type": "object"}}, "required": ["when", "set"]}}
_EDITS = {"type": "array", "items": {"type": "object", "properties": {
    "section": {"type": "string"}, "text": {"type": "string"}}, "required": ["section", "text"]}}


BASE_KEYS = ("id", "title", "description", "slice", "reason_codes", "metric", "hypothesis")
# 개선 에이전트에 넘기는 발견 요약. resources는 적힌 발견에만 넣는다 (없으면 입력이 이전과 같다)
FINDING_SUMMARY_KEYS = BASE_KEYS + ("resources",)

CITED_DOCS = {"type": "array", "items": {"type": "string"},
              "description": "근거로 인용한 search_knowledge 결과의 ref (규정 조항·과거 사례·현장 의견)"}
RETRIEVAL_NOTE = ("\n\n# 문서 검색\nsearch_knowledge로 운영 규정·과거 사례·현장 의견을 찾을 수 있다. 규정과 맞지 않는 안은 내지 말고, "
                  "근거로 쓴 문서는 각 안의 cited_docs에 ref로 적어라. 인용하지 않은 문서는 근거가 아니다.")
# 과거 사례(case)를 검색할 수 있을 때만 붙인다 (M22). 없으면 입력이 이전과 같다
CASE_NOTE = ("\n과거 사례에서 이전에 반려된 개선안과 그 사유를 먼저 찾아라. 반려된 안과 같은 변경(같은 파라미터·같은 방향·"
             "같은 구간 조건)은 다시 내지 말고, 사유를 반영한 다른 안을 내라. 근거로 쓴 사례도 cited_docs에 적어라.")


def retrieval_note(kinds) -> str:
    """문서 검색 안내. kinds: 이 에이전트가 검색할 수 있는 문서 종류."""
    return RETRIEVAL_NOTE + (CASE_NOTE if "case" in (kinds or ()) else "")


def _submit_tool(cited_docs: bool = False) -> dict:
    tool = _submit_tool_base()
    if cited_docs:   # 검색 도구가 있을 때만 (없으면 도구 정의·캐시 키가 이전과 같다)
        tool["input_schema"]["properties"]["proposals"]["items"]["properties"]["cited_docs"] = CITED_DOCS
    return tool


def _submit_tool_base() -> dict:
    return {
        "name": SUBMIT,
        "description": "개선안 목록을 제출한다.",
        "input_schema": {"type": "object", "properties": {"proposals": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "kind": {"type": "string", "enum": ["params", "spec"]},
                "rationale": {"type": "string"},
                "expected_effect": {"type": "string"},
                "target_findings": {"type": "array", "items": {"type": "string"}},
                "params_changes": _CHANGES,
                "override_rules": _RULES,
                "spec_edits": _EDITS,
            },
            "required": ["title", "kind", "rationale", "target_findings"],
        }}}, "required": ["proposals"]},
    }


def finding_slices(report: dict) -> dict[str, dict]:
    """발견 id → 차원 필터 (시뮬레이션에서 구간별 실패율 비교용)."""
    return {f["id"]: f["slice"] for f in report.get("findings", []) if f.get("slice")}


def propose(pack_factory, instance, params: dict, spec_text: str, dimensions: dict, report: dict,
            llm: LLMClient, llm_config: dict, salt: str = "", max_calls: int = 20,
            feedback: list[str] | None = None, constraints: list[dict] | None = None,
            memory_text: str = "", retrieval: dict | None = None, on_event=None,
            budget: Budget | None = None) -> dict:
    """feedback: 앞선 시도의 개선안이 탈락한 이유 (재시도할 때 같은 안을 다시 내지 않도록 입력에 붙인다).
    constraints: 사람이 정한 한도 (core.improvement.constraints 형식). 입력에 붙이고, simulate_params 도구
    결과에 위반을 함께 돌려줘 제출 전에 스스로 피하게 한다.
    memory_text: 이전 회차에서 사람이 반려한 개선안 (core.improvement.memory.proposal_memory_text).
    retrieval: 문서 검색 (M15-C) {"index": core.retrieval.Index, "kinds": {종류: 설명}, "record": {}}.
    주면 search_knowledge 도구와 cited_docs 칸을 붙이고, 검색 결과에 없는 인용은 적용 불가로 표시한다.
    record에는 돌려준 조각 id → 해시가 모인다 (묶음 메타데이터용).
    모두 없으면 입력은 이전과 같다 (LLM 캐시 키도 같다)."""
    slices = finding_slices(report)
    trials: list[dict] = []

    def get_params(args):
        return {"params": params, **params_view(params)}

    def get_spec(args):
        return {"sections": spec_sections(spec_text)}

    def simulate(args):
        errors = params_errors(params, args, dimensions)
        if errors:
            return {"error": "; ".join(errors)}
        candidate = apply_params(params, args)
        result = simulate_params(pack_factory, instance, params, candidate, slices)
        if constraints:
            result["constraint_violations"] = constraint_violations(constraints, candidate, result)
        trials.append({"changes": args, "result": result})
        return result

    tools = [
        {"name": "get_params", "handler": get_params, "description": "현재 규칙 파라미터(허용 범위·구간 조건 포함).",
         "input_schema": {"type": "object", "properties": {}}},
        {"name": "get_spec", "handler": get_spec, "description": "현재 도메인 명세의 섹션별 본문.",
         "input_schema": {"type": "object", "properties": {}}},
        {"name": "simulate_params", "handler": simulate,
         "description": "파라미터 변경을 임시 적용해 규칙 엔진으로 재실행하고 전후 지표와 발견 구간별 실패율을 돌려준다.",
         "input_schema": {"type": "object", "properties": {"params_changes": _CHANGES, "override_rules": _RULES}}},
    ]
    findings = [{k: f.get(k) for k in FINDING_SUMMARY_KEYS if f.get(k) is not None or k in BASE_KEYS}
                for f in report.get("findings", [])]
    user = ("# 분석 리포트\n" + json.dumps({"summary": report.get("summary"), "findings": findings},
                                        ensure_ascii=False, indent=1)
            + "\n\n# 차원\n" + json.dumps({k: v.get("values") for k, v in dimensions.get("dimensions", {}).items()},
                                         ensure_ascii=False))
    if constraints:
        user += ("\n\n# 지켜야 할 제약 (현장·운영이 정한 한도, source는 누가 정했는지)\n"
                 + json.dumps(constraints, ensure_ascii=False, indent=1)
                 + "\nsimulate_params 결과의 constraint_violations가 비도록 안을 설계하라. "
                   "어길 수밖에 없으면 rationale에 어떤 제약을 왜 어기는지 적어라.")
    if retrieval:
        tools.append(search_tool(retrieval["index"], retrieval["kinds"], record=retrieval.setdefault("record", {})))
        user += retrieval_note(retrieval["kinds"])
    user += memory_text
    if feedback:
        user += ("\n\n# 이전 시도에서 탈락한 이유\n" + "\n".join(f"- {f}" for f in feedback)
                 + "\n같은 변경을 다시 제안하지 말고, 위 이유를 피하는 안을 제안하라.")
    result = run_tool_loop(llm, system=SYSTEM, user=user, tools=tools, submit_tool=_submit_tool(bool(retrieval)),
                           max_calls=max_calls, salt=salt, on_event=on_event,
                           budget=budget if budget is not None else Budget.from_config())

    proposals = []
    submitted = (result.submission or {}).get("proposals") or []
    for p in submitted if isinstance(submitted, list) else [submitted]:
        if not isinstance(p, dict):
            proposals.append({"proposal": {"title": str(p)[:80], "kind": "unknown"}, "errors": ["개선안 형식이 아님 (객체가 아님)"]})
            continue
        errors = (params_errors(params, p, dimensions) if p.get("kind") == "params"
                  else spec_errors(spec_text, p) if p.get("kind") == "spec" else ["알 수 없는 kind"])
        errors += citation_errors(p.get("cited_docs"), result.calls)
        proposals.append({"proposal": p, "errors": errors})
        if on_event:   # 제출 뒤 코드 검사 (허용 범위·분류·형식·인용) — 안마다 하나 (M16 타임라인)
            on_event(check_event(result.llm_calls, "개선안 검사", errors, text=f"개선안 검사 {'✓' if not errors else '✕'} {p.get('title', '')}"))
    return {"proposals": proposals, "trials": len(trials), "stop": result.stop, "failure": result.failure,
            "calls": result.calls,
            "usage": usage_dict(result, llm.model, llm_config)}

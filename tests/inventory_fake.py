"""inventory 도메인용 가짜 LLM 정책 (실제 API 없이 L0~L5·분석·개선·LangGraph 흐름 확인용).

- 발주 agent: 규칙 엔진의 결정을 그대로 낸다. 세 건 중 한 건은 첫 제출을 최소 발주 단위가 아닌 수량(+1)으로 틀리게 낸다.
  검증 루프가 없는 L0~L2에는 MOQ 위반이 남고, L3 이상은 재시도로 교정된다.
- 분석 agent: P1·P2·P3·P4를 도메인 분석 도구로 짚는다 (모범 분석가와 같은 질의).
- 개선 agent: 플래그십 안전재고 구간 조건(적용 가능), 주간 예산 증액(governance라 적용 불가), 명세 수정 세 건.
  입력에 제약이 있으면 규정을 검색해 인용하고 제약을 지키는 안 한 건만 낸다.
- 의견 정리 agent: 의견 한 줄의 "N주"를 안전재고 상한 제약으로, "플래그십"이 있으면 그 구간에만 건다.
"""

import json
import re

from tests.fake_llm import tool_use

FLAGSHIP_RULE = {"when": {"family": ["flagship"]}, "set": {"safety.weeks": 2.0}}
CONSTRAINTS_HEADER = "# 지켜야 할 제약"
ANALYST_QUERIES = [
    ("stockout_by", {"group_by": ["branch", "phase", "week_band"],
                     "filters": {"branch": ["B"], "phase": ["new"], "week_band": ["early"]}}),
    ("aggregate", {"group_by": ["maker"], "filters": {"maker": ["MC"]}}),
    ("branch_stock_stats", {}),
    ("stockout_by", {"group_by": ["family"], "filters": {"family": ["flagship"]}}),
]


def submit_order(item_id: str, qty: int | None, supplier: str | None = None, reason: str | None = None) -> dict:
    if qty is None:
        return tool_use("submit_decision", {"item_id": item_id, "action": "unassigned", "reason_code": reason,
                                            "evidence": "fake"})
    return tool_use("submit_decision", {"item_id": item_id, "action": "assign", "evidence": "fake",
                                        "decision": {"order_qty": qty, "supplier": supplier}})


def _calls(messages):
    return [b for m in messages if m["role"] == "assistant" for b in m["content"] if b.get("type") == "tool_use"]


def _outputs(messages):
    return [json.loads(b["content"]) for m in messages if m["role"] == "user" and isinstance(m["content"], list)
            for b in m["content"] if b.get("type") == "tool_result" and not b.get("is_error")]


def _first_text(messages) -> str:
    content = messages[0]["content"] if messages else ""
    return content if isinstance(content, str) else ""


def analyst(n, messages):
    if n < len(ANALYST_QUERIES):
        return tool_use(*ANALYST_QUERIES[n])
    ids = [c["id"] for c in _calls(messages)]
    surge, mc, stock, flag = _outputs(messages)[:4]
    findings = []
    if surge["rows"]:
        r = surge["rows"][0]
        findings.append({"title": "강남지점 신규 모델 초반 결품",
                         "slice": {"branch": ["B"], "phase": ["new"], "week_band": ["early"]},
                         "description": f"수요 {r['demand']}대 중 {r['lost']}대 결품", "cited_calls": [ids[0]]})
    if mc["rows"]:
        r = mc["rows"][0]
        findings.append({"title": "제조사 C 공급 한도 실패", "slice": {"maker": ["MC"]}, "reason_codes": ["SUPPLY_CAP"],
                         "description": f"{r['items']}건 중 {r['failed']}건 실패", "cited_calls": [ids[1]]})
    high = max(stock["rows"], key=lambda r: r["avg_stock_days"])
    findings.append({"title": "지점 재고 과잉", "metric": {"name": "avg_stock_days", "direction": "high"},
                     "description": f"{high['branch_name']} 평균 재고일수 {high['avg_stock_days']}일",
                     "cited_calls": [ids[2]]})
    if flag["rows"]:
        findings.append({"title": "플래그십 결품", "slice": {"family": ["flagship"]},
                         "description": f"수요 {flag['rows'][0]['demand']}대 중 {flag['rows'][0]['lost']}대 결품",
                         "cited_calls": [ids[3]]})
    return tool_use("submit_report", {"summary": "가짜 분석 agent의 리포트", "findings": findings})


def proposer(n, messages, names=()):
    if CONSTRAINTS_HEADER in _first_text(messages):
        search = "search_knowledge" in names
        if search and n == 0:
            return tool_use("search_knowledge", {"query": "안전재고 상한", "params": ["safety.weeks"],
                                                 "kinds": ["regulation"]})
        if n == (1 if search else 0):
            return tool_use("simulate_params", {"override_rules": [FLAGSHIP_RULE]})
        return tool_use("submit_proposals", {"proposals": [
            {"title": "플래그십만 안전재고 2주 (제약 반영)", "kind": "params", "target_findings": ["F4"],
             "rationale": "변동이 큰 플래그십에만 안전재고를 늘린다" + (" (규정 STK-02: 3주 이하)" if search else ""),
             "expected_effect": "플래그십 결품 감소", "override_rules": [FLAGSHIP_RULE],
             **({"cited_docs": ["STK-02"]} if search else {})}]})
    if n == 0:
        return tool_use("simulate_params", {"override_rules": [FLAGSHIP_RULE]})
    return tool_use("submit_proposals", {"proposals": [
        {"title": "플래그십만 안전재고 2주", "kind": "params", "target_findings": ["F4"],
         "rationale": "플래그십 수요 변동이 커서 안전재고 1주로는 모자란다. 다른 모델군은 그대로 둔다",
         "expected_effect": "플래그십 결품 감소, 구매 금액 소폭 증가", "override_rules": [FLAGSHIP_RULE]},
        {"title": "주간 예산 증액", "kind": "params", "target_findings": ["F2"],
         "rationale": "통제 설정 검사를 보여주기 위한 제안",
         "params_changes": [{"path": "budget.weekly_cap", "value": 150000}]},
        {"title": "예외 처리: 신규 모델 초반 결품 대비", "kind": "spec", "target_findings": ["F1"],
         "rationale": "출시 직후 수요 급증을 근거에 적게 한다",
         "spec_edits": [{"section": "예외 처리",
                         "text": "- 신규 모델이 출시 초반이면 최근 주 수요가 평균보다 높은지 근거에 적는다"}]},
    ]})


def opinion(messages):
    text = _first_text(messages)
    line = text.split("\n")[1] if "\n" in text else text
    weeks = re.search(r"(\d+(?:\.\d+)?)\s*주", line)
    c = {"type": "param", "path": "safety.weeks", "source": "현장 의견", "note": line}
    if weeks:
        c["max"] = float(weeks.group(1))
    if "플래그십" in line:
        c["when"] = {"family": ["flagship"]}
    return tool_use("submit_constraints", {"constraints": [c],
                                           "summary": "의견의 안전재고 한도를 제약으로" if weeks else "숫자 한도가 없음"})


def supervisor(n):
    if n == 0:
        return tool_use("run_analysis", {})
    if n == 1:
        return tool_use("run_proposals", {"focus": "구간 조건(override_rules)만"})
    if n == 2:
        return tool_use("simulate", {"proposal_id": "P1"})
    return tool_use("submit_judgment", {
        "summary": "가짜: 플래그십 결품을 구간 안전재고로 줄이는 안을 추천",
        "recommendations": [{"proposal_id": "P1", "cited_calls": ["c3"], "expected_effect": "플래그십 결품 감소",
                             "loses": "구매 금액 소폭 증가", "confidence": "중간"}],
        "not_recommended": [],
        "hypotheses": [{"statement": "플래그십 결품은 수요 변동 대비 안전재고 부족", "support": "c1 분석",
                        "against": "공급 한도 영향일 수 있음", "confidence": "중간",
                        "would_flip": "안전재고를 늘려도 결품률이 그대로면"}],
        "attempts": [{"what": "분석 → 개선 → 미리 돌려보기", "why": "원인 확인", "learned": "구간 조건이 효과"}],
        "questions_for_human": ["제조사 C 공급 한도 협의가 가능한가"],
        "end_reason": "good_enough"})


def build_policy(pack, instance, wrong_every: int = 3):
    rule = {d.item_id: d for d in pack.solve(instance, pack.params)}
    order = pack.items(instance)

    def policy(item, n, messages, tools):
        names = {t["name"] for t in tools}
        if "submit_report" in names:
            return analyst(n, messages)
        if "submit_proposals" in names:
            return proposer(n, messages, names)
        if "submit_judgment" in names:
            return supervisor(n)
        if "choose_next_step" in names:
            ask = json.loads(_first_text(messages))
            return tool_use("choose_next_step", {"next": ask["rule_recommendation"], "reason": "고정 규칙과 같음"})
        if "submit_constraints" in names:
            if "search_knowledge" in names and n == 0:
                return tool_use("search_knowledge", {"query": _first_text(messages).split("\n")[1],
                                                     "kinds": ["regulation"]})
            return opinion(messages)
        if "get_stock" in names and "submit_decision" in names:   # 조회 도구가 있는 레벨이면 결정 전에 재고를 한 번 본다
            if n == 0:
                return tool_use("get_stock", {})
            n -= 1
        d = rule[item]
        if d.status != "success":
            return submit_order(item, None, reason=d.reason_code)
        qty = d.decision["order_qty"]
        wrong_first = wrong_every and order.index(item) % wrong_every == 1 and n == 0
        return submit_order(item, qty + 1 if wrong_first else qty, d.decision["supplier"])

    return policy

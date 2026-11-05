"""분석 agent용 도메인 통계 도구 (차원 집계로 안 보이는 재고 흐름 지표).

M21-a: 지점별 재고 통계만 둔다. 결품 구간·공급 한도 사용률·예측 오차 도구는 M21-b에서 더한다.
"""

from collections import defaultdict

from core.interfaces import DecisionRecord

from .metrics import outcome
from .models import Instance


def build_analysis_tools(inst: Instance, decisions: list[DecisionRecord], params: dict) -> list[dict]:
    res, pairs, cells = outcome(inst, decisions, params)

    def branch_stock_stats(args: dict) -> dict:
        acc = defaultdict(lambda: {"demand": 0, "lost": 0, "end_stock": 0, "ordered": 0, "purchase": 0})
        for c in cells:
            a = acc[c.branch]
            a["demand"] += c.demand
            a["lost"] += c.lost
            a["end_stock"] += c.end_stock
            a["ordered"] += c.order
            a["purchase"] += c.order * inst.models[c.model].unit_cost
        rows = []
        for b in sorted(acc):
            a = acc[b]
            rows.append({"branch": b, "branch_name": inst.branches[b].name, "demand": a["demand"], "lost": a["lost"],
                         "stockout_rate": round(a["lost"] / a["demand"], 3) if a["demand"] else 0.0,
                         "avg_stock_days": round(a["end_stock"] / a["demand"] * 7, 1) if a["demand"] else 0.0,
                         "ordered_units": a["ordered"], "purchase_amount": a["purchase"]})
        return {"rows": rows, "note": "평균 재고일수 = 주말 재고 합 / 수요 합 × 7. 높으면 재고가 남아돈다"}

    return [
        {"name": "branch_stock_stats", "handler": branch_stock_stats,
         "description": "지점별 수요·결품·결품률·평균 재고일수·발주량·구매 금액 (계획 기간 전체).",
         "input_schema": {"type": "object", "properties": {}}},
    ]

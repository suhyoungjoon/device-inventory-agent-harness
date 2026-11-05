"""결과 화면용 데이터 (사람이 보는 화면 전용, API GET /runs/{id}/view). AI 입력에는 쓰지 않는다.

- cells: 결정 범위의 지점×모델, 계획 기간 주차별 재고 흐름 (입고·현재고·발주·수요·판매·결품·주말 재고)
- pairs: 지점×모델별 수요·결품·결품률·평균 재고일수 (결과 표의 칸)
- plan: 결정 범위 항목마다 발주 권고표 행 (예측·현재고·입고 예정·부족물량·권고 발주량·근거·걸린 제약)
"""

import re
from collections import defaultdict

from core.interfaces import DecisionRecord

from .metrics import outcome
from .models import Instance, parse_item
from .rule_engine import order_plan

LIMIT_RE = re.compile(r"(주간 예산|제조사 공급 한도|창고 용량)에 걸려")


def result_view(inst: Instance, decisions: list[DecisionRecord], params: dict, dimensions: dict) -> dict:
    res, pairs, cells = outcome(inst, decisions, params)
    by_item = {d.item_id: d for d in decisions}
    names = dimensions.get("names") or {}
    reasons = dimensions.get("reason_codes") or {}

    cell_rows = [{"item_id": it, "week": c.week, "branch": c.branch, "model": c.model, "arrivals": c.arrivals,
                  "on_hand": c.on_hand, "on_order": c.on_order, "order": c.order, "demand": c.demand,
                  "sales": c.sales, "lost": c.lost, "end_stock": c.end_stock}
                 for it, c in sorted(res.cells.items(), key=lambda kv: (kv[1].week, kv[1].branch, kv[1].model))
                 if (c.branch, c.model) in pairs]

    acc = defaultdict(lambda: {"demand": 0, "lost": 0, "end_stock": 0})
    for c in cells:
        a = acc[(c.branch, c.model)]
        a["demand"] += c.demand
        a["lost"] += c.lost
        a["end_stock"] += c.end_stock
    pair_rows = [{"branch": b, "model": m, "demand": a["demand"], "lost": a["lost"],
                  "stockout_rate": round(a["lost"] / a["demand"], 3) if a["demand"] else 0.0,
                  "avg_stock_days": round(a["end_stock"] / a["demand"] * 7, 1) if a["demand"] else 0.0}
                 for (b, m), a in sorted(acc.items())]

    plan_rows = []
    for it in inst.items():
        week, b, m = parse_item(it)
        c = res.cells[it]
        p = order_plan(inst, week, b, m, params, c.on_hand, c.on_order)
        d = by_item.get(it)
        short = max(0, p["need"] - c.order)
        if d is not None and d.status != "success" and d.reason_code:
            constraint = names.get(d.reason_code) or reasons.get(d.reason_code, d.reason_code)
        elif short and d is not None and (hit := LIMIT_RE.search(d.evidence or "")):
            constraint = hit.group(1)
        elif short:
            constraint = "필요량보다 적게 발주"
        else:
            constraint = ""
        plan_rows.append({"item_id": it, "week": week, "branch": b, "model": m,
                          "forecast": p["forecast"], "on_hand": c.on_hand, "on_order": c.on_order,
                          "target": p["target"], "need": p["need"], "order": c.order, "short": short,
                          "amount": c.order * inst.models[m].unit_cost,
                          "status": d.status if d is not None else "none",
                          "evidence": (d.evidence if d is not None else ""), "constraint": constraint})

    return {"weeks": inst.weeks,
            "branches": {k: v.name for k, v in inst.branches.items()},
            "models": {k: {"name": v.name, "family": v.family, "maker": v.maker, "phase": v.phase,
                           "unit_cost": v.unit_cost, "eol_week": v.eol_week} for k, v in inst.models.items()},
            "cells": cell_rows, "pairs": pair_rows, "plan": plan_rows}

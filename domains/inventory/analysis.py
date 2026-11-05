"""분석 agent용 도메인 통계 도구 (차원 집계로 안 보이는 재고 흐름 지표).

코어의 집계 도구(overview, aggregate …)는 "발주 실패"(한도·단종으로 하나도 못 산 항목)만 센다.
결품·재고일수·공급 한도 사용률·예측 오차는 재고 흐름을 다시 계산해야 보이므로 여기서 제공한다.
수치는 도구 결과에 그대로 나온 값을 인용할 수 있게 소수 셋째 자리(비율)·첫째 자리(일수)로 반올림한다.
"""

from collections import defaultdict

from core.interfaces import DecisionRecord

from .metrics import outcome
from .models import Instance, pair_key
from .rule_engine import dims_of, effective_params, forecast

_DIMS = {"type": "array", "items": {"type": "string"}}
_FILTERS = {"type": "object", "description": "차원별 허용 값. 예: {\"branch\": [\"A\"]}",
            "additionalProperties": {"type": "array", "items": {"type": "string"}}}


def _rate(n: float, total: float) -> float:
    return round(n / total, 3) if total else 0.0


def _days(stock: float, demand: float) -> float:
    return round(stock / demand * 7, 1) if demand else 0.0


def build_analysis_tools(inst: Instance, decisions: list[DecisionRecord], params: dict) -> list[dict]:
    res, pairs, cells = outcome(inst, decisions, params)
    cell_dims = {id(c): dims_of(inst, c.week, c.branch, c.model) for c in cells}
    declared = {"branch", "family", "maker", "phase", "week_band"}

    def _check(names) -> None:
        unknown = set(names) - declared
        if unknown:
            raise ValueError(f"선언되지 않은 차원: {sorted(unknown)} (가능: {sorted(declared)})")

    def stockout_by(args: dict) -> dict:
        group_by = list(args.get("group_by") or [])
        filters = args.get("filters") or {}
        _check(group_by)
        _check(filters)
        allowed = {k: {str(v) for v in (vals if isinstance(vals, list) else [vals])} for k, vals in filters.items()}
        acc = defaultdict(lambda: {"cells": 0, "demand": 0, "lost": 0, "end_stock": 0, "stockout_weeks": 0})
        total = {"demand": 0, "lost": 0}
        for c in cells:
            d = cell_dims[id(c)]
            if not all(d[k] in v for k, v in allowed.items()):
                continue
            a = acc[tuple(d[k] for k in group_by)]
            a["cells"] += 1
            a["demand"] += c.demand
            a["lost"] += c.lost
            a["end_stock"] += c.end_stock
            a["stockout_weeks"] += c.lost > 0
            total["demand"] += c.demand
            total["lost"] += c.lost
        rows = [{**dict(zip(group_by, key)), "cells": a["cells"], "demand": a["demand"], "lost": a["lost"],
                 "stockout_rate": _rate(a["lost"], a["demand"]), "stockout_weeks": a["stockout_weeks"],
                 "avg_stock_days": _days(a["end_stock"], a["demand"])} for key, a in acc.items()]
        sort = args.get("sort_by") or "stockout_rate"
        rows.sort(key=lambda r: (-r[sort], tuple(str(r[k]) for k in group_by)))
        limit = int(args.get("limit") or 30)
        return {"group_by": group_by, "filters": filters, "demand": total["demand"], "lost": total["lost"],
                "stockout_rate": _rate(total["lost"], total["demand"]), "groups": len(rows), "rows": rows[:limit],
                "note": "칸 = 주차×지점×모델. 결품률 = 못 판 수요 / 수요. 기본은 결품률 높은 순"}

    def branch_stock_stats(args: dict) -> dict:
        acc = defaultdict(lambda: {"demand": 0, "lost": 0, "end_stock": 0, "ordered": 0, "purchase": 0})
        for c in cells:
            a = acc[c.branch]
            a["demand"] += c.demand
            a["lost"] += c.lost
            a["end_stock"] += c.end_stock
            a["ordered"] += c.order
            a["purchase"] += c.order * inst.models[c.model].unit_cost
        rows = [{"branch": b, "branch_name": inst.branches[b].name, "demand": a["demand"], "lost": a["lost"],
                 "stockout_rate": _rate(a["lost"], a["demand"]), "avg_stock_days": _days(a["end_stock"], a["demand"]),
                 "ordered_units": a["ordered"], "purchase_amount": a["purchase"]}
                for b, a in sorted(acc.items())]
        days = [r["avg_stock_days"] for r in rows]
        return {"rows": rows, "max_minus_min_stock_days": round(max(days) - min(days), 1) if days else 0.0,
                "note": "평균 재고일수 = 주말 재고 합 / 수요 합 × 7. 높으면 재고가 남아돈다 (과잉), 낮으면 결품 위험"}

    def supply_usage(args: dict) -> dict:
        used = defaultdict(lambda: defaultdict(int))
        for c in res.cells.values():
            used[inst.models[c.model].maker][c.week] += c.order
        failed = defaultdict(int)
        for d in decisions:
            if d.reason_code == "SUPPLY_CAP":
                failed[d.dims.get("maker")] += 1
        rows = []
        for mk, maker in sorted(inst.makers.items()):
            weekly = [used[mk][w] for w in range(1, inst.weeks + 1)]
            rows.append({"maker": mk, "maker_name": maker.name, "supply_cap": maker.supply_cap,
                         "weekly_ordered": weekly, "avg_usage": _rate(sum(weekly) / len(weekly), maker.supply_cap),
                         "weeks_at_cap": sum(u >= maker.supply_cap for u in weekly),
                         "supply_cap_failures": failed[mk]})
        return {"rows": rows, "note": "주별 발주 합(세 지점)과 공급 한도. weeks_at_cap은 한도를 다 쓴 주 수"}

    def forecast_error(args: dict) -> dict:
        group_by = args.get("group_by") or "model"
        if group_by not in declared | {"model"}:
            raise ValueError(f"group_by는 model 또는 {sorted(declared)} 중 하나")
        acc = defaultdict(lambda: {"n": 0, "ape": 0.0, "forecast": 0.0, "actual": 0})
        for c in cells:
            if c.demand <= 0:
                continue
            p = effective_params(inst, c.week, c.branch, c.model, params)
            f = forecast(inst, c.week, c.branch, c.model, p)
            key = c.model if group_by == "model" else cell_dims[id(c)][group_by]
            a = acc[key]
            a["n"] += 1
            a["ape"] += abs(f - c.demand) / c.demand
            a["forecast"] += f
            a["actual"] += c.demand
        rows = []
        for key, a in acc.items():
            row = {group_by: key, "cells": a["n"], "mape": _rate(a["ape"], a["n"]),
                   "forecast_total": round(a["forecast"]), "actual_total": a["actual"],
                   "bias": _rate(a["forecast"] - a["actual"], a["actual"])}
            if group_by == "model":
                m = inst.models[key]
                row.update(model_name=m.name, family=m.family, maker=m.maker, phase=m.phase)
            rows.append(row)
        rows.sort(key=lambda r: -r["mape"])
        return {"group_by": group_by, "rows": rows,
                "note": "규칙 예측(이동평균 × 신제품 보정)과 실제 수요의 차이. bias가 음수면 과소 예측"}

    def demand_volatility(args: dict) -> dict:
        acc = defaultdict(list)
        for b, m in sorted(pairs):
            if inst.models[m].phase != "main":     # 신규(상승)·단종 예정(하락)은 추세가 변동처럼 보이므로 뺀다
                continue
            hist = [v for v in inst.history[pair_key(b, m)] if v > 0]
            if len(hist) >= 2:
                mean = sum(hist) / len(hist)
                sd = (sum((v - mean) ** 2 for v in hist) / (len(hist) - 1)) ** 0.5
                acc[inst.models[m].family].append(sd / mean if mean else 0.0)
        rows = [{"family": f, "pairs": len(v), "avg_cv": round(sum(v) / len(v), 3)} for f, v in sorted(acc.items())]
        rows.sort(key=lambda r: -r["avg_cv"])
        return {"rows": rows, "note": "주력 모델 과거 이력의 주간 수요 변동계수(표준편차 / 평균) 모델군 평균. 높을수록 들쭉날쭉"}

    obj = {"type": "object"}
    return [
        {"name": "stockout_by", "handler": stockout_by,
         "description": "결품 집계: group_by 차원 조합별 수요·결품·결품률·결품 주 수·평균 재고일수. filters로 범위를 좁힌다.",
         "input_schema": {**obj, "properties": {
             "group_by": _DIMS, "filters": _FILTERS,
             "sort_by": {"type": "string", "enum": ["stockout_rate", "lost", "demand", "avg_stock_days"]},
             "limit": {"type": "integer", "minimum": 1, "maximum": 50}}}},
        {"name": "branch_stock_stats", "handler": branch_stock_stats,
         "description": "지점별 수요·결품·결품률·평균 재고일수·발주량·구매 금액과 지점 간 재고일수 차이 (계획 기간 전체).",
         "input_schema": {**obj, "properties": {}}},
        {"name": "supply_usage", "handler": supply_usage,
         "description": "제조사별 주간 공급 한도와 주별 발주 합, 평균 사용률, 한도를 다 쓴 주 수, 공급 한도 실패 건수.",
         "input_schema": {**obj, "properties": {}}},
        {"name": "forecast_error", "handler": forecast_error,
         "description": "규칙 예측의 오차(MAPE)와 치우침(bias)을 모델별 또는 차원별로.",
         "input_schema": {**obj, "properties": {"group_by": {"type": "string"}}}},
        {"name": "demand_volatility", "handler": demand_volatility,
         "description": "모델군별 과거 주간 수요 변동계수 (안전재고가 모자랄 위험).",
         "input_schema": {**obj, "properties": {}}},
    ]

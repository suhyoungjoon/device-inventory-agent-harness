"""inventory: 도구 결과만 인용하는 '모범 분석가'가 심은 패턴 P1~P4를 모두 찾을 수 있는지.

분석 도구·근거 검사(수치가 도구 결과에 있어야 함)·정답표 채점이 맞물리는지 확인한다.
"""

import json

from core.analysis.agent import analyze
from core.evaluation.fault_scorer import apply_labels, score
from core.llm.client import load_config
from domains.inventory.pack import get_pack
from tests.fake_llm import FakeLLM, tool_use


def test_ideal_analyst_can_find_all_planted_faults():
    pack = get_pack()
    inst, truth = pack.generate(42, ["P1", "P2", "P3", "P4"])
    decisions = pack.solve(inst, pack.params)
    queries = [
        ("stockout_by", {"group_by": ["branch", "phase", "week_band"],
                         "filters": {"branch": ["B"], "phase": ["new"], "week_band": ["early"]}}),
        ("aggregate", {"group_by": ["maker"], "filters": {"maker": ["MC"]}}),
        ("branch_stock_stats", {}),
        ("stockout_by", {"group_by": ["family"], "filters": {"family": ["flagship"]}}),
    ]

    def policy(item, n, messages, tools):
        if n < len(queries):
            return tool_use(*queries[n])
        calls = [b for m in messages if m["role"] == "assistant" for b in m["content"] if b.get("type") == "tool_use"]
        outs = [json.loads(b["content"]) for m in messages if m["role"] == "user" and isinstance(m["content"], list)
                for b in m["content"] if b.get("type") == "tool_result"]
        surge, mc, stock, flag = outs[0]["rows"][0], outs[1]["rows"][0], outs[2]["rows"], outs[3]["rows"][0]
        high = max(stock, key=lambda r: r["avg_stock_days"])
        findings = [
            {"title": "강남지점 신규 모델 초반 결품", "slice": {"branch": ["B"], "phase": ["new"], "week_band": ["early"]},
             "description": f"수요 {surge['demand']}대 중 {surge['lost']}대 결품, 결품률 {surge['stockout_rate'] * 100:.1f}%",
             "cited_calls": [calls[0]["id"]]},
            {"title": "제조사 C 공급 한도 실패", "slice": {"maker": ["MC"]}, "reason_codes": ["SUPPLY_CAP"],
             "description": f"{mc['items']}건 중 {mc['failed']}건 실패", "cited_calls": [calls[1]["id"]]},
            {"title": "서초지점 재고 과잉", "metric": {"name": "avg_stock_days", "direction": "high"},
             "description": f"{high['branch_name']} 평균 재고일수 {high['avg_stock_days']}일",
             "cited_calls": [calls[2]["id"]]},
            {"title": "플래그십 결품", "slice": {"family": ["flagship"]},
             "description": f"결품률 {flag['stockout_rate'] * 100:.1f}%", "cited_calls": [calls[3]["id"]]},
        ]
        return tool_use("submit_report", {"summary": "4개 패턴", "findings": findings})

    report = analyze(pack, inst, decisions, FakeLLM(policy), load_config())
    assert report["dropped"] == [], report["dropped"]
    result = score(report["findings"], truth["faults"], report["calls"])
    assert result["unmatched_findings"] == []
    # P3는 자동으로는 근거 일치까지(원인 확인 대기), 사람이 원인을 확인하면 4개 모두 탐지
    assert (result["detected"], result["pending"]) == (3, 1)
    assert result["faults"]["P3"]["matched_findings"] == ["F3"]
    assert apply_labels(result, {"F3": "cause_ok"})["detected"] == 4


def test_p3_requires_stock_stats_tool():
    """P3(지표형) 발견은 지점별 재고 통계 도구를 인용해야 맞는다 (요약 수치만으로는 근거 부족)."""
    pack = get_pack()
    _inst, truth = pack.generate(42, ["P3"])
    finding = {"id": "F1", "metric": {"name": "avg_stock_days", "direction": "high"}, "cited_calls": ["c1"]}
    calls = {"c1": {"name": "overview"}}
    assert score([finding], truth["faults"], calls)["faults"]["P3"]["status"] == "missed"
    calls = {"c1": {"name": "branch_stock_stats"}}
    assert score([finding], truth["faults"], calls)["faults"]["P3"]["status"] == "pending"


def test_analysis_tools_reject_unknown_dims():
    pack = get_pack()
    inst, _ = pack.generate(0, [])
    tools = {t["name"]: t["handler"] for t in pack.analysis_tools(inst, pack.solve(inst, pack.params))}
    import pytest
    with pytest.raises(ValueError):
        tools["stockout_by"]({"group_by": ["hour"]})
    assert tools["forecast_error"]({})["rows"][0]["model_name"]


def test_stockout_hotspots_surface_p1_and_p4_first():
    """결품 구간 도구가 한 번에 P1(강남·신규·초반)과 플래그십 구간을 보여 준다 (실제 분석이 실패 사유만 보고 놓쳤던 것)."""
    pack = get_pack()
    inst, _ = pack.generate(42, ["P1", "P2", "P3", "P4"])
    tools = {t["name"]: t for t in pack.analysis_tools(inst, pack.solve(inst, pack.params))}
    assert list(tools)[0] == "stockout_hotspots" and "결품" in tools["stockout_hotspots"]["description"]
    rows = tools["stockout_hotspots"]["handler"]({"limit": 40})["rows"]
    assert rows[0]["slice"] == {"branch": ["B"], "phase": ["new"], "week_band": ["early"]}
    assert {"family": ["flagship"]} in [r["slice"] for r in rows]

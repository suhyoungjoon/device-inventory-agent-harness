"""inventory(단말 재고·구매) 도메인 팩. core.interfaces.DomainPack 구현."""

from pathlib import Path

import yaml

from core.interfaces import DecisionRecord, Violation
from core.registry import domain_file

from . import generator, metrics, rule_engine
from .analysis import build_analysis_tools
from .models import Instance, parse_item
from .tools import build_tools

PACK_DIR = Path(__file__).resolve().parent
NAME = "inventory"


class InventoryPack:
    name = NAME

    def __init__(self, params: dict | None = None):
        # validate·metrics는 예산·발주 단위·리드타임 계산에 params가 필요하다.
        # 개선안 시뮬레이션은 get_pack(params=후보안)으로 팩을 새로 만든다.
        self.params = params if params is not None else yaml.safe_load(
            Path(self.params_path()).read_text(encoding="utf-8"))

    def generate(self, seed: int, faults: list[str]) -> tuple[Instance, dict]:
        return generator.generate(seed, faults)

    def items(self, instance: Instance) -> list[str]:
        # 처리 순서: 주차 → 지점 → 모델 (재고가 주차를 넘어 이어진다)
        return instance.items()

    def solve(self, instance: Instance, params: dict) -> list[DecisionRecord]:
        return rule_engine.solve(instance, params)

    def validate(self, instance: Instance, decisions: list[DecisionRecord]) -> list[Violation]:
        return rule_engine.validate(instance, decisions, self.params)

    def metrics(self, instance: Instance, decisions: list[DecisionRecord]) -> dict[str, float]:
        return metrics.compute(instance, decisions, self.params)

    def tools(self, instance: Instance) -> list[dict]:
        return build_tools(instance, self.params)

    def spec_path(self) -> str:
        return str(domain_file(NAME, "domain-spec.md", PACK_DIR))

    def params_path(self) -> str:
        return str(domain_file(NAME, "params.yaml", PACK_DIR))

    def dimensions(self) -> dict:
        return yaml.safe_load((PACK_DIR / "dimensions.yaml").read_text(encoding="utf-8"))

    # --- AI agent 하네스용 ---

    def decision_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "order_qty": {"type": "integer", "minimum": 0,
                              "description": "이번 주 발주량(대). 0이면 발주하지 않음. 최소 발주 단위의 배수"},
                "supplier": {"type": "string", "enum": sorted(self.dimensions()["dimensions"]["maker"]["values"]),
                             "description": "발주할 제조사 ID (모델의 제조사)"},
            },
            "required": ["order_qty", "supplier"],
        }

    def item_dims(self, instance: Instance, item_id: str) -> dict[str, str]:
        week, branch, model = parse_item(item_id)
        return rule_engine.dims_of(instance, week, branch, model)

    def approval_reasons(self, instance: Instance, record: DecisionRecord,
                         decisions: list[DecisionRecord]) -> list[str]:
        qty = rule_engine.parse_order(record.decision)
        parsed = parse_item(record.item_id)
        if not qty or parsed is None or parsed[2] not in instance.models:
            return []
        model = instance.models[parsed[2]]
        rules = self.params["approval"]
        reasons = []
        amount = qty * model.unit_cost
        if amount >= rules["order_amount_gte"]:
            reasons.append(f"한 건 발주 금액 {amount}만원이 승인 기준 {rules['order_amount_gte']}만원 이상")
        if rules.get("eol_order") and model.phase == "eol":
            reasons.append(f"단종 예정 모델 {model.name} 발주")
        return reasons

    def subset(self, instance: Instance, item_ids: list[str]) -> Instance:
        keep = set(item_ids)
        sub = Instance(weeks=instance.weeks, history_weeks=instance.history_weeks, branches=instance.branches,
                       makers=instance.makers, models=instance.models, history=instance.history,
                       initial_stock=instance.initial_stock,
                       scope=[i for i in instance.items() if i in keep])
        sub.set_actual(instance._hidden_actual)
        return sub

    def analysis_tools(self, instance: Instance, decisions: list[DecisionRecord]) -> list[dict]:
        return build_analysis_tools(instance, decisions, self.params)

    # --- 선택 기능 (M21): 결과 화면용 데이터 (API GET /runs/{id}/view, 사람 화면 전용) ---
    def result_view(self, instance: Instance, decisions: list[DecisionRecord]) -> dict:
        from .view import result_view
        return result_view(instance, decisions, self.params, self.dimensions())

    # --- 선택 기능 (M21): 개선안 미리 돌려보기의 구간 비교를 결품률로 (core.improvement.simulate가 있으면 쓴다) ---
    def slice_rates(self, instance: Instance, decisions: list[DecisionRecord], filters: dict) -> dict:
        """구간의 결품: items = 수요(대), failed = 못 판 수요(대), fail_rate = 결품률. 선언되지 않은 차원이면 ValueError."""
        tool = next(t for t in build_analysis_tools(instance, decisions, self.params) if t["name"] == "stockout_by")
        r = tool["handler"]({"group_by": [], "filters": filters})
        return {"items": r["demand"], "failed": r["lost"], "fail_rate": r["stockout_rate"],
                "label": "결품률", "unit": "대"}


def get_pack(params: dict | None = None) -> InventoryPack:
    return InventoryPack(params)

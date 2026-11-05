"""inventory(단말 재고·구매) 도메인 데이터 모델.

주차는 계획 기간 1..weeks, 과거 이력은 history_weeks주(마지막 원소가 계획 직전 주).
지점×모델 키는 "지점:모델" 문자열이다 (JSON 직렬화 때문에 튜플 키를 쓰지 않는다).

계획 기간의 실제 수요는 dataclass 필드가 아니라 숨김 속성(_actual)에 둔다.
to_jsonable(L0 프롬프트, API 응답)은 dataclass 필드만 직렬화하므로 미래 수요가 AI에게 새지 않는다.
읽을 때는 actual(key)·observed(key, week)를 쓴다.
"""

from dataclasses import dataclass
from functools import cached_property


def pair_key(branch: str, model: str) -> str:
    return f"{branch}:{model}"


def item_id(week: int, branch: str, model: str) -> str:
    return f"W{week}-{branch}-{model}"


def parse_item(item: str) -> tuple[int, str, str] | None:
    """item_id → (주차, 지점, 모델). 형식이 틀리면 None."""
    try:
        w, branch, model = item.split("-", 2)
        if not w.startswith("W"):
            return None
        return int(w[1:]), branch, model
    except (ValueError, AttributeError):
        return None


@dataclass
class Branch:
    id: str
    name: str                     # 표시 이름 (예: 서초지점)
    warehouse_capacity: int       # 창고 용량 (대): 지점 전체 현재고 + 입고 예정 상한


@dataclass
class Maker:
    id: str
    name: str                     # 표시 이름 (예: 제조사 A)
    supply_cap: int               # 주간 공급 한도 (대): 이 제조사 모델의 주간 발주 합 상한


@dataclass
class DeviceModel:
    id: str
    name: str                     # 가상 모델명 (예: A-플래그십-1)
    family: str                   # flagship | mid | kids_senior
    maker: str                    # 제조사 ID
    phase: str                    # new | main | eol
    unit_cost: int                # 대당 구매 단가 (만원)
    launch_offset: int | None = None   # 신규 모델: 계획 시작 몇 주 전에 출시했나 (이력에서 그 전 주는 판매 없음)
    eol_week: int | None = None        # 단종 예정 모델: 이 주차부터 발주 금지


@dataclass
class Instance:
    weeks: int                                    # 계획 기간 주 수
    history_weeks: int                            # 과거 이력 주 수
    branches: dict[str, Branch]
    makers: dict[str, Maker]
    models: dict[str, DeviceModel]
    history: dict[str, list[int]]                 # "지점:모델" → 과거 주간 수요 (판매 + 놓친 수요)
    initial_stock: dict[str, int]                 # "지점:모델" → 계획 1주 시작 재고
    scope: list[str] | None = None                # 부분 실행 항목 (None이면 전체)

    # --- 실제 수요 (숨김: dataclass 필드가 아니라 직렬화되지 않는다) ---
    def set_actual(self, actual: dict[str, list[int]]) -> None:
        self._hidden_actual = actual

    def actual(self, key: str) -> list[int]:
        return self._hidden_actual[key]

    def observed(self, key: str, week: int) -> list[int]:
        """계획 week주 시점에 관측된 수요: 과거 이력 + 계획 기간 중 week 전 주의 실제 수요."""
        return list(self.history[key]) + list(self._hidden_actual[key][:max(0, week - 1)])

    # --- 색인 ---
    @cached_property
    def pairs(self) -> list[tuple[str, str]]:
        return [(b, m) for b in sorted(self.branches) for m in sorted(self.models)]

    def all_items(self) -> list[str]:
        """처리 순서: 주차 → 지점 → 모델."""
        return [item_id(w, b, m) for w in range(1, self.weeks + 1) for b, m in self.pairs]

    def items(self) -> list[str]:
        everything = self.all_items()
        if self.scope is None:
            return everything
        keep = set(self.scope)
        return [i for i in everything if i in keep]

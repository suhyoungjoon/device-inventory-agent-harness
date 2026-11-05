"""가상 데이터 생성 (단말 재고·구매).

같은 seed면 같은 데이터가 나온다. 지점×모델마다 이름 붙인 난수열을 따로 써서,
한 구간을 바꿔도(결함 주입) 나머지 데이터는 그대로다 (전후 비교가 공정해진다).

수요 수준(level)은 계획 주차 t 기준이다: 이력의 마지막 주가 t=0, 계획 1주가 t=1.
- 주력: 기본 수요 그대로
- 신규: 출시 후 매주 new_growth만큼 오른다 (출시 전 주는 판매 없음)
- 단종 예정: 매주 eol_decline만큼 내린다
"""

import random
from pathlib import Path

import yaml

from .models import Branch, DeviceModel, Instance, Maker, pair_key

PACK_DIR = Path(__file__).resolve().parent


def load_yaml(filename: str) -> dict:
    return yaml.safe_load((PACK_DIR / filename).read_text(encoding="utf-8"))


def _rng(seed: int, *names) -> random.Random:
    return random.Random("|".join([str(seed), *map(str, names)]))


def level(model: DeviceModel, base: float, t: int, cfg: dict) -> float:
    """계획 주차 t의 기대 수요 (t <= 0은 과거 이력)."""
    if model.phase == "new":
        if model.launch_offset is not None and t <= -model.launch_offset:
            return 0.0
        return base * (1 + cfg["new_growth"]) ** (t - 1)
    if model.phase == "eol":
        return base * (1 - cfg["eol_decline"]) ** (t - 1)
    return base


def _draw(rng: random.Random, mean: float, cv: float) -> int:
    if mean <= 0:
        return 0
    return max(0, round(rng.gauss(mean, mean * cv)))


def generate(seed: int, faults: list[str]) -> tuple[Instance, dict]:
    cfg = load_yaml("dataset.yaml")
    known = load_yaml("faults.yaml")
    unknown = [f for f in faults if f not in known]
    if unknown:
        raise ValueError(f"알 수 없는 결함: {unknown}")
    if faults:
        raise NotImplementedError("결함 주입은 M21-b에서 구현한다")

    weeks, hist = cfg["weeks"], cfg["history_weeks"]
    d = cfg["demand"]
    branches = {b: Branch(id=b, name=s["name"], warehouse_capacity=s["warehouse_capacity"])
                for b, s in cfg["branches"].items()}
    makers = {m: Maker(id=m, name=s["name"], supply_cap=s["supply_cap"]) for m, s in cfg["makers"].items()}
    models = {m: DeviceModel(id=m, name=s["name"], family=s["family"], maker=s["maker"], phase=s["phase"],
                             unit_cost=s["unit_cost"], launch_offset=s.get("launch_offset"),
                             eol_week=s.get("eol_week"))
              for m, s in cfg["models"].items()}

    history, actual, initial = {}, {}, {}
    for b, bs in cfg["branches"].items():
        for m, ms in cfg["models"].items():
            model, key = models[m], pair_key(b, m)
            base = ms["base"] * bs["demand_scale"]
            cv = d["cv"][model.family]
            rng = _rng(seed, "demand", key)
            series = [_draw(rng, level(model, base, t, d), cv) for t in range(1 - hist, weeks + 1)]
            history[key], actual[key] = series[:hist], series[hist:]
            lo, hi = d["initial_stock_weeks"]
            initial[key] = round(level(model, base, 1, d) * _rng(seed, "stock", key).uniform(lo, hi))

    inst = Instance(weeks=weeks, history_weeks=hist, branches=branches, makers=makers, models=models,
                    history=history, initial_stock=initial)
    inst.set_actual(actual)
    return inst, {"faults": {}}

"""가상 데이터 생성과 결함(P1~P4) 주입.

같은 seed면 같은 데이터가 나온다. 기본 데이터와 각 결함은 서로 다른 난수열을 쓰므로,
결함을 켜고 꺼도 나머지 데이터는 그대로다 (전후 비교가 공정해진다).
"""

import json
import math
import random
from pathlib import Path

import yaml

from core.registry import domain_file

from .models import Branch, Instance, Order, Worker, hhmm_to_min, inside_polygon

PACK_DIR = Path(__file__).resolve().parent
MEDIA = ["HFC", "FTTx", "CATV"]


def load_yaml(filename: str) -> dict:
    # params.yaml과 마찬가지로 프리셋 폴더(set_domain_files_root)가 있으면 그쪽을 먼저 쓴다.
    # 시연용 데이터 규모를 레포 기본값을 건드리지 않고 바꿀 수 있게 하기 위함.
    return yaml.safe_load(domain_file("dispatch", filename, PACK_DIR).read_text(encoding="utf-8"))


def _pick(rng: random.Random, weights: dict):
    keys = list(weights)
    return rng.choices(keys, weights=[weights[k] for k in keys])[0]


def load_region(cfg: dict) -> tuple[dict[str, Branch], dict]:
    """GeoJSON 관할 구역을 km 평면으로 옮긴다 (남서쪽 모서리 원점, 등장방형 근사: 수 km 범위라 오차 무시)."""
    geo = json.loads((PACK_DIR / cfg["region"]["geojson"]).read_text(encoding="utf-8"))
    rings = {f["properties"]["branch"]: f["geometry"]["coordinates"][0] for f in geo["features"]}
    lon0 = min(x for ring in rings.values() for x, _ in ring)
    lat0 = min(y for ring in rings.values() for _, y in ring)
    kx, ky = 111.32 * math.cos(math.radians(lat0)), 110.57
    branches = {}
    for b, spec in cfg["branches"].items():
        ring = rings[b][:-1] if rings[b][0] == rings[b][-1] else rings[b]
        branches[b] = Branch(name=spec["name"],
                             polygon=[(round((x - lon0) * kx, 3), round((y - lat0) * ky, 3)) for x, y in ring])
    return branches, {"origin": [lon0, lat0], "km_per_deg": [round(kx, 4), ky]}


def _sample_in(rng: random.Random, branches: dict[str, Branch], branch: str) -> tuple[float, float]:
    """지점 관할 구역 안의 균등 무작위 좌표 (기각 표집)."""
    polygon = branches[branch].polygon
    xs, ys = [p[0] for p in polygon], [p[1] for p in polygon]
    while True:
        x, y = rng.uniform(min(xs), max(xs)), rng.uniform(min(ys), max(ys))
        if inside_polygon(x, y, polygon):
            return round(x, 3), round(y, 3)


def _desired_slots(cfg: dict) -> tuple[list[int], list[float]]:
    step = cfg["desired_time"]["step_min"]
    slots, weights = [], []
    for hour, w in cfg["desired_time"]["hour_weights"].items():
        for minute in range(0, 60, step):
            slots.append(int(hour) * 60 + minute)
            weights.append(w)
    return slots, weights


def _make_workers(rng: random.Random, cfg: dict, branches: dict) -> list[Worker]:
    wcfg = cfg["workers"]
    start, end = (hhmm_to_min(t) for t in cfg["worker_availability"])
    workers = []
    for branch in branches:
        for i in range(cfg["workers_per_branch"]):
            skills = [m for m in MEDIA if rng.random() < wcfg["skill_prob"][m]]
            if not skills:
                skills = [rng.choice(MEDIA)]
            x, y = _sample_in(rng, branches, branch)
            workers.append(Worker(
                id=f"W{branch}{i + 1:02d}",
                branch=branch,
                skills=skills,
                certs=[],
                cei=rng.randint(*wcfg["cei_range"]),
                x=x,
                y=y,
                available=(start, end),
            ))
    # 자격은 지점별로 고르게 배분
    per_branch = cfg["workers_per_branch"]
    for cert, share in wcfg["cert_share"].items():
        n = round(per_branch * share)
        for branch in branches:
            members = [w for w in workers if w.branch == branch]
            for w in rng.sample(members, n):
                w.certs.append(cert)
    return workers


def _make_orders(rng: random.Random, cfg: dict, branches: dict) -> list[Order]:
    ocfg = cfg["orders"]
    slots, slot_weights = _desired_slots(cfg)
    orders = []
    for day in range(1, cfg["days"] + 1):
        for i in range(cfg["orders_per_day"]):
            branch = rng.choice(list(branches))
            x, y = _sample_in(rng, branches, branch)
            orders.append(Order(
                id=f"D{day:02d}-O{i + 1:03d}",
                day=day,
                branch=branch,
                work_type=_pick(rng, ocfg["work_type"]),
                media=_pick(rng, ocfg["media"]),
                difficulty=_pick(rng, ocfg["difficulty"]),
                building_type=_pick(rng, ocfg["building_type"]),
                desired=rng.choices(slots, weights=slot_weights)[0],
                x=x,
                y=y,
            ))
    return orders


# --- 결함 주입 ---------------------------------------------------------------
# 각 함수는 인스턴스를 제자리에서 바꾸고 (영향받은 항목 ID, 작업자 ID)를 돌려준다.

def _inject_p1(rng, inst: Instance, spec: dict, cfg: dict):
    g = spec["generation"]
    step = cfg["desired_time"]["step_min"]
    slots = [h * 60 + m for h in g["hours"] for m in range(0, 60, step)]
    affected = []
    for day in range(1, inst.days + 1):
        pool = [o for o in inst.orders if o.day == day and o.branch == g["branch"]]
        for o in rng.sample(pool, round(len(pool) * g["share_of_branch_daily"])):
            for key, value in g["work_filter"].items():
                setattr(o, key, value)
            o.desired = rng.choice(slots)
            affected.append(o.id)
    return affected, []


def _inject_p2(rng, inst: Instance, spec: dict, cfg: dict):
    g = spec["generation"]
    cert, target = g["cert"], g["concentrate_in_branch"]
    holders = [w for w in inst.workers if cert in w.certs]
    for w in holders:
        w.certs.remove(cert)
    n_target = round(len(holders) * g["share_in_branch"])
    in_target = [w for w in inst.workers if w.branch == target]
    others = [w for w in inst.workers if w.branch not in (target, g.get("starved_branch"))]
    chosen = rng.sample(in_target, min(n_target, len(in_target)))
    chosen += rng.sample(others, len(holders) - len(chosen))
    for w in chosen:
        w.certs.append(cert)
    affected_items = [o.id for o in inst.orders if o.difficulty == cert and o.branch != target]
    return affected_items, sorted(w.id for w in chosen)


def _inject_p3(rng, inst: Instance, spec: dict, cfg: dict):
    g = spec["generation"]
    window = tuple(hhmm_to_min(t) for t in g["availability"])
    chosen = rng.sample(inst.workers, round(len(inst.workers) * g["worker_share"]))
    for w in chosen:
        w.available = window
    return [], sorted(w.id for w in chosen)


def _inject_p4(rng, inst: Instance, spec: dict, cfg: dict):
    g = spec["generation"]
    d_lo, d_hi = g["boundary_distance_km"]
    affected = []
    for o in rng.sample(inst.orders, round(len(inst.orders) * g["share_of_orders"])):
        # 이웃 지점과 맞닿은 경계의 한 점에서 바깥쪽으로 d_lo~d_hi km 옮긴다 (관할 경계 너머 수요).
        # 옮긴 곳이 이웃 지점 구역 안이고 실제 관할 밖 거리가 범위 안일 때만 받아들인다.
        edges = inst.shared_edges(o.branch)
        neighbors = [b for b in inst.branches if b != o.branch]
        while True:
            (x1, y1), (x2, y2) = rng.choices(edges, weights=[math.dist(*e) for e in edges])[0]
            t, d = rng.random(), rng.uniform(d_lo, d_hi)
            px, py = x1 + t * (x2 - x1), y1 + t * (y2 - y1)
            nx, ny = (y2 - y1) / math.dist((x1, y1), (x2, y2)), -(x2 - x1) / math.dist((x1, y1), (x2, y2))
            if inst.contains(o.branch, px + nx * 0.05, py + ny * 0.05):
                nx, ny = -nx, -ny                                      # 법선이 관할 안쪽을 향하면 뒤집는다
            x, y = round(px + nx * d, 3), round(py + ny * d, 3)
            if (any(inst.contains(b, x, y) for b in neighbors)
                    and d_lo <= inst.distance_outside(o.branch, x, y) <= d_hi):
                break
        o.x, o.y = x, y
        affected.append(o.id)
    return affected, []


INJECTORS = {"P1": _inject_p1, "P2": _inject_p2, "P3": _inject_p3, "P4": _inject_p4}


def generate(seed: int, faults: list[str]) -> tuple[Instance, dict]:
    cfg = load_yaml("dataset.yaml")
    fault_specs = load_yaml("faults.yaml")
    unknown = set(faults) - set(fault_specs)
    if unknown:
        raise ValueError(f"unknown faults: {sorted(unknown)}")

    branches, geo = load_region(cfg)
    rng = random.Random(seed)
    workers = _make_workers(rng, cfg, branches)
    orders = _make_orders(rng, cfg, branches)
    inst = Instance(branches=branches, boundary_zone_km=cfg["boundary_zone_km"],
                    workers=workers, orders=orders, days=cfg["days"], geo=geo)

    truth = {"seed": seed, "faults": {}}
    for fid in sorted(faults):
        spec = fault_specs[fid]
        items, worker_ids = INJECTORS[fid](random.Random(f"{seed}-{fid}"), inst, spec, cfg)
        truth["faults"][fid] = {
            "name": spec["name"],
            "expected": spec["expected"],
            "answer": spec["answer"],
            "affected_items": sorted(items),
            "affected_workers": worker_ids,
        }
    return inst, truth

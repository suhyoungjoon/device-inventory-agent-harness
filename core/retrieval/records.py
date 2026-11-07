"""기록 → 조각: 과거 회차 사례(결정된 개선안)와 현장 의견. 저장소 형식을 직접 읽지 않고 사전만 받는다."""

import hashlib
import json

from .index import Chunk


def _change_paths(body: dict) -> list[str]:
    paths = [str(c.get("path", "")) for c in body.get("params_changes") or []]
    paths += [str(p) for r in body.get("override_rules") or [] for p in (r.get("set") or {})]
    return sorted({p.split("[")[0] for p in paths if p})


def case_chunk(proposal: dict, findings: list[dict], primary: list[str], params_version=None) -> Chunk:
    """결정된 개선안 하나 = 사례 하나: 발견 → 개선안 → 미리 돌려보기 → 승인·반려 사유.
    proposal: {id, status, kind, body, simulation, decision}."""
    body, sim, dec = proposal.get("body") or {}, proposal.get("simulation") or {}, proposal.get("decision") or {}
    targets = [f for f in findings if f.get("id") in (body.get("target_findings") or [])]
    before, after = sim.get("before") or {}, sim.get("after") or {}
    effect = ", ".join(f"{k} {before[k]:.4g}→{after[k]:.4g}" for k in primary if k in before and k in after)
    word = ("승인" if proposal.get("status") == "approved"
            else "의견" if dec.get("action") == "opinion" else "반려")   # 의견: 회차 루프에서 의견을 남겨 다시 제안받은 안 (M22)
    text = (f"발견: {'; '.join(f.get('title', '') for f in targets) or '-'}. "
            f"개선안: {body.get('title', '')} ({body.get('rationale', '')}). "
            f"미리 돌려보기: {effect or '-'}. 결정: {word}" + (f" — {dec['note']}" if dec.get("note") else "") + ".")
    dims: dict = {}
    for f in targets:
        for k, v in (f.get("slice") or {}).items():
            dims.setdefault(k, [])
            dims[k] = sorted(set(dims[k]) | set(v if isinstance(v, list) else [v]))
    meta = {"status": proposal.get("status"), "params": _change_paths(body), "dims": dims,
            "params_version": params_version}
    return Chunk(f"case-{str(proposal['id'])[-8:]}", "case", f"[{word}] {body.get('title', '')}", text,
                 {k: v for k, v in meta.items() if v not in (None, [], {})}, f"proposal:{proposal['id']}")


def opinion_chunk(opinion: str, constraints: list[dict], proposal_title: str = "", change: str = "",
                  params_version=None, salt: str = "") -> Chunk:
    """현장 의견 한 줄과 정리한 제약. 같은 의견·같은 제약이면 같은 id (중복 저장하지 않는다)."""
    digest = hashlib.sha256(json.dumps([opinion, constraints, salt], ensure_ascii=False, sort_keys=True).encode())
    paths = sorted({str(c.get("path", "")).split("[")[0] for c in constraints if c.get("path")})
    text = (f"의견: {opinion}. 대상 제안: {proposal_title or '-'} ({change or '-'}). "
            f"정리한 제약: {json.dumps(constraints, ensure_ascii=False)}.")
    meta = {"params": paths, "params_version": params_version}
    return Chunk(f"op-{digest.hexdigest()[:8]}", "opinion", opinion[:60], text,
                 {k: v for k, v in meta.items() if v not in (None, [])}, "opinion")

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { DataFocus, DomainAdapter, DomainData, MetricSpec } from "../domains/types";
import { CORE_REASON_NAMES, TERMS, tip, type TermKey } from "../terms";
import type { ChangeCard, Dataset, DomainDefinition, DomainFault, ParamKind, Sensitivity, SensitivityRow } from "../types";
import { fmtMetric } from "./MetricsPanel";
import SidePanel, { SideGroup } from "./SidePanel";
import { adapters } from "../domains";

type Section = "overview" | "params" | "rules" | "spec" | "data" | "faults";
const SECTIONS: { id: Section; label: string; term?: TermKey }[] = [
  { id: "overview", label: "개요" },
  { id: "params", label: TERMS.params.label, term: "params" },
  { id: "rules", label: `${TERMS.violationRules.label}·${TERMS.reasons.label}·${TERMS.dimensions.label}` },
  { id: "spec", label: TERMS.spec.label, term: "spec" },
  { id: "data", label: "데이터" },
  { id: "faults", label: TERMS.faults.label, term: "faults" },
];
const META = new Set(["bounds", "docs", "kinds"]);

/** 도메인 탭 (읽기 전용): 규칙 agent가 판단에 쓰는 데이터와 룰을 보여준다. 도메인과 무관한 파일 계약만 읽는다. */
export default function DomainPanel({
  domainName,
  adapter,
  dataset,
  busy,
  onGenerate,
}: {
  domainName: string;
  adapter: DomainAdapter;
  dataset: Dataset | null;
  busy: string | null;
  onGenerate: () => void;
}) {
  const [section, setSection] = useState<Section>("overview");
  const [def, setDef] = useState<DomainDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.definition(domainName).then(setDef).catch((e) => setError(String(e)));
  }, [domainName]);

  if (error) return <section className="panel"><p className="critical-text">✕ {error}</p></section>;
  if (!def) return <section className="panel"><p className="muted">불러오는 중…</p></section>;

  return (
    <section className="domain">
      <SidePanel>
      <SideGroup title="지금 데이터">
        <span>{dataset ? `${dataset.id} · ${dataset.items}건` : "아직 없음 (데이터 보기에서 생성)"}</span>
      </SideGroup>
      <SideGroup title="보기">
        <nav className="side-nav" role="tablist" aria-label="규칙·데이터 섹션" aria-orientation="vertical">
          {SECTIONS.map((s) => (
            <button key={s.id} role="tab" aria-selected={section === s.id} className={section === s.id ? "selected" : undefined}
              onClick={() => setSection(s.id)} title={s.term ? tip(s.term) : undefined}>
              {s.label}
            </button>
          ))}
        </nav>
        <span className="muted small">읽기 전용 · 규칙은 개선 제안 탭에서 제안을 승인해야만 바뀝니다</span>
      </SideGroup>
      </SidePanel>
      {section === "overview" && <Overview def={def} dataset={dataset} busy={busy} onGenerate={onGenerate} />}
      {section === "params" && <Params def={def} domainName={domainName} datasetId={dataset?.id ?? null} metrics={adapter.metrics} />}
      {section === "rules" && <Rules def={def} adapter={adapter} />}
      {section === "spec" && <Spec def={def} />}
      {section === "data" && (
        adapter.data ? <DataTables data={adapter.data} dataset={dataset} busy={busy} onGenerate={onGenerate} />
          : <p className="muted empty">이 업무는 데이터 표를 제공하지 않습니다.</p>
      )}
      {section === "faults" && <Faults domainName={domainName} faults={def.faults} />}
    </section>
  );
}

// --- 개요 -----------------------------------------------------------------------

function Overview({ def, dataset, busy, onGenerate }: {
  def: DomainDefinition; dataset: Dataset | null; busy: string | null; onGenerate: () => void;
}) {
  const sections = Object.keys(def.params).filter((k) => k !== "version" && k !== "overrides");
  const rules = ((def.params.overrides as { rules?: unknown[] } | undefined)?.rules ?? []).length;
  return (
    <div className="domain-grid">
      <div className="panel">
        <h2 title={tip("domain")}>{TERMS.domain.label}: {adapters[def.domain]?.title ?? def.domain}</h2>
        <div className="tiles">
          <Tile label={`${TERMS.params.label} 버전`} value={`v${String(def.params.version)}`}
            note={`묶음 ${sections.length}개 · ${TERMS.overrides.label} ${rules}개`} tech={tip("params")} />
          <Tile label={TERMS.violationRules.label} value={`${Object.keys(def.dimensions.violation_rules).length}개`} note="자동 검사로 판정"
            tech={tip("violationRules")} />
          <Tile label={TERMS.dimensions.label} value={`${Object.keys(def.dimensions.dimensions).length}개`}
            note={`${TERMS.reasons.label} ${Object.keys(def.dimensions.reason_codes).length}개`} tech={tip("dimensions")} />
          <Tile label={TERMS.faults.label} value={`${def.faults.length}개`} note="데이터에 일부러 심는 문제" tech={tip("faults")} />
        </div>
        <p className="muted small">
          {TERMS.rule.label}은 아래 파일을 읽어 동작하고, {TERMS.ai.label}은 같은 규칙을 문장으로 옮긴 {TERMS.spec.label}를 받습니다(L1 이상).
          개선 제안이 바꾸는 대상은 {TERMS.params.label}과 {TERMS.spec.label} 두 파일입니다.
        </p>
      </div>
      <div className="panel">
        <h2>파일</h2>
        <table className="kv-table">
          <tbody>
            {Object.entries(def.files).map(([name, path]) => (
              <tr key={name}><th>{name}</th><td><code>{path}</code></td><td className="muted small">{FILE_ROLE[name] ?? ""}</td></tr>
            ))}
          </tbody>
        </table>
        <h2 className="spaced">현재 데이터</h2>
        {dataset ? (
          <p>
            {dataset.id} · {dataset.items}건 · {TERMS.seed.label} {dataset.seed} · {TERMS.faults.label} {dataset.faults.join(", ") || "없음"}
          </p>
        ) : (
          <p className="muted">
            데이터가 아직 없습니다.{" "}
            <button onClick={onGenerate} disabled={!!busy}>기본 데이터 생성 (비교 탭 설정)</button>
          </p>
        )}
      </div>
    </div>
  );
}

const FILE_ROLE: Record<string, string> = {
  "params.yaml": `${TERMS.params.label} (값·${TERMS.bounds.label}·설명·${TERMS.overrides.label})`,
  "domain-spec.md": `${TERMS.ai.label}이 읽는 ${TERMS.spec.label} (L1 이상)`,
  "dimensions.yaml": `${TERMS.dimensions.label}·${TERMS.reasons.label}·${TERMS.violationRules.label}`,
  "faults.yaml": `${TERMS.faults.label}와 정답 (채점용)`,
};

function Tile({ label, value, note, tech }: { label: string; value: string; note?: string; tech?: string }) {
  return (
    <div className="tile">
      <div className="tile-label" title={tech}>{label}</div>
      <div className="tile-value">{value}</div>
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

// --- 규칙 파라미터 ----------------------------------------------------------------

function show(value: unknown): string {
  if (typeof value === "boolean") return value ? "켬" : "끔";
  if (Array.isArray(value)) return `[${value.map(show).join(", ")}]`;
  if (value && typeof value === "object") return Object.entries(value).map(([k, v]) => `${k} ${show(v)}`).join(" · ");
  return String(value);
}

const KIND_INFO: Record<ParamKind, { label: string; tip: string }> = {
  policy: { label: "정책", tip: "정책 손잡이. AI 개선안이 허용 범위 안에서 바꿀 수 있다" },
  estimate: { label: "추정값", tip: "현실 추정값. 실적 근거가 있을 때 사람이 바꾼다. 개선안이 바꾸면 가정만 바뀌어 적용 불가" },
  fixed: { label: "고정", tip: "고정값. 바꾸지 않는다" },
  governance: { label: "통제", tip: "승인 조건 같은 통제 설정. AI가 자기 가드레일을 풀 수 없게 개선안으로 바꿀 수 없다" },
};

// 민감도 한 칸: 허용 범위 안에서 값을 바꿨을 때 지표의 최소~최대 (건수). 폭이 0이면 의미 없는 손잡이
function SpreadCell({ rows, path, metric, spec }: { rows: SensitivityRow[]; path: string; metric: string; spec?: MetricSpec }) {
  const own = rows.filter((r) => r.path === path || r.path.startsWith(`${path}[`));
  if (!own.length) return <td className="muted">–</td>;
  return (
    <td className="num-cell wrap small">
      {own.map((r) => {
        const range = r.ranges[metric];
        if (!range) return null;
        const lo = spec?.format === "pct" ? Math.round(range.min * r.items) : range.min;
        const hi = spec?.format === "pct" ? Math.round(range.max * r.items) : range.max;
        const idx = r.path.slice(path.length);
        return (
          <div key={r.path} title={`${r.path}: 허용 범위 ${r.bounds[0]}~${r.bounds[1]}를 ${r.values.length}단계로`}>
            {idx && <span className="muted">{idx} </span>}
            {lo === hi ? <span className="muted">변화 없음</span> : `${lo.toLocaleString()} ~ ${hi.toLocaleString()}`}
            {lo !== hi && r.flat_around_current && (
              <span className="muted" title="현재 값을 포함한 이 구간에서는 값을 바꿔도 결과가 같습니다"> ({r.flat_around_current[0]}~{r.flat_around_current[1]} 변화 없음)</span>
            )}
          </div>
        );
      })}
    </td>
  );
}

const shown = (v: unknown) => (v === null || v === undefined ? "기록 없음" : JSON.stringify(v));

// 변경 이력 카드 (M13-E): 승인으로 규칙 버전이 오를 때마다 하나
function ChangeCardView({ card: c, metrics }: { card: ChangeCard; metrics: MetricSpec[] }) {
  const primary = metrics.filter((m) => m.primary || m.key === "on_time_rate").slice(0, 3);
  return (
    <article className="change-card">
      <h3>v{c.version_before ?? "?"} → v{c.version_after} · {c.title ?? c.proposal_id}</h3>
      <div className="small">
        {c.changes.map((ch) => <div key={ch.path}><code>{ch.path}</code>: {shown(ch.before)} → {JSON.stringify(ch.after)}</div>)}
        {c.override_rules.map((r, i) => (
          <div key={i}>
            {TERMS.overrides.label} <code>{JSON.stringify(r.when)}</code> 이면{" "}
            {Object.entries(r.set).map(([p, v]) => <span key={p}><code>{p}</code>: {r.before ? shown(r.before[p]) : "기록 없음"} → {JSON.stringify(v)} </span>)}
          </div>
        ))}
        {c.metrics_before && c.metrics_after && (
          <div className="muted">
            {primary.map((m) => `${m.label} ${fmtMetric(c.metrics_before![m.key], m.format)} → ${fmtMetric(c.metrics_after![m.key], m.format)}`).join(" · ")}
            {c.violations_after != null && ` · 규칙 위반 ${c.violations_after}건`}
          </div>
        )}
        <div className="muted">
          근거 {c.findings.length ? c.findings.map((f) => `${f.id} ${f.title ?? ""}`).join(", ") : "–"} · 승인자 {c.approver ?? "기록 없음"}
          {c.forced && " · 강제 승인"}{c.at ? ` · ${new Date(c.at * 1000).toLocaleString()}` : ""}
        </div>
        {c.note && <div>사유: {c.note}</div>}
      </div>
    </article>
  );
}

function Params({ def, domainName, datasetId, metrics }: {
  def: DomainDefinition; domainName: string; datasetId: string | null; metrics: MetricSpec[];
}) {
  const overrides = (def.params.overrides ?? {}) as { allowed_sections?: string[]; rules?: { when: Record<string, unknown>; set: Record<string, unknown> }[] };
  const sections = Object.entries(def.params).filter(([k]) => k !== "version" && k !== "overrides") as [string, Record<string, unknown>][];
  const [sens, setSens] = useState<Sensitivity | null>(null);
  const [sensError, setSensError] = useState<string | null>(null);
  const [cards, setCards] = useState<ChangeCard[]>([]);
  useEffect(() => {
    api.paramsHistory(domainName).then(setCards).catch(() => undefined);
  }, [domainName]);
  const version = String(def.params.version);
  useEffect(() => {
    if (!datasetId) return;
    let current = true;           // 데이터·규칙 버전이 바뀐 뒤 늦게 온 옛 응답은 버린다
    setSens(null);
    setSensError(null);
    api.sensitivity(datasetId).then((r) => current && setSens(r)).catch((e) => current && setSensError(String(e)));
    return () => { current = false; };
  }, [datasetId, version]);
  const sensMetrics = (sens?.metrics ?? []).map((k) => metrics.find((m) => m.key === k)).filter(Boolean) as MetricSpec[];
  return (
    <div className="domain-stack">
      <p className="muted small">
        <code>{def.files["params.yaml"]}</code> · 버전 v{String(def.params.version)}. AI 개선 제안은 <strong>정책</strong> 파라미터만 {TERMS.bounds.label} 안에서
        바꿀 수 있습니다. 추정값·고정·통제 파라미터와 {TERMS.bounds.label}·설명·분류는 바꿀 수 없습니다.
      </p>
      <p className="muted small">
        {datasetId
          ? sens
            ? <>민감도: 지금 데이터({sens.rows[0]?.items.toLocaleString() ?? "–"}건)로 정책 파라미터를 허용 범위 안에서 {sens.steps}단계로 바꿔 규칙 방식으로 돌린 결과입니다 (AI 비용 0, {sens.seconds.toFixed(1)}초). "변화 없음"은 움직여도 결과가 같은 손잡이입니다.</>
            : sensError ? <span className="critical-text">✕ 민감도 계산 실패: {sensError}</span> : "민감도 계산 중… (규칙 방식으로 수십 번 돌립니다, AI 비용 0)"
          : "비교 탭에서 데이터를 만들면 파라미터마다 결과가 얼마나 움직이는지(민감도)도 함께 보입니다."}
      </p>
      {sections.map(([name, section]) => {
        const bounds = (section.bounds ?? {}) as Record<string, [number, number]>;
        const docs = (section.docs ?? {}) as Record<string, string>;
        const kinds = (section.kinds ?? {}) as Record<string, ParamKind>;
        return (
          <div key={name} className="panel">
            <h2><code>{name}</code></h2>
            <div className="table-scroll">
            <table className="param-table">
              <thead><tr><th>항목</th><th title="AI 개선안이 바꿀 수 있는지">분류</th><th>현재 값</th><th title={tip("bounds")}>{TERMS.bounds.label}</th>
                {sensMetrics.map((m) => <th key={m.key} title={`${m.label} × 전체 건수의 최소~최대`}>{m.label} 범위</th>)}<th>설명</th></tr></thead>
              <tbody>
                {Object.entries(section).filter(([k]) => !META.has(k)).map(([key, value]) => {
                  const b = bounds[key];
                  const kind = kinds[key] ?? "policy";
                  return (
                    <tr key={key}>
                      <td><code>{key}</code></td>
                      <td><span className={`kind-badge kind-${kind}`} title={KIND_INFO[kind].tip}>{KIND_INFO[kind].label}</span></td>
                      <td className="num-cell wrap">{show(value)}</td>
                      <td className="muted">{b ? (b[0] === b[1] ? `고정 ${b[0]}` : `${b[0]} ~ ${b[1]}`) : "–"}</td>
                      {sensMetrics.map((m) => <SpreadCell key={m.key} rows={sens!.rows} path={`${name}.${key}`} metric={m.key} spec={m} />)}
                      <td>{docs[key] ?? <span className="muted">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        );
      })}
      <div className="panel">
        <h2 title={tip("overrides")}>{TERMS.overrides.label}</h2>
        <p className="muted small">
          조건에 해당하는 지시서에만 값을 바꿔 적용합니다. 이렇게 바꿀 수 있는 묶음: {(overrides.allowed_sections ?? []).join(", ") || "없음"}
        </p>
        {(overrides.rules ?? []).length ? (
          <table className="param-table">
            <thead><tr><th>#</th><th title="원래 용어: when">조건</th><th title="원래 용어: set">바꿀 값</th></tr></thead>
            <tbody>
              {overrides.rules!.map((r, i) => (
                <tr key={i}><td>{i + 1}</td><td><code>{JSON.stringify(r.when)}</code></td><td><code>{JSON.stringify(r.set)}</code></td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">없음</p>}
      </div>
      <div className="panel">
        <h2>변경 이력</h2>
        {cards.length ? cards.map((c) => <ChangeCardView key={c.proposal_id} card={c} metrics={metrics} />)
          : <p className="muted">승인된 {TERMS.params.label} 변경이 아직 없습니다.</p>}
      </div>
    </div>
  );
}

// --- 필수조건·사유코드·차원 -------------------------------------------------------------

// 사유: 쉬운 이름이 있으면 "이름 — 설명", 코어 사유는 화면용 이름만 (서버 설명에 기술 용어가 있어서)
function reasonText(code: string, text: string, names?: Record<string, string>) {
  if (code in CORE_REASON_NAMES) return CORE_REASON_NAMES[code];
  return names?.[code] ? `${names[code]} — ${text}` : text;
}

function Rules({ def, adapter }: { def: DomainDefinition; adapter: DomainAdapter }) {
  const d = def.dimensions;
  return (
    <div className="domain-grid">
      <div className="panel">
        <h2 title={tip("violationRules")}>{TERMS.violationRules.label}</h2>
        <p className="muted small" title="원래 용어: 도메인 팩의 validate()">하나라도 어기면 배정이 무효입니다. 판정은 업무별 검사 한 곳에서만 합니다.</p>
        <KV rows={Object.entries(d.violation_rules)} />
      </div>
      <div className="panel">
        <h2 title={tip("reasons")}>{TERMS.reasons.label}</h2>
        <KV rows={[
          ...Object.entries(d.reason_codes).map(([k, v]) => [k, reasonText(k, v, adapter.reasonNames)] as [string, string]),
          ...Object.entries(def.core_reason_codes).filter(([k]) => !(k in d.reason_codes))
            .map(([k, v]) => [k, `${reasonText(k, v, adapter.reasonNames)} (공통)`] as [string, string]),
        ]} />
      </div>
      <div className="panel wide">
        <h2 title={tip("dimensions")}>{TERMS.dimensions.label}</h2>
        <p className="muted small">
          결과를 나눠서 집계하는 기준입니다. {TERMS.aiAnalysis.label}이 찾은 문제의 조건과, 특정 조건에만 적용하는 규칙의 조건이 이 기준으로 표현됩니다.
        </p>
        <table className="param-table">
          <thead><tr><th>코드</th><th>이름</th><th>값</th></tr></thead>
          <tbody>
            {Object.entries(d.dimensions).map(([k, v]) => (
              <tr key={k}><td><code>{k}</code></td><td>{v.label}</td><td>{v.values?.join(", ") ?? v.format ?? "–"}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KV({ rows }: { rows: [string, string][] }) {
  return (
    <table className="kv-table">
      <tbody>{rows.map(([k, v]) => <tr key={k}><th><code>{k}</code></th><td>{v}</td></tr>)}</tbody>
    </table>
  );
}

// --- 명세 -----------------------------------------------------------------------

function Spec({ def }: { def: DomainDefinition }) {
  return (
    <div className="domain-stack">
      <p className="muted small">
        <code>{def.files["domain-spec.md"]}</code> · 하네스 L1 이상에서 {TERMS.ai.label}에게 이 문장이 그대로 전달됩니다.
        숫자는 문장에 적지 않고 {TERMS.params.label}의 항목 이름으로 가리킵니다. 이 문서를 고치는 제안은 아래 부분(절) 단위로 바꿉니다.
      </p>
      {Object.entries(def.spec_sections).map(([title, text], i) => (
        <details key={title} className="panel spec-section" open={i === 0}>
          <summary><strong>{title}</strong></summary>
          <div className="spec-text">{text}</div>
        </details>
      ))}
    </div>
  );
}

// --- 데이터 ----------------------------------------------------------------------

type Row = Record<string, unknown>;
const PAGE = 100;

function rowsOf(instance: unknown, key: string, idField: string): Row[] {
  const value = (instance as Record<string, unknown> | null)?.[key];
  if (Array.isArray(value)) return value as Row[];
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, Row>).map(([id, r]) => ({ [idField]: id, ...r }));
  }
  return [];
}

function DataTables({ data, dataset, busy, onGenerate }: {
  data: DomainData; dataset: Dataset | null; busy: string | null; onGenerate: () => void;
}) {
  const [tableKey, setTableKey] = useState(data.tables[0]?.key ?? "");
  const table = data.tables.find((t) => t.key === tableKey) ?? data.tables[0];
  const [focus, setFocus] = useState<DataFocus | null>(null);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ field: string; desc: boolean } | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const rows = useMemo(() => (dataset && table ? rowsOf(dataset.instance, table.key, table.idField) : []), [dataset, table]);
  const fields = useMemo(() => {
    const keys = new Set<string>();
    rows.slice(0, 50).forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
    return [...keys].filter((k) => !(data.hidden ?? []).includes(k));
  }, [rows, data.hidden]);
  // 값 종류가 적은 필드는 드롭다운 필터로
  const facets = useMemo(() => fields.flatMap((f) => {
    const values = [...new Set(rows.map((r) => r[f]).filter((v) => typeof v === "string" || typeof v === "number").map(String))];
    const useful = values.length > 1 && values.length <= 12 && values.length < rows.length;  // 행마다 다른 값(ID 등)은 제외
    return useful ? [{ field: f, values: values.sort((a, b) => a.localeCompare(b, "ko", { numeric: true })) }] : [];
  }), [fields, rows]);

  const cell = (field: string, value: unknown) => {
    const custom = table && data.format?.(table.key, field, value);
    if (custom !== undefined) return custom;
    if (Array.isArray(value)) return value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(", ");
    if (value && typeof value === "object") return JSON.stringify(value);
    if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
    return value == null ? "" : String(value);
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows.filter((r) => Object.entries(filters).every(([f, v]) => !v || String(r[f]) === v));
    if (q) out = out.filter((r) => fields.some((f) => cell(f, r[f]).toLowerCase().includes(q)));
    if (sort) {
      out = [...out].sort((a, b) => {
        const x = a[sort.field], y = b[sort.field];
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "ko", { numeric: true });
        return sort.desc ? -c : c;
      });
    }
    return out;
  }, [rows, filters, query, sort, fields]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!dataset) {
    return (
      <p className="muted empty">
        데이터가 아직 없습니다. <button onClick={onGenerate} disabled={!!busy}>기본 데이터 생성 (비교 탭 설정)</button>
      </p>
    );
  }
  const View = data.View;
  const switchTable = (key: string) => {
    setTableKey(key); setFilters({}); setQuery(""); setSort(null); setLimit(PAGE);
  };

  return (
    <div className={View ? "analysis-split" : undefined}>
      <div className="panel data-panel">
        <div className="controls">
          <div className="chips" role="radiogroup" aria-label="데이터 표">
            {data.tables.map((t) => (
              <button key={t.key} role="radio" aria-checked={t.key === table?.key} className={t.key === table?.key ? "selected" : undefined}
                onClick={() => switchTable(t.key)}>
                {t.label} ({rowsOf(dataset.instance, t.key, t.idField).length})
              </button>
            ))}
          </div>
          <input className="search" placeholder="검색" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
        </div>
        {facets.length > 0 && (
          <div className="controls facets">
            {facets.map(({ field, values }) => (
              <label key={field} className="small" title={field}>
                {data.fieldLabels?.[field] ?? field}{" "}
                <select value={filters[field] ?? ""} onChange={(e) => { setFilters((f) => ({ ...f, [field]: e.target.value })); setLimit(PAGE); }}>
                  <option value="">전체</option>
                  {values.map((v) => <option key={v} value={v}>{table ? cell(field, rows.find((r) => String(r[field]) === v)?.[field]) : v}</option>)}
                </select>
              </label>
            ))}
            <span className="muted small">{shown.length}건</span>
          </div>
        )}
        <div className="table-scroll data-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f} onClick={() => setSort((s) => (s?.field === f ? { field: f, desc: !s.desc } : { field: f, desc: false }))}
                    aria-sort={sort?.field === f ? (sort.desc ? "descending" : "ascending") : undefined} title={f}>
                    {data.fieldLabels?.[f] ?? f}{sort?.field === f ? (sort.desc ? " ▼" : " ▲") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((r) => {
                const id = String(r[table!.idField]);
                const on = focus?.table === table!.key && focus.id === id;
                return (
                  <tr key={id} className={on ? "selected" : undefined} onClick={() => setFocus(on ? null : { table: table!.key, id })}>
                    {fields.map((f) => <td key={f}>{cell(f, r[f])}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {shown.length > limit && <button onClick={() => setLimit((l) => l + PAGE)}>더 보기 ({shown.length - limit}건 남음)</button>}
      </div>
      {View && (
        <div className="panel map-side">
          <h2>{focus ? `${data.tables.find((t) => t.key === focus.table)?.label ?? focus.table} ${focus.id}` : "데이터 지도"}</h2>
          <View instance={dataset.instance} focus={focus} />
          <p className="muted small">표에서 행을 누르면 지도에서 위치를 강조합니다. 배정 결과는 비교 탭에서 봅니다.</p>
        </div>
      )}
    </div>
  );
}

// --- 결함 패턴 -------------------------------------------------------------------

function Faults({ domainName, faults }: { domainName: string; faults: DomainFault[] }) {
  const [full, setFull] = useState<DomainFault[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reveal = () => api.definition(domainName, true).then((d) => setFull(d.faults)).catch((e) => setError(String(e)));
  const shown = full ?? faults;
  return (
    <div className="domain-stack">
      <div className="controls">
        <p className="muted small">
          가상 데이터에 일부러 심는 문제입니다. {TERMS.aiAnalysis.label}은 이 정답을 보지 못하며, 정답은 분석 결과를 채점할 때만 씁니다.
        </p>
        {full ? (
          <button onClick={() => setFull(null)}>정답 가리기</button>
        ) : (
          <button onClick={reveal} title="발표 중 분석 장면 전에는 열지 마세요">정답 보기 (심는 방법·채점 기준)</button>
        )}
        {error && <span className="critical-text">✕ {error}</span>}
      </div>
      {shown.map((f) => (
        <div key={f.id} className="panel">
          <h2><span className="finding-id">{f.id}</span> {f.name}</h2>
          {f.expected && <p>결과에 나타날 현상: {f.expected}</p>}
          {full && (
            <div className="spec-compare">
              <div><div className="tile-label" title="원래 용어: generation">심는 방법</div><pre>{yamlish(f.generation)}</pre></div>
              <div><div className="tile-label" title="원래 용어: answer">채점 기준</div><pre>{yamlish(f.answer)}</pre></div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function yamlish(value: unknown, indent = ""): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).map(([k, v]) => (v && typeof v === "object" && !Array.isArray(v)
      ? `${indent}${k}:\n${yamlish(v, indent + "  ")}` : `${indent}${k}: ${show(v)}`)).join("\n");
  }
  return `${indent}${show(value)}`;
}

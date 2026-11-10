import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { DomainAdapter } from "../domains/types";
import type { Dataset, DecisionRecord, Dimensions, DomainInfo, Finding, FindingLabel, Report, Run, ToolCall } from "../types";
import { fmtCost, fmtSeconds } from "./MetricsPanel";
import { usePoll } from "./usePoll";
import { TERMS, tip } from "../terms";
import Details from "./Details";
import SidePanel, { SideGroup } from "./SidePanel";
import { findingItems, findingSummary, makePlain, type Plain } from "./plainFinding";

export default function AnalysisPanel({
  domain,
  adapter,
  reasonLabels,
  reasonDetails = {},
  dataset,
  runs,
  decisionsOf,
  loadDecisions,
  onRunFullRule,
  reportId,
  setReportId,
}: {
  domain: DomainInfo;
  adapter: DomainAdapter;
  reasonLabels: Record<string, string>;
  reasonDetails?: Record<string, string>;
  dataset: Dataset | null;
  runs: Run[];
  decisionsOf: (runId: string) => DecisionRecord[] | undefined;
  loadDecisions: (runId: string) => Promise<void>;
  onRunFullRule: () => Promise<void>;
  reportId: string | null;
  setReportId: (id: string) => void;
}) {
  const done = runs.filter((r) => r.status === "done");
  const defaultRun = done.find((r) => r.agent === "rule" && !r.scope) ?? done[0];
  const [runId, setRunId] = useState<string | null>(null);
  const run = done.find((r) => r.run_id === runId) ?? defaultRun;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [byPerspective, setByPerspective] = useState(false);
  const polled = usePoll<Report>(reportId ? () => api.report(reportId) : null, (r) => r.status !== "running", [reportId]);
  const report = polled?.id === reportId ? polled : null;
  const [labelled, setLabelled] = useState<Report | null>(null);
  const current = labelled?.id === report?.id && labelled ? labelled : report;

  const analyzedRun = runs.find((r) => r.run_id === current?.run_id);
  const decisions = (current && decisionsOf(current.run_id)) || [];
  useEffect(() => {
    if (current?.run_id && !decisionsOf(current.run_id)) loadDecisions(current.run_id).catch(() => undefined);
  }, [current?.run_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const findings = current?.body?.findings ?? [];
  const focused = findings.find((f) => f.id === focus) ?? null;
  const resourceSpecs = domain.dimensions.resources ?? {};
  const idFieldOf = (f: Finding) => (f.resources ? resourceSpecs[f.resources.kind]?.id_field : undefined);
  // 자원 발견이면 그 자원이 맡은 항목, 구간도 있으면 둘 다 만족하는 항목
  const highlight = useMemo(
    () => (focused ? findingItems(focused, decisions, idFieldOf(focused))?.map((d) => d.item_id) ?? null : null),
    [focused, decisions], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const dimensionLabels = useMemo(
    () => Object.fromEntries(Object.entries(domain.dimensions.dimensions).map(([k, v]) => [k, v.label])), [domain]);
  // 쉽게 읽기: AI 문장 속 코드(사유·조건 값·차원 이름) → 화면 이름, 소수 비율 → %, 업무 용어에 설명
  const plain = useMemo(
    () => makePlain(adapter, dataset?.instance, { ...dimensionLabels, ...(adapter.valueNames ?? {}), ...reasonLabels }),
    [adapter, dataset?.instance, dimensionLabels, reasonLabels]);
  const summaryOf = (f: Finding) => {
    const rows = findingItems(f, decisions, idFieldOf(f));
    if (!rows) return null;
    const where = f.slice ? (adapter.sliceText?.(f.slice, dataset?.instance)
      ?? Object.values(f.slice).map((vs) => vs.map((v) => adapter.valueNames?.[String(v)] ?? v).join("·")).join(" · ")) : "";
    const who = f.resources ? `${resourceSpecs[f.resources.kind]?.label ?? f.resources.kind} ${f.resources.ids.join(", ")}` : "";
    return findingSummary(rows, decisions, [where, who].filter(Boolean).join(" · "), reasonLabels);
  };

  const guard = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!dataset) {
    return <section className="panel"><p className="muted empty">비교 탭에서 데이터를 먼저 생성하세요.</p></section>;
  }

  return (
    <section className="analysis">
      <SidePanel>
      <SideGroup title="지금 보는 것">
        <label className="stack">
          분석할 결과{" "}
          <select value={run?.run_id ?? ""} onChange={(e) => setRunId(e.target.value)} disabled={!!busy}>
            {done.length === 0 && <option value="">(실행 없음)</option>}
            {done.map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {r.agent === "rule" ? TERMS.rule.label : `AI ${r.level}`} · {r.scope ? `${r.scope.length}건` : "전체"} · {r.run_id}
              </option>
            ))}
          </select>
        </label>
      </SideGroup>
      <SideGroup title="분석 설정">
        <label title="실패 패턴·자원 활용·시간 수급처럼 관점마다 AI를 따로(동시에) 돌린 뒤 합칩니다. 같은 발견에 대한 관점별 해석은 나란히 보여 줍니다. 비용은 관점 수만큼 늘어납니다">
          <input type="checkbox" checked={byPerspective} onChange={(e) => setByPerspective(e.target.checked)} disabled={!!busy} />{" "}
          관점별로 분석
        </label>
      </SideGroup>
      </SidePanel>

      {/* 오른쪽 맨 위: 실행과 상태 */}
      <div className="run-bar">
        <button onClick={() => guard(`${TERMS.rule.label} 전체 실행 중`, onRunFullRule)} disabled={!!busy} title={tip("rule")}>
          {TERMS.rule.label} 전체 실행
        </button>
        <button className="primary" disabled={!!busy || !run} title={tip("aiAnalysis")}
          onClick={() => guard("분석 요청 중", async () =>
            setReportId((await api.analyze(run!.run_id, { perspectives: byPerspective })).id))}>
          {TERMS.aiAnalysis.label} 실행
        </button>
      <div className="status-line" aria-live="polite">
        {busy && <span className="muted">{busy}…</span>}
        {error && <span className="critical-text">✕ {error}</span>}
        {current?.status === "running" && <span className="muted">분석 중… (AI가 결과를 여러 조건으로 집계해 보고 있습니다)</span>}
        {current?.status === "error" && <span className="critical-text">✕ 분석 실패: {current.error}</span>}
      </div>
      </div>

      {current?.status === "done" && current.body && current.score && (
        <>
          <AnalysisVerdict report={current} />
          {adapter.background && (
            <Details summary="업무 배경 한눈에 (이 분석을 읽기 전에)">
              <ul className="background-lines">{adapter.background.map((line, i) => <li key={i}>{plain.render(line)}</li>)}</ul>
              <p className="muted small">점선 밑줄이 있는 말은 마우스를 올리면 설명이 나옵니다.</p>
            </Details>
          )}
          {current.body.summary && <p className="summary" style={{ whiteSpace: "pre-line" }}>{plain.render(current.body.summary)}</p>}

          <Details summary="상세보기 (정답 대조 · 분석 비용·시간)">
            <div className="tiles">
              <div className="tile">
                <div className="tile-label" title={tip("detection")}>{TERMS.detection.label} (정답 대조)</div>
                <div className="tile-value">
                  {current.score.detected}/{current.score.total}
                  {current.score.detection_rate != null && ` · ${(current.score.detection_rate * 100).toFixed(0)}%`}
                </div>
                {!!current.score.pending && <div className="tile-note warning-text">원인 확인 대기 {current.score.pending}개</div>}
              </div>
              <div className="tile">
                <div className="tile-label" title={tip("unmatched")}>{TERMS.unmatched.label}</div>
                <div className="tile-value">{current.score.unmatched_findings.length}건</div>
                <div className="tile-note">사람 확인 대기 {current.score.unlabeled} · {TERMS.validFinding.label} {current.score.valid_unmatched}</div>
              </div>
              <div className={`tile ${current.score.false_positives ? "tile-critical" : ""}`}>
                <div className="tile-label" title={tip("falsePositive")}>{TERMS.falsePositive.label} (사람 확인)</div>
                <div className="tile-value">{current.score.false_positives}건</div>
              </div>
              <div className="tile tile-cost">
                <div className="tile-label">분석 비용·시간</div>
                <div className="tile-value">{fmtCost(current.body.usage)}</div>
                <div className="tile-note">
                  {fmtSeconds(current.body.usage.seconds)} · {TERMS.llm.label} {current.body.usage.llm_calls ?? 0}회 · 집계 {Object.keys(current.body.calls).length}회
                </div>
                {current.body.memory !== undefined && (
                  <div className="tile-note" title="이전 회차에서 사람이 내린 판정(잘못 짚음·원인 판정)을 AI에게 알려 주었습니다">
                    {current.body.memory ? `사용한 기억 ${current.body.memory.judgments.length}건` : "기억 없이 분석"}
                  </div>
                )}
              </div>
            </div>
            {current.body.perspectives && (
              <div className="tiles">
                {Object.entries(current.body.perspectives).map(([pid, p]) => (
                  <div key={pid} className={`tile ${p.error ? "tile-critical" : ""}`}>
                    <div className="tile-label">관점: {p.name}</div>
                    <div className="tile-value">{p.error ? "실패" : `발견 ${p.findings}건`}</div>
                    <div className="tile-note">
                      {p.error ? p.error : `${fmtCost(p.usage)} · ${fmtSeconds(p.usage?.seconds)} · ${TERMS.llm.label} ${p.usage?.llm_calls ?? 0}회`
                        + (p.dropped ? ` · 근거 부족으로 뺌 ${p.dropped}건` : "")}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="muted small">정답은 채점에만 쓰며 {TERMS.aiAnalysis.label}은 보지 못합니다.</p>
          </Details>

          <div className="analysis-split">
            <div className="finding-list">
              {findings.map((f) => (
                <FindingCard
                  key={f.id}
                  finding={f}
                  calls={current.body!.calls}
                  reasonLabels={reasonLabels}
                  reasonDetails={reasonDetails}
                  metricLabels={Object.fromEntries(adapter.metrics.map((m) => [m.key, m.label]))}
                  dimensionLabels={dimensionLabels}
                  plain={plain}
                  summary={decisions.length ? summaryOf(f) : null}
                  valueNames={{ ...(domain.dimensions.names ?? {}), ...(adapter.valueNames ?? {}) }}
                  resourceSpecs={resourceSpecs}
                  matched={Object.entries(current.score!.faults).filter(([, s]) => s.matched_findings.includes(f.id)).map(([fid]) => fid)}
                  causeCheck={Object.entries(current.score!.faults).filter(([, s]) => s.confirm_cause && s.matched_findings.includes(f.id)).map(([fid]) => fid)}
                  label={current.score!.labels[f.id]}
                  onLabel={(label) => guard("판정 저장 중", async () => setLabelled(await api.label(current.id, f.id, label)))}
                  focused={focus === f.id}
                  onFocus={() => setFocus(focus === f.id ? null : f.id)}
                />
              ))}
              {current.body.dropped.length > 0 && (
                <details className="dropped">
                  <summary>근거 숫자가 확인되지 않아 뺀 {TERMS.finding.label} {current.body.dropped.length}건</summary>
                  <ul>
                    {current.body.dropped.map((d, i) => (
                      <li key={i}><strong>{d.finding.title}</strong> — {d.problems.join("; ")}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div className="panel map-side">
              <h2>{focused ? `${focused.id} ${TERMS.slice.label}` : "분석한 결과"}</h2>
              {dataset.instance && decisions.length > 0 && analyzedRun ? (
                <adapter.ResultView instance={dataset.instance} decisions={decisions} dimensions={domain.dimensions}
                  reasonLabels={reasonLabels} reasonDetails={reasonDetails} highlight={highlight} runId={analyzedRun.run_id} />
              ) : (
                <p className="muted">결과를 불러오는 중…</p>
              )}
              {focused && !focused.slice && !focused.resources && <p className="muted small">이 문제는 특정 조건이 아니라 지표 전체의 패턴이라 지도에 강조할 곳이 없습니다.</p>}
              {focused?.resources && (
                <p className="muted small">
                  {resourceSpecs[focused.resources.kind]?.label ?? focused.resources.kind} {focused.resources.ids.join(", ")}이(가) 맡은
                  {focused.slice ? " 조건에 맞는" : ""} 항목 {highlight?.length ?? 0}건을 강조했습니다.
                </p>
              )}
            </div>
          </div>
        </>
      )}
      {!current && (
        <p className="muted empty">
          분석할 결과를 고르고 {TERMS.aiAnalysis.label}을 실행하세요. {TERMS.faults.label}(P1~P4)를 켠 데이터로 {TERMS.rule.label}을 전체 실행한 결과를
          분석하면 {TERMS.detection.label}을 정답과 대조해 볼 수 있습니다.
        </p>
      )}
    </section>
  );
}

// 결론 한 줄 (M8-c): 심어둔 문제 중 몇 개를 찾았는지, 사람이 확인할 것이 남았는지
function AnalysisVerdict({ report }: { report: Report }) {
  const score = report.score!;
  const pending = score.unlabeled;
  const causePending = score.pending ?? 0;
  return (
    <div className="verdict" role="status" aria-label="결론">
      <span>
        <strong title={tip("detection")}>{TERMS.faults.label} {score.total}개 중 {score.detected}개 찾음</strong>
        {score.detection_rate != null && ` (${(score.detection_rate * 100).toFixed(0)}%)`}
      </span>
      {Object.entries(score.faults).map(([fid, f]) => {
        const state = f.status ?? (f.detected ? "detected" : "missed");
        const cls = state === "detected" ? "good-text" : state === "pending" ? "warning-text" : "critical-text";
        const title = state === "pending" ? `근거는 맞음 (${f.matched_findings.join(", ")}) · 원인이 맞는지 사람 확인 필요`
          : f.matched_findings.join(", ") || "찾지 못함";
        return (
          <span key={fid} className={cls} title={title}>
            {state === "detected" ? "✓" : state === "pending" ? "?" : "✕"} {fid} {f.name}
          </span>
        );
      })}
      {causePending > 0 && <span className="warning-text">원인 확인 대기 {causePending}개</span>}
      <span className={pending ? "warning-text" : "muted"} title={tip("unmatched")}>
        {pending ? `사람 확인 대기 ${pending}건` : "사람 확인 대기 없음"}
      </span>
      {score.false_positives > 0 && <span className="critical-text">{TERMS.falsePositive.label} {score.false_positives}건</span>}
    </div>
  );
}

function FindingCard({
  finding,
  calls,
  reasonLabels,
  reasonDetails,
  metricLabels,
  dimensionLabels,
  valueNames,
  resourceSpecs,
  matched,
  causeCheck,
  label,
  onLabel,
  focused,
  onFocus,
  plain,
  summary,
}: {
  plain: Plain;
  summary: string | null;    // 코드가 결과에서 센 한 줄 요약 (구간·자원이 없으면 null)
  finding: Finding;
  calls: Record<string, ToolCall>;
  reasonLabels: Record<string, string>;
  reasonDetails: Record<string, string>;
  metricLabels: Record<string, string>;
  dimensionLabels: Record<string, string>;
  valueNames: Record<string, string>;
  resourceSpecs: NonNullable<Dimensions["resources"]>;
  matched: string[];
  causeCheck: string[];      // 이 발견이 맞춘 정답 중 사람이 원인을 확인해야 하는 것
  label?: FindingLabel;
  onLabel: (label: FindingLabel | null) => void;
  focused: boolean;
  onFocus: () => void;
}) {
  return (
    <article className={`finding${focused ? " focused" : ""}`}>
      <header>
        <button className="finding-title" onClick={onFocus} aria-pressed={focused}>
          <span className="finding-id">{finding.id}</span> {plain.text(finding.title)}
        </button>
        {causeCheck.length > 0 ? (
          <span className="label-buttons">
            <span className={`small ${label === "cause_ok" ? "good-text" : label === "cause_wrong" ? "critical-text" : "warning-text"}`}
              title="근거(지표·인용 도구)는 정답과 맞습니다. 원인 설명이 맞는지는 사람이 판정해야 찾은 것으로 셉니다">
              정답 {causeCheck.join(", ")} 근거 일치 · 원인 확인:
            </span>
            <button className={label === "cause_ok" ? "selected" : undefined} onClick={() => onLabel(label === "cause_ok" ? null : "cause_ok")}>
              원인 맞음
            </button>
            <button className={label === "cause_wrong" ? "selected danger" : undefined}
              onClick={() => onLabel(label === "cause_wrong" ? null : "cause_wrong")}>
              원인 틀림
            </button>
          </span>
        ) : matched.length > 0 ? (
          <span className="badge good-text">✓ 정답 {matched.join(", ")}과 일치</span>
        ) : (
          <span className="label-buttons">
            <span className="muted small" title={tip("unmatched")}>정답에 없음 · 사람 확인:</span>
            <button className={label === "valid" ? "selected" : undefined} onClick={() => onLabel(label === "valid" ? null : "valid")}
              title={tip("validFinding")}>
              {TERMS.validFinding.label}
            </button>
            <button className={label === "false_positive" ? "selected danger" : undefined}
              onClick={() => onLabel(label === "false_positive" ? null : "false_positive")} title={tip("falsePositive")}>
              {TERMS.falsePositive.label}
            </button>
          </span>
        )}
      </header>
      {summary && <p className="finding-summary" title="AI 문장이 아니라 분석한 결과에서 코드가 직접 센 숫자입니다">{plain.render(summary)}</p>}
      {finding.impact && <p className="finding-impact" title="AI가 쓴 현장 영향 (새 수치 없이)">현장 영향: {plain.render(finding.impact)}</p>}
      <div className="chips">
        {(finding.perspective_names ?? []).map((name) => (
          <span key={name} className="chip chip-perspective" title="이 발견을 찾은 관점">관점: {name}</span>
        ))}
        {finding.resources && (() => {
          const spec = resourceSpecs[finding.resources.kind];
          const traits = Object.entries(finding.resources.traits ?? {})
            .filter(([, v]) => v.length > 0)
            .map(([k, v]) => `${spec?.traits?.[k]?.label ?? k} ${[...new Set(v)].join(", ")}`);   // 정리 전에 저장된 리포트 대비
          return (
            <span className="chip chip-perspective" title="이 발견이 가리키는 자원 (인용한 도구 결과에서 확인됨). 누르면 지도에서 이 자원이 맡은 항목을 강조합니다">
              {spec?.label ?? finding.resources.kind}: {finding.resources.ids.join(", ")}{traits.length ? ` · ${traits.join(" · ")}` : ""}
            </span>
          );
        })()}
        {(finding.related ?? []).length > 0 && (
          <span className="chip chip-perspective" title="구간이 겹치는 다른 발견 (한쪽이 다른 쪽을 더 좁힌 구간). 같은 문제를 다른 크기로 본 것일 수 있습니다">
            관련: {finding.related!.join(", ")}
          </span>
        )}
        {Object.entries(finding.slice ?? {}).map(([dim, values]) => (
          <span key={dim} className="chip" title={`${dim}: ${values.join(", ")}`}>
            {dimensionLabels[dim] ?? dim}: {values.map((v) => valueNames[String(v)] ?? v).join(", ")}
          </span>
        ))}
        {(finding.reason_codes ?? []).map((c) => (
          <span key={c} className="chip" title={`${reasonDetails[c] ?? ""} (${c})`}>{reasonLabels[c] ?? c}</span>
        ))}
        {finding.metric && (
          <span className="chip" title={finding.metric.name}>
            {metricLabels[finding.metric.name] ?? finding.metric.name} {finding.metric.direction === "low" ? "낮음" : "높음"}
          </span>
        )}
      </div>
      <Details summary={`상세보기 (설명${finding.hypothesis ? " · 추정 원인" : ""}${finding.alternatives?.length ? ` · 다른 관점의 해석 ${finding.alternatives.length}건` : ""} · ${TERMS.evidence.label} ${finding.cited_calls.length}건)`}>
        <p>{plain.render(finding.description)}</p>
        {finding.resources_removed && (
          <p className="muted small" title="인용한 도구 결과에서 확인되지 않아 뺀 자원·속성입니다">
            자원에서 뺀 항목: {[finding.resources_removed.kind && `종류 ${finding.resources_removed.kind}`,
              (finding.resources_removed.ids ?? []).length ? `id ${finding.resources_removed.ids!.join(", ")}` : "",
              ...Object.entries(finding.resources_removed.traits ?? {}).map(([k, v]) => `${k}=${v.join(", ")}`)]
              .filter(Boolean).join(" · ")}
          </p>
        )}
        {finding.slice_removed && (
          <p className="muted small" title="AI가 선언되지 않은 차원·값으로 구간을 적어 그 항목만 뺐습니다 (지도 강조·정답 대조에 쓰지 않음)">
            구간에서 뺀 항목: {Object.entries(finding.slice_removed).map(([d, v]) => `${d}=${v.join(", ")}`).join(" · ")}
          </p>
        )}
        {finding.hypothesis && (
          <p className="muted">추정 원인{finding.alternatives?.length ? ` (${finding.perspective_names?.[0]})` : ""}: {plain.render(finding.hypothesis)}</p>
        )}
        {finding.concepts_removed && (
          <p className="muted small" title="이 데이터에 없는 개념(예: 차량·요일)으로 원인을 설명해 뺐습니다. 한 번 고쳐 오게 한 뒤에도 남은 경우입니다">
            데이터에 없는 개념이 들어 있어 뺀 문장: {Object.values(finding.concepts_removed).join(" / ")}
          </p>
        )}
        {(finding.alternatives ?? []).map((a) => (
          <div key={a.perspective} className="alternative" title="같은 구간을 다른 관점에서 본 해석입니다. 어느 해석이 맞는지는 사람이 판단합니다">
            <strong>{a.perspective_name}</strong>: {plain.text(a.title)}
            {a.hypothesis && <p className="muted">추정 원인 ({a.perspective_name}): {plain.render(a.hypothesis)}</p>}
          </div>
        ))}
        {finding.cited_calls.map((id) => calls[id] && <Evidence key={id} call={calls[id]} />)}
      </Details>
    </article>
  );
}

function Evidence({ call }: { call: ToolCall }) {
  const out = call.output as { rows?: Record<string, unknown>[] } & Record<string, unknown>;
  const rows = Array.isArray(out?.rows) ? out.rows.slice(0, 12) : null;
  const cols = rows?.[0] ? Object.keys(rows[0]) : [];
  return (
    <details className="evidence-call">
      <summary>
        {TERMS.evidence.label}: <code>{call.name}</code> <code className="json">{JSON.stringify(call.input)}</code>
      </summary>
      {rows ? (
        <div className="table-scroll">
          <table className="evidence-table">
            <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{cols.map((c) => <td key={c}>{typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre>{JSON.stringify(call.output, null, 2)}</pre>
      )}
    </details>
  );
}

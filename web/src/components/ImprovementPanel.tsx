import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api";
import type { DomainAdapter, MetricSpec, Scope } from "../domains/types";
import type { Constraint, HarnessInfo, HistoryRow, Memory, Proposal, ProposalBatch, ProposalOutcome, Ranking, RankTier, SavedConstraint, SpecEstimate } from "../types";
import { fmtCost, fmtMetric, fmtMetricDelta, fmtSeconds, fmtUsd } from "./MetricsPanel";
import { usePoll } from "./usePoll";
import { TERMS, tip } from "../terms";
import Details from "./Details";
import TradeoffMap from "./TradeoffMap";
import SidePanel, { SideGroup } from "./SidePanel";

const STATUS_LABEL: Record<Proposal["status"], string> = {
  proposed: "제안됨",
  invalid: "적용 불가 (바꿀 수 있는 범위 밖 등)",
  simulating: "미리 돌려보는 중",
  simulated: "미리 돌려보기 완료",
  approved: "승인됨",
  rejected: "반려됨",
  stale: "기준이 바뀜 (다시 제안 필요)",
};

const TIER_LABEL: Record<RankTier, string> = {
  main: "본안",
  cut: "개수 상한으로 잘림",
  reference: "참고",
  hidden: "지배당한 안 (모든 지표에서 다른 안보다 나쁨)",
  pending: "아직 미리 돌려보지 않음",
};
const FOLDED: RankTier[] = ["cut", "reference", "hidden"];

const TIER_SHORT: Partial<Record<RankTier, string>> = { cut: "잘림", reference: "참고", hidden: "지배당함" };

/** 접힌 제안의 분류별 건수 (있는 분류만, 예: "참고 2" · "잘림 1 · 참고 1") */
function foldedSummary(folded: Proposal[], ranking: Ranking | null | undefined) {
  const counts = new Map<RankTier, number>();
  for (const p of folded) {
    const t = ranking?.entries[p.id]?.tier ?? "reference";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return FOLDED.filter((t) => counts.has(t)).map((t) => `${TIER_SHORT[t]} ${counts.get(t)}`).join(" · ");
}

// 제시 기준 (M15-A) 순서대로: 본안 → 아직 → (접음) 잘림 · 참고 · 숨김
function orderedProposals(batch: ProposalBatch | null, ranking: Ranking | null | undefined) {
  const all = batch?.proposals ?? [];
  if (!ranking) return { shown: all, folded: [] as Proposal[] };
  const byId = new Map(all.map((p) => [p.id, p]));
  const ordered = ranking.order.map((id) => byId.get(id)).filter((p): p is Proposal => !!p);
  const tier = (p: Proposal) => ranking.entries[p.id]?.tier ?? "pending";
  return { shown: ordered.filter((p) => !FOLDED.includes(tier(p))), folded: ordered.filter((p) => FOLDED.includes(tier(p))) };
}

const HUMAN_HOURS_KEY = "oah.humanHoursPerCycle";

const APPROVER_KEY = "oah.approver";

function readApprover(): string {
  try {
    return localStorage.getItem(APPROVER_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveApprover(v: string) {
  try {
    localStorage.setItem(APPROVER_KEY, v);
  } catch {
    /* 저장 못 해도 승인은 된다 */
  }
}

function readHumanHours(): number | null {
  try {
    const v = localStorage.getItem(HUMAN_HOURS_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

function getPath(params: Record<string, unknown>, path: string): unknown {
  const m = /^(\w+)\.(\w+)(?:\[(\d+)\])?$/.exec(path);
  if (!m) return undefined;
  const value = (params[m[1]] as Record<string, unknown> | undefined)?.[m[2]];
  return m[3] !== undefined && Array.isArray(value) ? value[Number(m[3])] : value;
}

export default function ImprovementPanel({
  domainName,
  adapter,
  harness,
  scopes,
  reportId,
  batchId,
  setBatchId,
  datasetId,
}: {
  datasetId: string | null;              // 득실 지도(M13)를 그릴 데이터
  domainName: string;
  adapter: DomainAdapter;
  harness: HarnessInfo | null;
  scopes: Scope[];
  reportId: string | null;
  batchId: string | null;
  setBatchId: (id: string) => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const polledBatch = usePoll<ProposalBatch>(
    batchId ? () => api.batch(batchId) : null,
    (b) => b.status !== "running" && !b.proposals.some((p) => p.status === "simulating"),
    [batchId, refresh],
    1000,
  );
  const batch = polledBatch?.id === batchId ? polledBatch : null;
  const [current, setCurrent] = useState<{ params: Record<string, unknown>; spec_sections: Record<string, string> } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [memory, setMemory] = useState<Memory | null>(null);
  const [saved, setSaved] = useState<SavedConstraint[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [humanHours, setHumanHours] = useState<number | null>(readHumanHours);

  const reload = () => {
    api.params(domainName).then(setCurrent).catch(() => undefined);
    api.history().then(setHistory).catch(() => undefined);
    api.memory(domainName).then(setMemory).catch(() => undefined);
    api.savedConstraints(domainName, true).then(setSaved).catch(() => undefined);
  };
  useEffect(reload, [domainName, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setRefresh((n) => n + 1);
    }
  };

  const saveHumanHours = (v: string) => {
    const n = v === "" ? null : Number(v);
    setHumanHours(n);
    try {
      if (n === null) localStorage.removeItem(HUMAN_HOURS_KEY);
      else localStorage.setItem(HUMAN_HOURS_KEY, String(n));
    } catch {
      /* 저장 못 해도 화면 표시는 된다 */
    }
  };

  const ranking = batch?.ranking;
  const { shown, folded } = orderedProposals(batch, ranking);
  const unsimulated = (batch?.proposals ?? []).filter((p) => p.kind === "params" && p.status === "proposed");
  const simulateAll = () =>
    guard("설정값 제안을 모두 미리 돌려보는 중", async () => {
      for (const p of unsimulated) await api.simulate(p.id, {});
      setNotice(`설정값 제안 ${unsimulated.length}건을 미리 돌려보고 순위를 매겼습니다 (규칙 엔진, AI 비용 0)`);
    });
  const approved = history.filter((h) => h.status === "approved");
  const lastCycle = history[history.length - 1]?.cycle;
  const cycleSeconds = lastCycle
    ? (lastCycle.analysis_seconds ?? 0) + (lastCycle.proposal_seconds ?? 0) + (lastCycle.simulation_seconds ?? 0)
    : null;
  const headline = adapter.metrics.find((m) => m.headline) ?? adapter.metrics[0];
  const trend = approved.length
    ? [
        { round: "개선 전", value: approved[0].before?.[headline.key] ?? null },
        ...approved.map((h) => ({ round: `${h.round}회차`, value: h.after?.[headline.key] ?? null })),
      ]
    : [];

  return (
    <section className="improvement">
      <SidePanel>
      <SideGroup title="지금 보는 것">
        <span>{reportId ? `분석 결과 ${reportId}` : "문제 찾기 탭에서 분석을 먼저 하세요."}</span>
        {current && <span>현재 {TERMS.params.label} v{String(current.params.version)}</span>}
        <span className="muted small" title={tip("history")}>반영 {approved.length}회 · 반려 {history.length - approved.length}건
          {lastCycle && <> · 마지막 개선 한 바퀴 {fmtUsd(lastCycle.llm_cost_usd)}{cycleSeconds != null && ` · ${fmtSeconds(cycleSeconds)}`}</>}</span>
      </SideGroup>
      {saved.length > 0 && (
        <SideGroup title="선택: 저장된 제약">
          <span className="muted small" title="LangGraph agents 탭·에이전트 탭에서 의견을 제약으로 정리하고 사람이 확정한 것입니다. 켜진 제약은 다음 개선 제안 요청과 agents 탭 실행에 자동으로 들어갑니다">
            현장 의견에서 확정 · 켜짐 {saved.filter((c) => c.active).length}개 / {saved.length}개
          </span>
          <ul className="side-list">
            {saved.map((c) => (
              <li key={c.id} className={c.active ? undefined : "muted"}>
                <label title={`${c.opinion || c.body.note || "의견 없음"} (${c.origin}, 규칙 v${c.params_version ?? "?"})`}>
                  <input type="checkbox" checked={c.active} disabled={!!busy}
                    onChange={() => guard(c.active ? "제약 끄는 중" : "제약 켜는 중", async () => void (await api.toggleConstraint(c.id, !c.active)))} />{" "}
                  {constraintText(c.body)}
                </label>
              </li>
            ))}
          </ul>
        </SideGroup>
      )}
      </SidePanel>

      {/* 오른쪽 맨 위: 개선 제안 만들기와 상태 */}
      <div className="run-bar">
        <button className="primary" disabled={!!busy || !reportId}
          onClick={() => guard("개선 제안 요청 중", async () => setBatchId((await api.propose(reportId!)).id))} title={tip("proposal")}>
          {TERMS.proposal.label} 만들기
        </button>
      <div className="status-line" aria-live="polite">
        {busy && <span className="muted">{busy}…</span>}
        {error && <span className="critical-text">✕ {error}</span>}
        {notice && <span className="good-text">✓ {notice}</span>}
        {batch?.status === "running" && <span className="muted">개선 제안을 만드는 중… (AI가 바꿀 내용을 미리 돌려보며 시험하고 있습니다)</span>}
        {batch?.status === "error" && <span className="critical-text">✕ 개선 제안 만들기 실패: {batch.error}</span>}
        {batch?.status === "done" && batch.meta && (
          <span className="muted">
            제안 {batch.proposals.length}건 · AI가 미리 돌려본 횟수 {batch.meta.trials}회 · 비용 {fmtCost(batch.meta.usage)} ·{" "}
            {fmtSeconds(batch.meta.usage.seconds)}
          </span>
        )}
        {batch?.status === "done" && !!batch.meta?.constraints?.length && (
          <details className="small">
            <summary>적용한 제약 {batch.meta.constraints.length}개 (사람이 정한 한도
              {batch.meta.saved_constraints?.length ? `, 그중 저장된 제약 ${batch.meta.saved_constraints.length}개` : ""})</summary>
            <ul>
              {batch.meta.constraints.map((c, i) => (
                <li key={i}>
                  {constraintText(c)}
                  <span className="muted"> — {c.source}{c.note ? `: ${c.note}` : ""}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {batch?.status === "done" && batch.meta && "memory" in batch.meta && (
          <span className="muted small" title="이전 회차에서 사람이 반려한 개선안과 사유를 이 제안을 만들 때 AI에게 알려 주었습니다">
            {batch.meta.memory ? `사용한 기억 ${batch.meta.memory.rejections.length}건` : "기억 없이 만듦"}
          </span>
        )}
      </div>
      </div>

      {memory && memory.item_ids.length > 0 && (
        <details className="small">
          <summary title="사람이 내린 판단은 다음 회차 AI 입력으로 돌아갑니다. 반려 사유는 개선 제안에, 발견 판정은 문제 찾기에">
            기억 (다음 회차 AI에게 알려 줄 사람의 판단) · 반려 {memory.rejections.length}건 · 판정 {memory.judgments.length}건
          </summary>
          <ul>
            {memory.rejections.map((r) => (
              <li key={r.id}>
                [반려] {r.title} <span className="muted">({r.change}) — {r.reason || "사유 없음"}</span>
                {r.stale && <span className="warning-text"> · 이전 규칙(v{r.params_version}) 기준</span>}
              </li>
            ))}
            {memory.judgments.map((j) => (
              <li key={j.id}>
                [{j.label === "false_positive" ? "잘못 짚음" : j.label === "cause_ok" ? "원인 맞음" : "원인 틀림"}] {j.title}
                {j.stale && <span className="warning-text"> · 이전 규칙(v{j.params_version}) 기준</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <Details summary="상세보기 (개선 한 바퀴 비용·시간, 사람이 할 때와 비교)">
      <div className="tiles">
        <div className="tile tile-cost">
          <div className="tile-label">개선 한 바퀴 (AI: 분석+제안+미리 돌려보기)</div>
          <div className="tile-value">{lastCycle ? fmtUsd(lastCycle.llm_cost_usd) : "–"}</div>
          <div className="tile-note">{cycleSeconds != null ? `총 ${fmtSeconds(cycleSeconds)}` : "아직 승인·반려한 제안이 없습니다"}</div>
          {cycleSeconds != null && humanHours ? (
            <div className="tile-note">
              사람 추정 {humanHours}시간 대비 AI {fmtSeconds(cycleSeconds)}
              {cycleSeconds > 0 && ` (약 ${Math.round((humanHours * 3600) / cycleSeconds).toLocaleString()}배 빠름)`}
            </div>
          ) : null}
        </div>
        <div className="tile">
          <label className="tile-label" htmlFor="human-hours">같은 분석을 사람이 할 때 (추정, 시간)</label>
          <input id="human-hours" type="number" min={0} step={0.5} value={humanHours ?? ""} placeholder="예: 8"
            onChange={(e) => saveHumanHours(e.target.value)} />
          <div className="tile-note">현업 담당자에게 확인한 값을 입력하세요 (이 브라우저에만 저장).</div>
        </div>
        <div className="tile">
          <div className="tile-label" title={tip("history")}>반영 횟수</div>
          <div className="tile-value">{approved.length}회</div>
          <div className="tile-note">반려 {history.length - approved.length}건</div>
        </div>
      </div>
      </Details>

      <TradeoffMap datasetId={datasetId} params={current?.params ?? null} proposals={batch?.proposals ?? []} ranking={ranking}
        constraints={batch?.meta?.constraints ?? []} specs={adapter.metrics}
        defaultAxes={adapter.tradeoff?.axes} defaultMetrics={adapter.tradeoff?.metrics} />

      {batch?.status === "done" && ranking && (
        <div className="controls small">
          <span className="muted" title="개선안 제시 기준: 사람 제약을 지키는 안 → 핵심 지표 개선폭 → 손실이 작은 순. 적용 불가·규칙 위반 증가·최소 효과 미만은 참고로 접습니다">
            제시 기준: 본안 최대 {ranking.config.max_proposals}건 · 발견 하나당 {ranking.config.per_finding}건 · 핵심 지표 최소 효과{" "}
            {(ranking.config.min_effect * 100).toFixed(1)}%p
            {ranking.cut.length > 0 && ` · 개수 상한으로 잘린 안 ${ranking.cut.length}건`}
          </span>
          {unsimulated.length > 0 && (
            <button disabled={!!busy} onClick={simulateAll} title="순위는 미리 돌려본 결과로 매깁니다. 설정값 제안은 규칙 엔진으로 다시 계산하므로 AI 비용이 들지 않습니다">
              설정값 제안 {unsimulated.length}건 모두 미리 돌려보기
            </button>
          )}
        </div>
      )}
      <div className="proposal-list">
        {shown.map((p) => (
          <ProposalCard key={p.id} proposal={p} rank={ranking?.entries[p.id]} current={current} specs={adapter.metrics} harness={harness}
            scopes={scopes} busy={!!busy} guard={guard} onApproved={(msg) => setNotice(msg)} />
        ))}
        {folded.length > 0 && (
          <Details summary={`참고 (접음) ${folded.length}건: ${foldedSummary(folded, ranking)}`}>
            {folded.map((p) => (
              <ProposalCard key={p.id} proposal={p} rank={ranking?.entries[p.id]} current={current} specs={adapter.metrics} harness={harness}
                scopes={scopes} busy={!!busy} guard={guard} onApproved={(msg) => setNotice(msg)} />
            ))}
          </Details>
        )}
        {!batch && reportId && <p className="muted empty">{TERMS.proposal.label} 만들기를 누르면 AI가 분석 결과를 읽고 규칙을 어떻게 바꿀지 제안합니다.</p>}
      </div>

      {history.length > 0 && (
        <section className="panel history">
          <h2 title={tip("history")}>{TERMS.history.label}</h2>
          {trend.length > 1 && (
            <figure className="chart">
              <figcaption>회차별 {headline.label} (미리 돌려본 결과 기준)</figcaption>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={trend} margin={{ top: 8, right: 24, bottom: 4, left: 8 }}>
                  <CartesianGrid vertical={false} stroke="var(--grid)" />
                  <XAxis dataKey="round" tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={{ stroke: "var(--axis)" }} tickLine={false} />
                  <YAxis domain={["auto", "auto"]} tickFormatter={(v: number) => fmtMetric(v, headline.format)}
                    tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={{ stroke: "var(--axis)" }} tickLine={false} width={64} />
                  <Tooltip
                    cursor={{ stroke: "var(--axis)" }}
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="tooltip static">
                          <strong>{label}</strong>
                          <div>{headline.label} {fmtMetric(payload[0].value as number, headline.format)}</div>
                        </div>
                      ) : null
                    }
                  />
                  <Line type="linear" dataKey="value" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 4, fill: "var(--series-1)", stroke: "var(--surface)", strokeWidth: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </figure>
          )}
          <div className="table-scroll">
            <table className="compare-table-inner">
              <thead>
                <tr>
                  <th>회차</th><th>결과</th><th>{TERMS.proposal.label}</th><th className="num">{headline.label} 전</th>
                  <th className="num">후</th><th className="num">AI 비용</th><th className="num">AI 시간</th><th>메모</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.proposal_id}>
                    <td>{h.round ?? "–"}</td>
                    <td className={h.status === "approved" ? "good-text" : "muted"}>{h.status === "approved" ? "✓ 승인" : "반려"}</td>
                    <td>{h.title} <span className="muted small">({h.kind === "params" ? TERMS.params.label : TERMS.spec.label})</span></td>
                    <td className="num">{fmtMetric(h.before?.[headline.key], headline.format)}</td>
                    <td className="num">{fmtMetric(h.after?.[headline.key], headline.format)}</td>
                    <td className="num">{fmtUsd(h.cycle.llm_cost_usd)}</td>
                    <td className="num">{fmtSeconds((h.cycle.analysis_seconds ?? 0) + (h.cycle.proposal_seconds ?? 0) + (h.cycle.simulation_seconds ?? 0))}</td>
                    <td className="small">{h.decision?.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}

// 제약 한 줄: 대상 · 한도 · 구간 (M15 후속)
export function constraintText(c: Constraint): string {
  const bounds = [c.min != null && `최소 ${c.min}`, c.max != null && `최대 ${c.max}`, c.max_drop != null && `감소 ${c.max_drop} 이내`,
    c.max_rise != null && `증가 ${c.max_rise} 이내`].filter(Boolean).join(", ");
  const when = c.when ? ` · 구간 ${Object.entries(c.when).map(([k, v]) => `${k}=${v.join("/")}`).join(", ")}` : "";
  return `${c.type === "param" ? c.path : c.metric} ${bounds}${when}`;
}

const fmtDelta = (d: number, f: MetricSpec["format"]) =>
  `${d > 0 ? "+" : d < 0 ? "−" : ""}${f === "pct" ? `${Math.abs(d * 100).toFixed(1)}%p` : `${Math.abs(d).toFixed(1)}분`}`;

// 제안 한 줄 요약 (M8-b): 핵심 효과 · 나빠진 지표(부작용) · 규칙 위반
function Gist({ proposal: p, specs }: { proposal: Proposal; specs: MetricSpec[] }) {
  const sim = p.simulation;
  if (p.status === "invalid") return null;
  if (!sim || sim.error || !sim.before || !sim.after) {
    return <p className="gist muted">{p.status === "simulating" ? "미리 돌려보는 중…" : `아직 ${TERMS.simulate.label}를 하지 않았습니다`}</p>;
  }
  const before = sim.before, after = sim.after;
  const has = (s: MetricSpec) => s.key in before && s.key in after;
  const worse = specs.filter((s) => s.better && has(s)).filter((s) => {
    const d = after[s.key] - before[s.key];
    return Math.abs(d) > 1e-9 && (s.better === "up" ? d < 0 : d > 0);
  });
  const v = sim.violations_after ?? 0;
  return (
    <p className="gist">
      {specs.filter((s) => s.primary && has(s)).map((s) => {
        const d = after[s.key] - before[s.key];
        const good = s.better ? (s.better === "up" ? d > 0 : d < 0) : false;
        return (
          <span key={s.key} title={s.tech}>
            {s.label} {fmtMetric(before[s.key], s.format)} → <strong>{fmtMetric(after[s.key], s.format)}</strong>{" "}
            <span className={good ? "better" : d !== 0 ? "worse" : undefined}>({fmtDelta(d, s.format)})</span>
          </span>
        );
      })}
      <span className={worse.length ? "worse" : "muted"}>
        {worse.length
          ? `나빠진 지표: ${worse.map((s) => `${s.label} ${fmtDelta(after[s.key] - before[s.key], s.format)}`).join(", ")}`
          : "나빠진 지표 없음"}
      </span>
      <span className={v ? "worse" : "better"} title={tip("violations")}>{TERMS.violations.label} {v}건</span>
      {sim.minimal_change && (
        <span className="better" title="현재 값과 제안 값 사이를 규칙 엔진으로 훑어, 같은 핵심 지표를 내는 가장 작은 변경을 찾았습니다 (AI 비용 0)">
          최소 변경 추천: <code>{sim.minimal_change.path}</code> {sim.minimal_change.current} → <strong>{sim.minimal_change.recommended}</strong>
          {" "}(제안값 {sim.minimal_change.proposed}일 때와 핵심 지표 같음)
        </span>
      )}
    </p>
  );
}

// --- 계획 vs 실적 (M17): 미리 돌려보기가 끝난 규칙 설정값 안. 참고용 (AI에게 보이지 않고 승인 조건·순위에 쓰지 않음) ---
const PROFILE_LABEL: Record<string, string> = { normal: "보통", lenient: "관대", sensitive: "민감" };
const REASON_LABEL: [keyof ProposalOutcome["current"]["outcome"], string, string][] = [
  ["changed_same_day_resolve", "같은 날 재배정", "이월 건이 들어온 날은 그날 지시서 전체를 규칙 엔진으로 다시 배정해, 원래 날 첫 시도부터 계획과 달라진다"],
  ["changed_carryover", "이월", "계획 자체가 배정 실패라 다음 날로 넘어갔다"],
  ["changed_reschedule", "재요청", "계획대로 갔지만 고객이 일정을 다시 요청해 다음 날로 넘어갔다"],
];

function OutcomeBox({ proposal: p }: { proposal: Proposal }) {
  const [profile, setProfile] = useState("normal");
  const [data, setData] = useState<ProposalOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const stamp = JSON.stringify(p.simulation?.after ?? null);
  useEffect(() => {
    let stop = false;
    setLoading(true);
    setError(null);
    api.proposalOutcome(p.id, profile)
      .then((d) => { if (!stop) setData(d); })
      .catch((e) => {
        if (stop) return;
        const msg = String((e as Error).message ?? e);
        if (msg.includes("실적 기능이 없음")) setHidden(true);   // 실적 기능이 없는 도메인은 표를 숨긴다
        else setError(msg);
      })
      .finally(() => { if (!stop) setLoading(false); });
    return () => { stop = true; };
  }, [p.id, profile, stamp]);
  if (hidden) return null;

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const num = (v: number) => (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(1));
  // [이름, 현재, 이 안, 좋아지는 방향(+1 = 클수록 좋음), 형식, 설명]
  const rows: [string, number, number, 1 | -1, (v: number) => string, string][] = data ? [
    ["계획 · 배정", data.current.plan.assigned, data.proposal.plan.assigned, 1, num, "규칙 엔진이 배정한 지시서 (1일차부터의 계획)"],
    ["계획 · 정시 배정", data.current.plan.on_time, data.proposal.plan.on_time, 1, num, "희망 시각에 정확히 시작하도록 배정한 지시서 (계획)"],
    ["실적 · " + TERMS.promiseKept.label, data.current.outcome.promise_kept, data.proposal.outcome.promise_kept, 1, num,
      `원래 희망 날짜에, 희망 시각 ±${data.promise_window_min}분 안에 완료 (실적)`],
    ["실적 · 불만율", data.current.outcome.complaint_rate, data.proposal.outcome.complaint_rate, -1, pct, "완료는 됐지만 불만"],
    ["실적 · 취소율", data.current.outcome.cancel_rate, data.proposal.outcome.cancel_rate, -1, pct, "고객 취소 + 이틀 넘게 밀려 취소"],
    ["실적 · 미처리율", data.current.outcome.unserved_rate, data.proposal.outcome.unserved_rate, -1, pct, "마지막 날까지 처리되지 못함"],
    ["실적 · 평균 이월", data.current.outcome.avg_carry_days, data.proposal.outcome.avg_carry_days, -1, (v) => `${v.toFixed(2)}일`, "다음 날로 넘어간 횟수의 평균"],
  ] : [];

  return (
    <div className="outcome-box" aria-label={TERMS.outcome.label}>
      <div className="outcome-head">
        <strong title={tip("outcome")}>{TERMS.outcome.label}</strong>{" "}
        <span className="chip muted" title="승인 조건·순위·검사에 쓰지 않습니다. AI에게도 보여주지 않습니다">참고용</span>{" "}
        <label className="small">현실 모델{" "}
          <select value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="현실 모델">
            {Object.entries(PROFILE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {loading && <span className="muted small"> 계산 중… (2~3초)</span>}
      </div>
      {error && <p className="critical-text small">✕ 실적 계산 실패: {error}</p>}
      {data && (
        <>
          <table className="outcome-table small">
            <thead><tr><th /><th className="num">현재</th><th className="num">이 안</th><th className="num">차이</th></tr></thead>
            <tbody>
              {rows.map(([name, cur, mine, better, fmt, help]) => {
                const d = mine - cur;
                const cls = Math.abs(d) < 1e-9 ? "" : d * better > 0 ? "good-text" : "critical-text";
                const dTxt = fmt === pct ? `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}%p`
                  : `${d >= 0 ? "+" : ""}${fmt === num ? num(Math.round(d * 10) / 10) : d.toFixed(2)}`;
                return (
                  <tr key={name} title={help}>
                    <td>{name}</td><td className="num">{fmt(cur)}</td><td className="num">{fmt(mine)}</td>
                    <td className={`num ${cls}`}>{dTxt}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small">
            계획과 달라진 지시서 (이 안): <strong>{num(data.proposal.outcome.changed)}건</strong>
            {" — "}
            {REASON_LABEL.map(([k, label, help], i) => (
              <span key={k} title={help}>{i ? " · " : ""}{label} {num(data.proposal.outcome[k] as number)}</span>
            ))}
            <span className="muted"> (현재 {num(data.current.outcome.changed)}건)</span>
          </p>
          <p className="muted small">
            현실 모델 {PROFILE_LABEL[data.profile] ?? data.profile} · 실적 seed {data.seeds.join(",")} 평균 · 전체 {data.proposal.outcome.orders.toLocaleString()}건 ·
            {" "}계획 숫자는 1일차부터의 계획이다. 이월 건이 섞인 날은 그날 전체를 다시 배정하므로 실제로 실행된 계획과 다르다 (같은 날 재배정).
          </p>
        </>
      )}
    </div>
  );
}

function ProposalCard({
  proposal: p,
  rank,
  current,
  specs,
  harness,
  scopes,
  busy,
  guard,
  onApproved,
}: {
  proposal: Proposal;
  rank?: Ranking["entries"][string];
  current: { params: Record<string, unknown>; spec_sections: Record<string, string> } | null;
  specs: MetricSpec[];
  harness: HarnessInfo | null;
  scopes: Scope[];
  busy: boolean;
  guard: (label: string, fn: () => Promise<void>) => Promise<void>;
  onApproved: (message: string) => void;
}) {
  const [note, setNote] = useState("");
  const [approver, setApprover] = useState(readApprover);   // 변경 이력 카드에 남는다 (M13)
  const [estimate, setEstimate] = useState<SpecEstimate | null>(null);
  const [level, setLevel] = useState("L3");
  const pilotScopes = scopes.filter((s) => s.items);
  const [scopeId, setScopeId] = useState(pilotScopes[0]?.id ?? "");
  const scope = pilotScopes.find((s) => s.id === scopeId)?.items ?? undefined;
  const sim = p.simulation;
  const open = p.status === "proposed" || p.status === "simulated";

  const simulate = () =>
    guard("미리 돌려보는 중", async () => {
      const res = await api.simulate(p.id, p.kind === "spec" ? { level, scope } : {});
      if ("needs_confirmation" in res) setEstimate(res.estimate);
    });
  const confirmSpec = () =>
    guard(`${TERMS.ai.label} 전후 실행 요청 중`, async () => {
      setEstimate(null);
      await api.simulate(p.id, { confirm: true, level, scope });
    });

  return (
    <article className={`proposal proposal-${p.status}`} id={`proposal-${p.id}`}>
      <header>
        {rank?.rank != null && <span className="chip rank" title="개선안 제시 기준의 순위">{rank.rank}순위</span>}
        <strong>{p.body.title}</strong>
        <span className="chip" title={tip(p.kind === "params" ? "params" : "spec")}>
          {p.kind === "params" ? TERMS.params.label : TERMS.spec.label}
        </span>
        <span className={`badge ${p.status === "invalid" ? "critical-text" : p.status === "approved" ? "good-text" : ""}`}>
          {STATUS_LABEL[p.status]}
        </span>
        {!!sim?.constraint_violations?.length && (
          <span className="badge warning-text" title="사람이 정한 한도를 넘습니다. 승인 여부는 사람이 판단합니다">⚠ 제약 위반</span>
        )}
      </header>
      <Gist proposal={p} specs={specs} />
      {rank && rank.tier !== "pending" && (
        <p className={`small ${rank.tier === "main" ? "muted" : "warning-text"}`}>
          {rank.tier === "main" ? "순위 이유" : TIER_LABEL[rank.tier]}: {rank.reasons.join(" · ")}
        </p>
      )}

      {p.errors.length > 0 && (
        <ul className="critical-text small">
          {p.errors.map((e, i) => <li key={i}>✕ {e}</li>)}
        </ul>
      )}
      {sim?.error && <p className="critical-text small">✕ 미리 돌려보기 실패: {sim.error}</p>}
      {!!sim?.constraint_violations?.length && (
        <ul className="warning-text small">
          {sim.constraint_violations.map((v, i) => <li key={i}>⚠ {v.message}</li>)}
        </ul>
      )}

      {p.kind === "params" && sim && !sim.error && sim.before && <OutcomeBox proposal={p} />}

      {estimate && (
        <div className="confirm">
          <p>
            {TERMS.spec.label}를 고치는 제안은 {TERMS.ai.label}을 {estimate.level} 레벨로 고치기 전·후 {estimate.runs}번 실행합니다 ({estimate.items}건씩).{" "}
            {estimate.replayed ? (
              <>{TERMS.demo.label}: 저장된 결과를 보여주므로 비용이 들지 않습니다{estimate.estimate_usd != null && <> (원래 실행 비용 {fmtUsd(estimate.estimate_usd)})</>}.</>
            ) : estimate.estimate_usd != null ? <>예상 비용 <strong>{fmtUsd(estimate.estimate_usd)}</strong> (이전 실행 기준).</> : estimate.note}
          </p>
          <button className="primary" onClick={confirmSpec} disabled={busy}>확인하고 실행</button>{" "}
          <button onClick={() => setEstimate(null)}>취소</button>
        </div>
      )}

      {open && (
        <div className="actions">
          {p.kind === "spec" && (
            <>
              <select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="AI 실행 레벨" title="하네스 레벨">
                {Object.keys(harness?.levels ?? { L3: 1 }).map((l) => <option key={l}>{l}</option>)}
              </select>
              <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} aria-label="AI 처리할 건수" title={tip("scope")}>
                {pilotScopes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </>
          )}
          <button onClick={simulate} disabled={busy} title={tip("simulate")}>
            {p.status === "simulated" ? `다시 ${TERMS.simulate.label}` : TERMS.simulate.label}
          </button>
          <input className="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="승인·반려 메모" />
          <input className="approver" value={approver} onChange={(e) => { setApprover(e.target.value); saveApprover(e.target.value); }}
            placeholder="승인자 (선택)" aria-label="승인자 이름" title="변경 이력 카드에 남습니다. 로그인이 없어 직접 적습니다 (이 브라우저에 기억)" />
          <button className="primary" disabled={busy || p.status !== "simulated"}
            title={p.status !== "simulated" ? "미리 돌려본 뒤 승인할 수 있습니다" : undefined}
            onClick={() => guard("승인 반영 중", async () => {
              const r = await api.approve(p.id, note, false, approver);
              onApproved(r.kind === "params"
                ? `${TERMS.params.label}을 v${r.decision?.params_version_after}로 반영했습니다(params.yaml). git 커밋은 직접 해주세요.`
                : `${TERMS.spec.label}에 반영했습니다(domain-spec.md). git 커밋은 직접 해주세요.`);
            })}>
            승인
          </button>
          <button disabled={busy} onClick={() => guard("반려 중", async () => void (await api.reject(p.id, note)))}>반려</button>
        </div>
      )}

      <Details summary={`상세보기 (근거 · 바꿀 내용${sim && !sim.error && sim.before ? " · 전체 지표" : ""})`}>
        <p>{p.body.rationale}</p>
        {p.body.expected_effect && <p className="muted">기대 효과: {p.body.expected_effect}</p>}
        <p className="muted small">해결하려는 문제: {p.body.target_findings.join(", ") || "–"}</p>

        <div className="diff">
          {(p.body.params_changes ?? []).map((c, i) => (
            <div key={i}>
              <code>{c.path}</code>: <span className="old">{JSON.stringify(current ? getPath(current.params, c.path) : "?")}</span> →{" "}
              <span className="new">{JSON.stringify(c.value)}</span>
            </div>
          ))}
          {(p.body.override_rules ?? []).map((r, i) => (
            <div key={i}>
              <span title={tip("overrides")}>{TERMS.overrides.label}</span>: <code>{JSON.stringify(r.when)}</code> 이면{" "}
              <code>{JSON.stringify(r.set)}</code>
            </div>
          ))}
          {(p.body.spec_edits ?? []).map((e, i) => (
            <details key={i}>
              <summary>{TERMS.spec.label}의 “{e.section}” 부분 수정</summary>
              <div className="spec-compare">
                <div><div className="tile-label">현재</div><pre>{current?.spec_sections[e.section] ?? ""}</pre></div>
                <div><div className="tile-label">제안</div><pre>{e.text}</pre></div>
              </div>
            </details>
          ))}
        </div>

        {sim && !sim.error && sim.before && sim.after && p.status !== "proposed" && (
          <div className="sim">
            <div className="tile-label">
              미리 돌려본 결과 ({sim.kind === "spec" ? `${TERMS.ai.label}을 고치기 전·후 문서로 실행` : `${TERMS.rule.label}으로 다시 계산`} · {fmtSeconds(sim.seconds)}
              {sim.cost_usd != null && ` · ${fmtUsd(sim.cost_usd)}`}
              {sim.replayed && " · 저장된 결과"})
            </div>
            <table className="sim-table">
              <thead><tr><th>지표</th><th className="num">전</th><th className="num">후</th><th className="num">변화</th></tr></thead>
              <tbody>
                {specs.filter((s) => s.key in (sim.before ?? {})).map((s) => {
                  const b = sim.before![s.key], a = sim.after![s.key];
                  const d = a - b;
                  return (
                    <tr key={s.key}>
                      <td title={s.tech}>{s.label}</td>
                      <td className="num">{fmtMetric(b, s.format)}</td>
                      <td className="num">{fmtMetric(a, s.format)}</td>
                      <td className="num">{d === 0 ? "–" : fmtMetricDelta(d, s.format)}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td title={tip("violations")}>{TERMS.violations.label}</td>
                  <td className="num">{sim.violations_before ?? 0}건</td>
                  <td className={`num ${sim.violations_after ? "critical-text" : ""}`}>{sim.violations_after ?? 0}건</td>
                  <td />
                </tr>
              </tbody>
            </table>
            {Object.entries(sim.slices ?? {}).map(([fid, s]) => (
              <div key={fid} className="small">
                {fid} 조건의 {s.before.label ?? "실패율"} {(s.before.fail_rate * 100).toFixed(1)}% → {(s.after.fail_rate * 100).toFixed(1)}% ({s.after.items.toLocaleString()}{s.after.unit ?? "건"})
              </div>
            ))}
          </div>
        )}
      </Details>
    </article>
  );
}

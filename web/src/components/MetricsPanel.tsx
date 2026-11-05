import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DecisionRecord, Run } from "../types";
import type { MetricSpec } from "../domains/types";
import { L, TERMS, tip } from "../terms";
import Details from "./Details";

export const fmtMetric = (v: number | null | undefined, f: MetricSpec["format"]) =>
  v === undefined || v === null ? "–" : f === "pct" ? `${(v * 100).toFixed(1)}%`
    : f === "day" ? `${v.toFixed(1)}일` : f === "manwon" ? `${Math.round(v).toLocaleString()}만원` : `${v.toFixed(1)}분`;

// 지표 변화량 (+1.2%p, −3.0분, +1,200만원)
export const fmtMetricDelta = (d: number, f: MetricSpec["format"]) => {
  const sign = d > 0 ? "+" : "";
  if (f === "pct") return `${sign}${(d * 100).toFixed(1)}%p`;
  if (f === "manwon") return `${sign}${Math.round(d).toLocaleString()}만원`;
  return `${sign}${d.toFixed(1)}${f === "day" ? "일" : "분"}`;
};

export const fmtUsd = (v: number | null | undefined) =>
  v === undefined || v === null ? "–" : v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

type CostUsage = { cost_usd?: number | null; input_tokens?: number; output_tokens?: number; cost_estimated?: boolean } | null | undefined;

/** 토큰은 썼는데 단가를 몰라 비용을 못 낸 사용량 (예: 단가를 비워 둔 Azure 모델) */
export const costUnknown = (u: CostUsage) =>
  !!u && u.cost_usd == null && (u.input_tokens ?? 0) + (u.output_tokens ?? 0) > 0;

/** 비용 표시. 단가 미확인이면 "미확인" (value: 건당 비용처럼 사용량에서 계산한 값) */
export const fmtCost = (u: CostUsage, value: number | null | undefined = u?.cost_usd) =>
  costUnknown(u) ? "미확인" : fmtUsd(value) + (u?.cost_estimated && value != null ? " (추정)" : "");

export const fmtSeconds = (v: number | null | undefined) =>
  v === undefined || v === null ? "–" : v < 1 ? `${(v * 1000).toFixed(v < 0.01 ? 2 : 0)}ms` : `${v.toFixed(1)}초`;

export default function MetricsPanel({
  run,
  decisions,
  specs,
  reasonLabels,
  reasonDetails = {},
}: {
  run: Run;
  decisions: DecisionRecord[];
  specs: MetricSpec[];
  reasonLabels: Record<string, string>;
  reasonDetails?: Record<string, string>;
}) {
  const violations = run.violations ?? [];
  const items = run.meta?.items ?? decisions.length;
  const seconds = run.meta?.seconds;
  const cost = run.meta?.usage?.cost_usd;
  const reasons = Object.entries(
    decisions.reduce<Record<string, number>>((acc, d) => {
      if (d.reason_code) acc[d.reason_code] = (acc[d.reason_code] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([code, count]) => ({ code, count, name: reasonLabels[code] ?? code, detail: reasonDetails[code] ?? "" }))
    .sort((a, b) => b.count - a.count);

  const primary = specs.filter((s) => s.primary);
  const rest = specs.filter((s) => !s.primary);
  const metricTile = (s: MetricSpec) => (
    <div className="tile" key={s.key}>
      <div className="tile-label" title={s.tech}>{s.label}</div>
      <div className="tile-value">{fmtMetric(run.metrics?.[s.key], s.format)}</div>
    </div>
  );
  const moreLabel = [`지표 ${rest.length + 1}개 더`, reasons.length ? L(TERMS.reasons.label) : "", violations.length ? `어긴 내용 ${violations.length}건` : ""]
    .filter(Boolean).join(" · ");

  return (
    <div className="metrics">
      {/* 요약: 규칙 위반(공통) · 도메인 핵심 지표 · 건당 비용(공통) */}
      <div className="tiles">
        <div className={`tile ${violations.length ? "tile-critical" : "tile-good"}`}>
          <div className="tile-label" title={tip("violations")}>{TERMS.violations.label}</div>
          <div className="tile-value">
            <span aria-hidden>{violations.length ? "!" : "✓"}</span> {violations.length}건
          </div>
        </div>
        {primary.map(metricTile)}
        <div className="tile tile-cost">
          <div className="tile-label">건당 비용</div>
          <div className="tile-value">{run.agent === "rule" ? "$0" : fmtCost(run.meta?.usage, cost != null && items ? cost / items : cost)}</div>
          {run.agent === "ai" && run.meta?.usage && (
            <div className="tile-note">
              총 {fmtCost(run.meta.usage)} · {TERMS.llm.label} {run.meta.usage.calls ?? 0}회
              {run.meta.usage.cached_calls ? ` (저장된 응답 재사용 ${run.meta.usage.cached_calls})` : ""}
            </div>
          )}
        </div>
      </div>

      <Details summary={`상세보기 (${moreLabel})`}>
      <div className="tiles">
        {rest.map(metricTile)}
        <div className="tile tile-cost">
          <div className="tile-label">건당 처리 시간</div>
          <div className="tile-value">{fmtSeconds(seconds != null && items ? seconds / items : undefined)}</div>
          <div className="tile-note">총 {fmtSeconds(seconds)}</div>
        </div>
      </div>

      {reasons.length > 0 && (
        <figure className="chart">
          <figcaption title={tip("reasons")}>{L(TERMS.reasons.label)}별 건수</figcaption>
          <ResponsiveContainer width="100%" height={36 + reasons.length * 30}>
            <BarChart data={reasons} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
              <CartesianGrid horizontal={false} stroke="var(--grid)" />
              <XAxis type="number" allowDecimals={false} tick={{ fill: "var(--text-muted)", fontSize: 12 }}
                axisLine={{ stroke: "var(--axis)" }} tickLine={false} />
              <YAxis type="category" dataKey="name" width={180} tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
                axisLine={{ stroke: "var(--axis)" }} tickLine={false} />
              <Tooltip
                cursor={{ fill: "var(--hover-wash)" }}
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <div className="tooltip static">
                      <strong>{payload[0].payload.name}</strong>
                      <div>{payload[0].payload.detail}</div>
                      <div className="muted">{payload[0].payload.code}</div>
                      <div>{payload[0].payload.count}건</div>
                    </div>
                  ) : null
                }
              />
              <Bar dataKey="count" fill="var(--series-1)" radius={[0, 4, 4, 0]} barSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </figure>
      )}

      {violations.length > 0 && (
        <table className="violations">
          <thead>
            <tr><th>항목</th><th title={tip("violationRules")}>어긴 규칙</th><th>내용</th></tr>
          </thead>
          <tbody>
            {violations.slice(0, 50).map((v, i) => (
              <tr key={i}><td>{v.item_id}</td><td>{v.rule}</td><td>{v.message}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      </Details>
    </div>
  );
}

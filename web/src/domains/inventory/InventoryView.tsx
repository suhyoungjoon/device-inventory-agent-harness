import { useEffect, useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ResultViewProps } from "../types";
import { api } from "../../api";
import type { InventoryView as ViewData, PlanRow } from "./types";
import { FAMILY, PHASE } from "./names";

// 결품률 → 칸 배경 (0%는 무색, 10% 이상은 진한 빨강)
function heat(rate: number): string {
  if (rate <= 0) return "transparent";
  const a = Math.min(1, rate / 0.15) * 0.55 + 0.08;
  return `rgba(208, 59, 59, ${a.toFixed(2)})`;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export default function InventoryView(p: ResultViewProps) {
  const [view, setView] = useState<ViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);       // "지점:모델"

  useEffect(() => {
    if (!p.runId) return;
    let alive = true;
    setError(null);
    api.runView<ViewData>(p.runId).then((v) => { if (alive) setView(v); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [p.runId, p.decisions.length]);

  // 분석 발견 강조: 강조 항목(W1-A-M01)의 지점×모델 칸
  const lit = useMemo(() => {
    if (!p.highlight) return null;
    return new Set(p.highlight.map((id) => id.split("-").slice(1).join(":")));
  }, [p.highlight]);

  if (!p.runId) return <p className="muted">실행을 고르면 결과 표가 보입니다.</p>;
  if (error) return <p className="muted">결과 표를 불러오지 못함: {error}</p>;
  if (!view) return <p className="muted">결과 표를 불러오는 중…</p>;

  const branches = [...new Set(view.pairs.map((r) => r.branch))].sort();
  const models = [...new Set(view.pairs.map((r) => r.model))].sort();
  const pair = Object.fromEntries(view.pairs.map((r) => [`${r.branch}:${r.model}`, r]));
  const chosen = pick && pair[pick] ? pick : null;
  const series = chosen
    ? view.cells.filter((c) => `${c.branch}:${c.model}` === chosen).map((c) => ({
        week: `${c.week}주`, 수요: c.demand, 결품: c.lost, 발주: c.order, "판매 전 재고": c.on_hand }))
    : [];

  return (
    <div className="inventory-view">
      <table className="inv-grid">
        <thead>
          <tr>
            <th>모델</th>
            {branches.map((b) => <th key={b}>{view.branches[b] ?? b}</th>)}
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const info = view.models[m];
            return (
              <tr key={m}>
                <th title={`${FAMILY[info.family] ?? info.family} · ${info.maker} · ${PHASE[info.phase] ?? info.phase}`}>
                  {info.name}
                  <span className="muted small"> {PHASE[info.phase] ?? info.phase}</span>
                </th>
                {branches.map((b) => {
                  const key = `${b}:${m}`;
                  const r = pair[key];
                  if (!r) return <td key={b} className="muted">—</td>;
                  const dim = lit && !lit.has(key);
                  return (
                    <td key={b} onClick={() => setPick(key)}
                      className={`inv-cell${chosen === key ? " picked" : ""}${lit?.has(key) ? " lit" : ""}`}
                      style={{ background: heat(r.stockout_rate), opacity: dim ? 0.3 : 1 }}
                      title={`수요 ${r.demand}대 · 결품 ${r.lost}대 · 평균 재고 ${r.avg_stock_days}일`}>
                      {pct(r.stockout_rate)}
                      <span className="muted small"> {r.avg_stock_days}일</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">칸 = 계획 기간 결품률(못 판 수요 ÷ 수요)과 평균 재고일수. 칸을 누르면 주차별 흐름이 보입니다.</p>

      {chosen && (
        <div className="inv-chart">
          <h3>{view.branches[pair[chosen].branch]} · {view.models[pair[chosen].model].name} 주차별 흐름</h3>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="week" stroke="var(--axis)" tick={{ fill: "var(--text-secondary)", fontSize: 12 }} />
              <YAxis stroke="var(--axis)" tick={{ fill: "var(--text-secondary)", fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="수요" fill="var(--series-1)" />
              <Bar dataKey="발주" fill="var(--series-3)" />
              <Bar dataKey="결품" fill="var(--critical)" />
              <Line dataKey="판매 전 재고" stroke="var(--series-2)" strokeWidth={2} dot />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <PlanTable view={view} />
    </div>
  );
}

// 발주 권고표: 규칙 파라미터로 계산한 예측·부족물량과, 이 실행이 낸 발주량·걸린 제약. 결정은 사람이 한다
function PlanTable({ view }: { view: ViewData }) {
  const weeks = [...new Set(view.plan.map((r) => r.week))].sort((a, b) => a - b);
  const [week, setWeek] = useState<number>(weeks[0] ?? 1);
  const rows = view.plan.filter((r) => r.week === week);
  const download = () => downloadCsv(view, view.plan);
  return (
    <details className="inv-plan">
      <summary>
        <strong>발주 권고표</strong> <span className="muted small">— 부족물량과 권고 발주량 (최종 발주는 사람이 정한다)</span>
      </summary>
      <div className="inv-plan-bar">
        <label>
          주차{" "}
          <select value={week} onChange={(e) => setWeek(Number(e.target.value))}>
            {weeks.map((w) => <option key={w} value={w}>{w}주</option>)}
          </select>
        </label>
        <button onClick={download}>CSV 내려받기 ({view.plan.length}행)</button>
        <span className="muted small">행에 마우스를 올리면 근거가 보입니다</span>
      </div>
      <div className="inv-plan-scroll">
        <table className="inv-plan-table">
          <thead>
            <tr>
              <th>지점</th><th>모델</th><th>예측</th><th>현재고</th><th>입고 예정</th><th>부족</th><th>권고 발주</th><th>걸린 제약</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item_id} className={r.constraint ? "constrained" : ""} title={r.evidence}>
                <td>{(view.branches[r.branch] ?? r.branch).replace(/지점$/, "")}</td>
                <td>{view.models[r.model]?.name ?? r.model}</td>
                <td className="num">{Math.round(r.forecast)}</td>
                <td className="num">{r.on_hand}</td>
                <td className="num">{r.on_order}</td>
                <td className="num">{r.need}</td>
                <td className="num"><strong>{r.order}</strong>{r.short > 0 && <span className="bad"> (−{r.short})</span>}</td>
                <td>{r.constraint || <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function downloadCsv(view: ViewData, rows: PlanRow[]) {
  const head = ["주차", "지점", "모델", "예측 수요", "현재고", "입고 예정", "목표 재고", "부족물량", "권고 발주량", "못 산 수량",
                "금액(만원)", "걸린 제약", "근거"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.week, view.branches[r.branch] ?? r.branch, view.models[r.model]?.name ?? r.model,
    r.forecast, r.on_hand, r.on_order, r.target, r.need, r.order, r.short, r.amount, r.constraint, r.evidence].map(esc).join(","));
  const blob = new Blob(["﻿" + [head.map(esc).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "발주_권고표.csv";
  a.click();
  URL.revokeObjectURL(url);
}

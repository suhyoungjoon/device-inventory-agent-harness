import { useState } from "react";
import type { DomainAdapter, Scope } from "../domains/types";
import type { CompareSummary, Dataset, DecisionRecord, DomainInfo, HarnessInfo, Run } from "../types";
import CompareTable from "./CompareTable";
import HarnessPipeline from "./HarnessPipeline";
import HarnessToggle from "./HarnessToggle";
import MetricsPanel, { fmtCost, fmtMetric } from "./MetricsPanel";
import { L, TERMS, tip } from "../terms";
import SidePanel, { SideGroup } from "./SidePanel";

export interface CompareProps {
  domain: DomainInfo;
  adapter: DomainAdapter;
  harness: HarnessInfo | null;
  reasonLabels: Record<string, string>;
  reasonDetails: Record<string, string>;
  seed: number;
  setSeed: (n: number) => void;
  faults: string[];
  toggleFault: (id: string) => void;
  dataset: Dataset | null;
  scopes: Scope[];
  scopeId: string;
  setScopeId: (id: string) => void;
  level: string;
  setLevel: (l: string) => void;
  repeats: number;
  setRepeats: (n: number) => void;
  ruleRun: Run | null;
  aiRuns: Run[];
  shownAiRun: Run | null;
  setShownAiRun: (id: string) => void;
  decisionsOf: (runId: string) => DecisionRecord[] | undefined;
  summary: CompareSummary[];
  selectedItem: string | null;
  onSelectItem: (id: string) => void;
  busy: string | null;
  error: string | null;
  onGenerate: () => void;
  onRunRule: () => void;
  onRunAi: () => void;
}

export default function ComparePanel(p: CompareProps) {
  const ruleDecisions = p.ruleRun ? p.decisionsOf(p.ruleRun.run_id) : undefined;
  const aiDecisions = p.shownAiRun ? p.decisionsOf(p.shownAiRun.run_id) : undefined;
  const scope = p.scopes.find((s) => s.id === p.scopeId);
  const [explain, setExplain] = useState(false);
  const view = (run: Run, decisions: DecisionRecord[]) => (
    <>
      <p.adapter.ResultView
        instance={p.dataset!.instance}
        decisions={decisions}
        dimensions={p.domain.dimensions}
        reasonLabels={p.reasonLabels}
        reasonDetails={p.reasonDetails}
        selected={p.selectedItem}
        onSelect={p.onSelectItem}
        runId={run.run_id}
      />
      <MetricsPanel run={run} decisions={decisions} specs={p.adapter.metrics} reasonLabels={p.reasonLabels}
        reasonDetails={p.reasonDetails} />
    </>
  );

  return (
    <section className="compare">
      <SidePanel>
      <SideGroup title="데이터">
        <label title={tip("seed")}>
          {TERMS.seed.label} <input type="number" value={p.seed} onChange={(e) => p.setSeed(Number(e.target.value))} />
        </label>
        <fieldset>
          <legend className="muted" title={tip("faults")}>{TERMS.faults.label}</legend>
          {p.domain.faults.map((f) => (
            <label key={f.id} title={f.name}>
              <input type="checkbox" checked={p.faults.includes(f.id)} onChange={() => p.toggleFault(f.id)} />
              {f.id}
            </label>
          ))}
        </fieldset>
        {p.dataset && (
          <label className="stack" title={tip("scope")}>
            {TERMS.scope.label}{" "}
            <select value={p.scopeId} onChange={(e) => p.setScopeId(e.target.value)} disabled={!!p.busy}>
              {p.scopes.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
        )}
      </SideGroup>
      <SideGroup title="AI 실행 설정">
        <HarnessToggle harness={p.harness} level={p.level} onChange={p.setLevel} disabled={!!p.busy} />
        {p.harness && (
          <button type="button" className="link-button" aria-expanded={explain} onClick={() => setExplain(!explain)}>
            {explain ? "▾" : "▸"} 하네스 설명 (오른쪽에 펼침)
          </button>
        )}
        <label>
          반복{" "}
          <select value={p.repeats} onChange={(e) => p.setRepeats(Number(e.target.value))}>
            {[1, 2, 3].map((n) => <option key={n} value={n}>{n}회</option>)}
          </select>
        </label>
        {p.harness && (
          <span className="muted small" title="원래 용어: 모델 · effort · 응답 캐시 (configs/llm.yaml)">
            {p.harness.llm.model}{p.harness.llm.effort ? ` · 생각 깊이 ${p.harness.llm.effort}` : ""}
            {p.harness.llm.cache ? " · 같은 요청은 저장된 응답 재사용" : ""}
          </span>
        )}
      </SideGroup>
      </SidePanel>

      {/* 오른쪽 맨 위: 데이터 생성 → 규칙 방식 실행 → AI 방식 실행, 상태 */}
      <div className="run-bar">
        <button onClick={p.onGenerate} disabled={!!p.busy}>데이터 생성</button>
        <button onClick={p.onRunRule} disabled={!!p.busy || !p.dataset} title={tip("rule")}>{TERMS.rule.label} 실행</button>
        <button className="primary" onClick={p.onRunAi} disabled={!!p.busy || !p.dataset} title={tip("ai")}>
          {TERMS.ai.label} 실행 ({p.level})
        </button>
        <div className="status-line" aria-live="polite">
          {p.busy && <span className="muted">{p.busy}…</span>}
          {p.error && <span className="critical-text">✕ {p.error}</span>}
          {p.dataset && !p.busy && (
            <span className="muted">
              {TERMS.dataset.label} {p.dataset.id} · {scope?.label ?? "–"}
            </span>
          )}
        </div>
      </div>

      {explain && p.harness && (
        <HarnessPipeline harness={p.harness} domain={p.domain.name} level={p.level} onChange={p.setLevel}
          disabled={!!p.busy} />
      )}


      {p.ruleRun?.status === "done" && p.shownAiRun?.status === "done" && (
        <Verdict rule={p.ruleRun} ai={p.shownAiRun} specs={p.adapter.metrics} />
      )}

      <div className="split">
        <article className="panel side-rule">
          <h2 title={tip("rule")}>{TERMS.rule.label}</h2>
          {p.dataset?.instance && p.ruleRun && ruleDecisions ? (
            view(p.ruleRun, ruleDecisions)
          ) : (
            <p className="muted empty">
              {p.dataset
                ? L(`${TERMS.rule.label}을 실행하면 배정 결과가 표시됩니다.`)
                : `${TERMS.seed.label}와 ${TERMS.faults.label}를 고르고 데이터를 생성하세요.`}
            </p>
          )}
        </article>
        <article className="panel side-ai">
          <div className="panel-head">
            <h2 title={tip("ai")}>{TERMS.ai.label}</h2>
            {p.aiRuns.length > 0 && (
              <select value={p.shownAiRun?.run_id ?? ""} onChange={(e) => p.setShownAiRun(e.target.value)}
                aria-label="표시할 AI 실행">
                {p.aiRuns.map((r) => (
                  <option key={r.run_id} value={r.run_id}>
                    {r.level} · 반복 {(r.repeat ?? 0) + 1} · {runState(r)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <RunProgressList runs={p.aiRuns} />
          {p.shownAiRun?.status === "error" && (
            <p className="critical-text">✕ 실행 실패: {p.shownAiRun.meta?.error ?? p.shownAiRun.progress?.error}</p>
          )}
          {p.dataset?.instance && p.shownAiRun?.status === "done" && aiDecisions ? (
            view(p.shownAiRun, aiDecisions)
          ) : (
            p.aiRuns.length === 0 && (
              <p className="muted empty">
                하네스 레벨을 고르고 {TERMS.ai.label}을 실행하세요. 같은 건수로 {TERMS.rule.label}도 함께 실행됩니다.
              </p>
            )
          )}
        </article>
      </div>

      <CompareTable rows={p.summary} specs={p.adapter.metrics} />
    </section>
  );
}

// 결론 한 줄 (M8-b): 두 방식의 규칙 위반 · 핵심 지표 · 건당 비용
function Verdict({ rule, ai, specs }: { rule: Run; ai: Run; specs: DomainAdapter["metrics"] }) {
  const primary = specs.filter((s) => s.primary);
  const line = (run: Run) => {
    const v = run.violations?.length ?? 0;
    const items = run.meta?.items;
    const cost = run.meta?.usage?.cost_usd;
    return (
      <>
        <span className={v ? "critical-text" : "good-text"} title={tip("violations")}>{TERMS.violations.label} {v}건</span>
        {primary.map((s) => <span key={s.key} title={s.tech}> · {s.label} {fmtMetric(run.metrics?.[s.key], s.format)}</span>)}
        <span> · 건당 {run.agent === "rule" ? "$0" : fmtCost(run.meta?.usage, cost != null && items ? cost / items : cost)}</span>
      </>
    );
  };
  return (
    <div className="verdict" role="status" aria-label="결론">
      <span><strong>{TERMS.rule.label}</strong> {line(rule)}</span>
      <span><strong>{TERMS.ai.label} ({ai.level})</strong> {line(ai)}</span>
    </div>
  );
}

function runState(r: Run) {
  if (r.status === "done") return "완료";
  if (r.status === "error") return "실패";
  const { done = 0, total = 0 } = r.progress ?? {};
  return total ? `진행 ${Math.round((done / total) * 100)}%` : "대기";
}

function RunProgressList({ runs }: { runs: Run[] }) {
  const active = runs.filter((r) => r.status === "running");
  if (active.length === 0) return null;
  return (
    <ul className="progress-list">
      {active.map((r) => {
        const { done = 0, total = 0 } = r.progress ?? {};
        return (
          <li key={r.run_id}>
            <span className="small">{r.level} · 반복 {(r.repeat ?? 0) + 1}</span>
            <progress max={total || 1} value={done} aria-label={`${r.level} 진행`} />
            <span className="small muted">{done}/{total}</span>
          </li>
        );
      })}
    </ul>
  );
}

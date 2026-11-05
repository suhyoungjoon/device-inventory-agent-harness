import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { L, TERMS } from "../terms";
import SidePanel, { SideGroup } from "./SidePanel";
import Details from "./Details";
import type { DecisionRecord, Run, TraceRecord } from "../types";

type Filter = "all" | "retried" | "held" | "failed";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "retried", label: "다시 시도한 건" },
  { id: "held", label: "차단·승인 대기" },
  { id: "failed", get label() { return L(TERMS.unassigned.label); } },
];

const KIND_LABELS: Record<TraceRecord["kind"], [string, string]> = {   // [쉬운 말, 원래 용어]
  llm: ["AI 응답", "LLM 응답"],
  tool_call: ["조회", "도구 호출"],
  validate: [TERMS.validateLoop.label, "검증"],
  retry: ["다시 시도", "재시도"],
  guardrail: [TERMS.guardrail.label, "가드레일"],
  approval: ["승인", "승인"],
};

const STATUS_MARK: Record<DecisionRecord["status"], string> = {
  success: "●",
  failed: "✕",
  blocked: "✕",
  pending_approval: "◯",
};

function matches(d: DecisionRecord, f: Filter) {
  if (f === "retried") return (d.metrics.retries ?? 0) > 0;
  if (f === "held") return d.status === "blocked" || d.status === "pending_approval";
  if (f === "failed") return d.status === "failed";
  return true;
}

export default function TracePanel({
  runs,
  ruleDecisions,
  decisionsOf,
  selectedItem,
  onSelectItem,
  reasonLabels,
  reasonDetails = {},
  decisionText = defaultDecisionText,
}: {
  runs: Run[];
  ruleDecisions: DecisionRecord[];
  decisionsOf: (runId: string) => DecisionRecord[] | undefined;
  selectedItem: string | null;
  onSelectItem: (id: string) => void;
  reasonLabels: Record<string, string>;
  reasonDetails?: Record<string, string>;
  decisionText?: (decision: Record<string, unknown>) => string; // 도메인 어댑터가 정하는 결정 한 줄
}) {
  const done = runs.filter((r) => r.status === "done");
  const preferred = [...done].reverse().find((r) => r.level === "L5") ?? done[done.length - 1];
  const [runId, setRunId] = useState<string | null>(null);
  const run = done.find((r) => r.run_id === runId) ?? preferred;
  const decisions = (run && decisionsOf(run.run_id)) || [];
  const [filter, setFilter] = useState<Filter>("all");
  const [traces, setTraces] = useState<TraceRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listed = decisions.filter((d) => matches(d, filter));
  const item = selectedItem && decisions.some((d) => d.item_id === selectedItem) ? selectedItem : listed[0]?.item_id;
  const aiRecord = decisions.find((d) => d.item_id === item);
  const ruleRecord = useMemo(() => ruleDecisions.find((d) => d.item_id === item), [ruleDecisions, item]);

  useEffect(() => {
    if (!run || !item) return;
    setTraces(null);
    setError(null);
    api.traces(run.run_id, item).then(setTraces).catch((e) => setError(String(e)));
  }, [run?.run_id, item]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!run) {
    return (
      <section className="panel">
        <p className="muted empty">
          비교 탭에서 {TERMS.ai.label}을 실행하면 결정 과정을 여기서 볼 수 있습니다. 모든 단계를 보려면 {TERMS.trace.label}이 켜진 레벨(L5)로 실행하세요.
        </p>
      </section>
    );
  }

  return (
    <section className="trace">
      <SidePanel>
      <SideGroup title="지금 보는 것">
        <label className="stack">
          실행{" "}
          <select value={run.run_id} onChange={(e) => setRunId(e.target.value)}>
            {done.map((r) => (
              <option key={r.run_id} value={r.run_id}>
                {r.level} · 반복 {(r.repeat ?? 0) + 1} · {r.run_id}
              </option>
            ))}
          </select>
        </label>
      </SideGroup>
      </SidePanel>
      <div className="controls">
        <div className="chips" role="radiogroup" aria-label="항목 필터">
          {FILTERS.map((f) => (
            <button key={f.id} role="radio" aria-checked={filter === f.id}
              className={filter === f.id ? "selected" : undefined} onClick={() => setFilter(f.id)}>
              {f.label} ({decisions.filter((d) => matches(d, f.id)).length})
            </button>
          ))}
        </div>
      </div>

      <div className="trace-split">
        <ul className="item-list" aria-label="항목">
          {listed.map((d) => (
            <li key={d.item_id}>
              <button className={d.item_id === item ? "selected" : undefined} onClick={() => onSelectItem(d.item_id)}>
                <span className={`mark mark-${d.status}`} aria-hidden>{STATUS_MARK[d.status]}</span>
                {d.item_id}
                {(d.metrics.retries ?? 0) > 0 && <span className="badge">다시 시도 {d.metrics.retries}</span>}
              </button>
            </li>
          ))}
        </ul>

        <div className="timeline">
          {aiRecord && <TraceVerdict ai={aiRecord} rule={ruleRecord} traces={traces} />}
          <div className="decision-pair">
            <DecisionCard title={`${TERMS.ai.label} (${run.level})`} record={aiRecord} reasonLabels={reasonLabels} reasonDetails={reasonDetails}
              decisionText={decisionText} />
            <DecisionCard title={TERMS.rule.label} record={ruleRecord} reasonLabels={reasonLabels} reasonDetails={reasonDetails}
              decisionText={decisionText} />
          </div>
          {error && <p className="critical-text">✕ {error}</p>}
          {traces && traces.length === 0 && (
            <p className="muted">
              이 실행({run.level})은 최종 결과만 남겨서 단계 기록이 없습니다. {TERMS.trace.label}이 켜진 레벨(L5)로 실행하면
              AI 응답·조회·자동 검사·다시 시도·위험 결정 막기가 모두 기록됩니다.
            </p>
          )}
          {traces && traces.length > 0 && (
            <>
              <StepFlow traces={traces} />
              <Details summary={`상세보기 (단계 ${traces.length}개 · AI 응답 원문 · 조회 결과 · 토큰)`}>
                <ol className="steps">
                  {traces.map((t) => (
                    <li key={t.step} className={`step step-${t.kind}`}>
                      <div className="step-head">
                        <span className="step-no">{t.step + 1}</span>
                        <strong title={`원래 용어: ${KIND_LABELS[t.kind][1]}`}>{KIND_LABELS[t.kind][0]}</strong>
                      </div>
                      <StepBody trace={t} />
                    </li>
                  ))}
                </ol>
              </Details>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function DecisionCard({
  title,
  record,
  reasonLabels,
  reasonDetails,
  decisionText,
}: {
  title: string;
  record?: DecisionRecord;
  reasonLabels: Record<string, string>;
  reasonDetails: Record<string, string>;
  decisionText: (decision: Record<string, unknown>) => string;
}) {
  const d = record?.decision;
  return (
    <div className="decision-card">
      <div className="tile-label">{title}</div>
      {!record ? (
        <p className="muted">기록 없음 (같은 건수로 실행되지 않음)</p>
      ) : (
        <>
          <div className={{ success: "", pending_approval: "warning-text", failed: "critical-text", blocked: "critical-text" }[record.status]}>
            {STATUS_MARK[record.status]}{" "}
            {d && record.status !== "failed"
              ? decisionText(d)
              : L(TERMS.unassigned.label)}
            {record.reason_code && (
              <span title={`${reasonDetails[record.reason_code] ?? ""} (${record.reason_code})`}>
                {" · "}{reasonLabels[record.reason_code] ?? record.reason_code}
              </span>
            )}
          </div>
          <p className="evidence">{record.evidence}</p>
        </>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<DecisionRecord["status"], string> = {
  get success() { return L("배정"); },
  get failed() { return L(TERMS.unassigned.label); },
  blocked: "차단",
  pending_approval: "승인 대기",
};

function defaultDecisionText(decision: Record<string, unknown>) {
  return Object.values(decision).map(String).join(" ");
}

// 같은 결정인가: 상태와 결정 내용이 모두 같을 때
function sameDecision(a: DecisionRecord, b: DecisionRecord) {
  return a.status === b.status && JSON.stringify(a.decision ?? null) === JSON.stringify(b.decision ?? null);
}

// 결론 카드 (M8-c): 최종 상태 · 규칙 방식과 같은지 · 다시 시도 횟수 · 자동 검사에서 걸린 횟수
function TraceVerdict({ ai, rule, traces }: { ai: DecisionRecord; rule?: DecisionRecord; traces: TraceRecord[] | null }) {
  const retries = ai.metrics.retries ?? 0;
  const failedChecks = (traces ?? []).filter((t) => t.kind === "validate" && Array.isArray(t.output) && t.output.length > 0).length;
  return (
    <div className="verdict" role="status" aria-label="결론">
      <span>
        <strong>{ai.item_id}</strong>{" "}
        <span className={{ success: "good-text", pending_approval: "warning-text", failed: "critical-text", blocked: "critical-text" }[ai.status]}>
          {STATUS_MARK[ai.status]} {TERMS.ai.label}: {STATUS_TEXT[ai.status]}
        </span>
      </span>
      {rule ? (
        sameDecision(ai, rule)
          ? <span className="good-text">{TERMS.rule.label}과 같은 결정</span>
          : <span className="warning-text">{TERMS.rule.label}과 다른 결정 ({STATUS_TEXT[rule.status]})</span>
      ) : (
        <span className="muted">{TERMS.rule.label} 기록 없음</span>
      )}
      <span className={retries ? "warning-text" : "muted"}>다시 시도 {retries}회</span>
      {traces && traces.some((t) => t.kind === "validate") && (
        <span className={failedChecks ? "warning-text" : "muted"}>{TERMS.validateLoop.label}에서 걸림 {failedChecks}회</span>
      )}
    </div>
  );
}

// 단계 흐름 한 줄: AI 응답 → 조회 ×2 → 자동 검사 ✕ → 다시 시도 → … (같은 단계가 이어지면 묶는다)
function StepFlow({ traces }: { traces: TraceRecord[] }) {
  const mark = (t: TraceRecord) => {
    if (t.kind === "validate") return Array.isArray(t.output) && t.output.length > 0 ? " ✕" : " ✓";
    if (t.kind === "guardrail") {
      const a = (t.output as { action?: string } | null)?.action;
      return a === "blocked" ? " ✕" : a === "pending_approval" ? " ◯" : " ✓";
    }
    return "";
  };
  const groups: { label: string; n: number }[] = [];
  for (const t of traces) {
    const label = KIND_LABELS[t.kind][0] + mark(t);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.n += 1;
    else groups.push({ label, n: 1 });
  }
  return (
    <p className="step-flow small" aria-label="단계 흐름">
      {groups.map((g, i) => (
        <span key={i}>
          {i > 0 && <span className="muted"> → </span>}
          <span className={g.label.endsWith("✕") ? "critical-text" : undefined}>{g.label}{g.n > 1 && ` ×${g.n}`}</span>
        </span>
      ))}
    </p>
  );
}

function StepBody({ trace }: { trace: TraceRecord }) {
  const out = trace.output as Record<string, unknown> | null;
  if (trace.kind === "llm") {
    const blocks = (out?.content as { type: string; text?: string; name?: string; input?: unknown; thinking?: string }[]) ?? [];
    const usage = out?.usage as Record<string, number> | undefined;
    return (
      <div>
        {blocks.map((b, i) =>
          b.type === "tool_use" ? (
            <div key={i} className="call">
              → <code>{b.name}</code> <code className="json">{JSON.stringify(b.input)}</code>
            </div>
          ) : (
            <p key={i} className="said">{b.text ?? b.thinking}</p>
          ),
        )}
        {out?.error ? <p className="critical-text">{String(out.error)}</p> : null}
        <div className="muted small">
          {String(out?.stop_reason ?? "")}
          {usage && ` · 입력 ${usage.input_tokens ?? 0} · 캐시 읽기 ${usage.cache_read_input_tokens ?? 0} · 출력 ${usage.output_tokens ?? 0} (토큰)`}
          {out?.from_cache ? " · 저장된 응답 재사용" : ""}
        </div>
      </div>
    );
  }
  if (trace.kind === "tool_call") {
    const input = trace.input as { name: string; input: unknown };
    return (
      <details>
        <summary>
          <code>{input.name}</code> <code className="json">{JSON.stringify(input.input)}</code>
        </summary>
        <pre>{JSON.stringify(trace.output, null, 2)}</pre>
      </details>
    );
  }
  if (trace.kind === "validate") {
    const violations = (trace.output as { rule: string; message: string }[]) ?? [];
    return violations.length === 0 ? (
      <p className="good-text">✓ 규칙 위반 없음</p>
    ) : (
      <ul className="critical-text">
        {violations.map((v, i) => (
          <li key={i}>✕ {v.rule}: {v.message}</li>
        ))}
      </ul>
    );
  }
  if (trace.kind === "retry") {
    return <p className="said">{String(trace.output)}</p>;
  }
  if (trace.kind === "guardrail") {
    const g = out as { action: string; reasons?: string[]; violations?: string[] };
    const label = { confirmed: "✓ 확정", blocked: "✕ 차단", pending_approval: "◯ 승인 대기", pass: "통과" }[g.action] ?? g.action;
    return (
      <p>
        {label}
        {g.reasons && ` — ${g.reasons.join("; ")}`}
        {g.violations && ` — ${g.violations.join(", ")}`}
      </p>
    );
  }
  return <pre>{JSON.stringify(trace.output, null, 2)}</pre>;
}

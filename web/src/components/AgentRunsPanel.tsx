import { useEffect, useMemo, useRef, useState } from "react";
import { api, isGone } from "../api";
import type {
  AgentsGraph, AgentTabHistoryRow, AgentTabInfo, AgentTabSources, AgentTabTimeline, Constraint, DomainInfo, LlmCacheState,
  OpinionHint, TabAgent,
  TimelineEvent,
} from "../types";
import type { DomainAdapter } from "../domains/types";
import GraphCanvas, { type NodeView } from "./GraphCanvas";
import { useSessionState } from "./useStoredId";
import { PLAIN_EDGES, PLAIN_NODES, codeOf, makeTerms, type Terms } from "./agentTerms";
import { fmtMetric } from "./MetricsPanel";
import { constraintText } from "./ImprovementPanel";
import { OpinionHelp, opinionChips } from "./opinionHelp";
import { usePoll } from "./usePoll";
import SidePanel, { SideGroup } from "./SidePanel";

// 에이전트 탭 (M16): 핵심 에이전트를 하나씩 실행하고, 그 처리 흐름(턴 → 도구 → 하네스 검사)을 한 화면에서 본다.
// 실행은 기존 API를 그대로 부른다 (배정 /runs, 분석 /analysis, 개선 /proposals). 의견 정리만 /agent-tab/opinion.

const AGENTS: { id: TabAgent; label: string; desc: string }[] = [
  { id: "dispatch", label: "배정", desc: "지시서를 한 건씩 배정한다. 하네스 레벨에 따라 조회·자동 검사·다시 시도·위험 결정 막기가 붙는다" },
  { id: "analysis", label: "분석", desc: "규칙 실행 결과를 집계 도구로 살펴 문제와 원인을 낸다. 근거 숫자는 근거 검사가 확인한다" },
  { id: "proposals", label: "개선", desc: "분석 리포트를 읽고 규칙 개선안을 낸다. 미리 돌려보기 도구로 시험하고, 코드가 안마다 검사한다" },
  { id: "opinion", label: "의견 정리", desc: "개선안에 대한 현장 의견 한 줄을 제약으로 정리한다. 제약 형식 검사를 통과해야 한다 (사람 확인 전 단계까지)" },
  { id: "supervisor", label: "Supervisor", desc: "분석·개선 에이전트와 미리 돌려보기·파라미터 훑기를 도구로 부르며 다음 행동을 스스로 정하고 판단 보고서를 낸다. 추천은 미리 돌려본 적용 가능한 안만 (코드가 검사). 규칙은 바꾸지 않는다 (반영은 사람이 개선 탭·LangGraph agents 탭에서)" },
];

// 타임라인 이벤트 → 내부 그래프 노드 (agents 탭과 같은 하위 그래프).
// sub: Supervisor처럼 다른 에이전트를 부르는 경우, 그 에이전트의 진행(item이 붙은 줄)은 도구 노드 안의 일이다
function nodeOf(e: TimelineEvent, sub = false): string | null {
  if (sub && e.item) return e.type === "end" ? null : "tools";
  if (e.type === "llm") return "ai";
  if (e.type === "tool") return "tools";
  if (e.type === "item") return "next_item";
  if (e.type === "decision") return "record";
  if (e.type === "check") {
    if (e.label === "자동 검사") return "validate";
    if (e.label === "다시 시도") return "retry";
    if (e.label === "위험 결정 막기") return "guardrail";
    return "check";
  }
  return null;
}


// Supervisor 팀 그림 (supervisor_team): 진행 줄 → 누가 일했는지. 서버 workflow.agents.flow.TEAM_TOOL_NODE와 같다
const TEAM_TOOL: Record<string, string> = {
  run_analysis: "analysis_agent", run_proposals: "proposal_agent", simulate: "engine", sweep: "engine",
  search_knowledge: "search", submit_judgment: "check",
};
const SUB_AGENT: Record<string, { node: string; prefix: string; agent: TabAgent; label: string }> = {
  analysis_agent: { node: "analysis_agent", prefix: "분석", agent: "analysis", label: "분석 에이전트" },
  proposal_agent: { node: "proposal_agent", prefix: "개선", agent: "proposals", label: "개선 에이전트" },
};
function teamNode(e: TimelineEvent): string | null {
  if (e.item) return e.item.startsWith("분석") ? "analysis_agent" : e.item.startsWith("개선") ? "proposal_agent" : null;
  if (e.type === "llm") return "supervisor";
  if (e.type === "tool") return TEAM_TOOL[e.name ?? ""] ?? "supervisor";
  if (e.type === "check") return "check";
  return null;
}
const isTeam = (t: AgentTabTimeline) => t.graph === "supervisor_team";
// 그 줄이 붙을 노드 (팀 그림이면 누가 일했는지, 아니면 에이전트 내부 단계)
const nodeFor = (t: AgentTabTimeline, e: TimelineEvent) => (isTeam(t) ? teamNode(e) : nodeOf(e, t.agent === "supervisor"));

// 도구·검사는 0.1초 안에 끝나 화면이 상태를 읽는 사이(0.7초)에 지나간다. 새로 들어온 줄에 도구·검사가 있으면
// 그 노드를 잠깐(FLASH_MS) 실행 중으로 보여 준다. 화면 표시만이고 실행 속도는 그대로다
const FLASH_MS = 1200;
function useFlash(t: AgentTabTimeline | null): string | null {
  const [flash, setFlash] = useState<string | null>(null);
  const seen = useRef<{ id: string | null; n: number }>({ id: null, n: 0 });
  useEffect(() => {
    if (!t) return;
    const prev = seen.current.id === t.id ? seen.current.n : t.events.length;   // 다른 실행으로 바뀌면 처음부터
    seen.current = { id: t.id, n: t.events.length };
    if (!t.live || t.events.length <= prev) return;
    const fresh = t.events.slice(prev);
    const viaTools = t.agent === "supervisor";
    const hit = [...fresh].reverse().find((e) => e.type === "tool" || e.type === "check" || (viaTools && e.item));
    const node = hit ? nodeFor(t, hit) : null;
    if (!node) return;
    setFlash(node);
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [t?.id, t?.events.length, t?.live]); // eslint-disable-line react-hooks/exhaustive-deps
  return t?.live ? flash : null;
}

// 실행 중 지금 일하는 노드. 타임라인 줄은 일이 끝난 뒤에 생기므로(AI 판단 줄은 AI 응답이 와야 생긴다),
// 마지막 줄의 다음 차례를 본다: 도구 결과·반려·재요청·다음 항목 뒤에는 AI가 생각하는 중이다
function workingNode(t: AgentTabTimeline): string | null {
  if (!t.live) return null;
  const e = t.events[t.events.length - 1];
  if (!e) return t.agent === "dispatch" ? "next_item" : isTeam(t) ? "supervisor" : "ai";
  if (isTeam(t)) {   // 팀 그림: 부른 에이전트가 일하는 중이면 그 에이전트, 요청을 보냈으면 받는 쪽, 답이 왔으면 Supervisor
    if (e.item) return teamNode(e);
    if (e.type === "llm") return TEAM_TOOL[(e.tools ?? [])[0] ?? ""] ?? "supervisor";
    if (e.type === "tool" || (e.type === "check" && !e.ok)) return "supervisor";
    return teamNode(e);
  }
  if (t.agent === "supervisor" && e.item) return "tools";          // Supervisor가 부른 에이전트가 일하는 중
  if (e.type === "llm") return (e.tools ?? []).length || /^\d+번째: (?!글로만)/.test(e.text) ? "tools" : nodeOf(e);
  if (e.type === "tool" || e.type === "item" || e.type === "nudge") return "ai";
  if (e.type === "check" && (e.label === "다시 시도" || !e.ok)) return "ai";
  if (e.type === "decision") return "next_item";
  return nodeOf(e);
}

const fmtNum = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString());

// 배정 에이전트가 처리할 지시서 수 상한 (처리 순서 앞 N건, AI 비용·시간 때문)
const MAX_ITEMS = 100;

export default function AgentRunsPanel({
  domain,
  adapter,
  seed,
  faults,
  onOpenReport,
  onOpenBatch,
}: {
  domain: DomainInfo;
  adapter: DomainAdapter;
  seed: number;
  faults: string[];
  onOpenReport?: (reportId: string) => void;   // 분석 리포트를 문제 찾기 탭에서 연다
  onOpenBatch?: (batchId: string) => void;     // 개선안 묶음을 개선 제안 탭에서 연다
}) {
  const [agent, setAgent] = useSessionState<TabAgent>("agentTab.agent", "dispatch");
  const [info, setInfo] = useState<AgentTabInfo | null>(null);
  const [sources, setSources] = useState<AgentTabSources | null>(null);
  const [history, setHistory] = useState<AgentTabHistoryRow[]>([]);
  const [graph, setGraph] = useState<AgentsGraph | null>(null);
  const [current, setCurrent] = useSessionState<{ agent: TabAgent; id: string } | null>("agentTab.current", null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 입력
  const [items, setItems] = useSessionState("agentTab.items", 10);
  const [level, setLevel] = useSessionState("agentTab.level", "L5");
  const [ruleRun, setRuleRun] = useSessionState("agentTab.ruleRun", "");
  const [perspectives, setPerspectives] = useSessionState("agentTab.perspectives", false);
  const [reportId, setReportId] = useSessionState("agentTab.reportId", "");
  const [useSaved, setUseSaved] = useSessionState("agentTab.useSaved", true);
  const [proposalId, setProposalId] = useSessionState("agentTab.proposalId", "");
  const [opinion, setOpinion] = useSessionState("agentTab.opinion", "관할 밖 4km 초과 출동 불가");
  const [cache, setCache] = useState<LlmCacheState | null>(null);   // AI 응답 캐시 (서버 전체)
  const [hints, setHints] = useState<OpinionHint[]>([]);            // 의견 추천 재료 (고른 개선안 기준, 코드 계산)

  const refreshSources = () => api.agentTabSources().then((s) => {
    setSources(s);
    // 기억해 둔 값이 목록에 없으면(지워졌거나 서버가 바뀜) 첫 항목으로
    const keep = (v: string, rows: { id: string }[]) => (rows.some((r) => r.id === v) ? v : rows[0]?.id || "");
    setRuleRun((v) => keep(v, s.rule_runs));
    setReportId((v) => keep(v, s.reports));
    setProposalId((v) => keep(v, s.proposals));
  }).catch(() => undefined);
  useEffect(() => { api.agentTabInfo().then(setInfo).catch((e) => setError(String(e.message ?? e))); refreshSources(); }, []);
  useEffect(() => { api.llmCache().then(setCache).catch(() => setCache(null)); }, []);
  useEffect(() => {
    if (agent !== "opinion" || !proposalId) { setHints([]); return; }
    api.proposalOpinionHints(proposalId).then((r) => setHints(r.hints)).catch(() => setHints([]));
  }, [agent, proposalId]);
  const toggleCache = (enabled: boolean) => api.setLlmCache(enabled).then(setCache).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { api.agentTabHistory(agent).then(setHistory).catch(() => setHistory([])); }, [agent, current?.id]);
  const graphLevel = agent === "dispatch" ? level : "L5";
  const graphMode = agent === "supervisor" ? "supervisor" : "fixed";   // Supervisor 내부 그림은 supervisor 모드 그래프에만 있다
  useEffect(() => { api.agentsGraph(graphLevel, undefined, false, undefined, graphMode).then(setGraph).catch(() => setGraph(null)); },
    [graphLevel, graphMode]);

  const timeline = usePoll<AgentTabTimeline>(
    current ? () => api.agentTabTimeline(current.agent, current.id).catch((e) => {
      if (isGone(e)) setCurrent(null);   // 기억한 실행이 서버에 없으면 처음 화면으로
      throw e;
    }) : null,
    (t) => !t.live && t.status !== "running",
    [current?.agent, current?.id], 700,
  );
  const terms = useMemo(() => makeTerms(adapter, domain.dimensions), [adapter, domain.dimensions]);
  const shown = timeline && current && timeline.id === current.id ? timeline : null;
  const flash = useFlash(shown);
  useEffect(() => {
    if (!shown || shown.live || shown.status === "running") return;
    refreshSources();
    api.agentTabHistory(shown.agent).then(setHistory).catch(() => undefined);   // 실행 중에 읽은 상태가 남지 않게
  }, [shown?.status, shown?.live]);

  const me = info?.agents.find((a) => a.agent === agent);
  const missing = agent === "analysis" || agent === "supervisor" ? !ruleRun : agent === "proposals" ? !reportId
    : agent === "opinion" ? !proposalId || !opinion.trim() : false;

  async function start() {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      let id: string;
      if (agent === "dispatch") {
        const ds = await api.createDataset(domain.name, seed, faults);
        const full = await api.dataset(domain.name, ds.id);
        const scope = (full.item_ids ?? []).slice(0, items);
        const res = await api.aiRuns(ds.id, { level, scope });
        id = res.runs[0].run_id;
      } else if (agent === "analysis") {
        id = (await api.analyze(ruleRun, { perspectives })).id;
      } else if (agent === "proposals") {
        id = (await api.proposeWith(reportId, useSaved)).id;
      } else if (agent === "supervisor") {
        id = (await api.agentTabSupervisor(ruleRun, useSaved)).id;
      } else {
        id = (await api.agentTabOpinion(proposalId, opinion.trim())).id;
      }
      setCurrent({ agent, id });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  // 비교 탭의 데이터 번호·심어둔 문제로 만든 규칙 실행 (전체 범위, 지금 설정 버전). 있으면 다시 만들지 않는다
  const sameKey = [...faults].sort().join(",");
  const sameRuleRun = sources?.rule_runs.find((r) => r.seed === seed && r.full && r.current_params
    && [...(r.faults ?? [])].sort().join(",") === sameKey);

  async function ruleBaseline() {   // 지금 조건의 규칙 실행 (규칙 엔진, 비용 0)
    if (sameRuleRun) {
      setRuleRun(sameRuleRun.id);
      return;
    }
    setBusy(true);
    try {
      const ds = await api.createDataset(domain.name, seed, faults);
      const run = await api.ruleRun(ds.id, {});
      await refreshSources();
      setRuleRun(run.run_id);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const latestSaved = history.find((h) => h.status === "done");

  return (
    <section className="agent-tab">
      <SidePanel>
      <SideGroup title="에이전트 설명">
          <p className="muted small">{AGENTS.find((a) => a.id === agent)?.desc}</p>

      </SideGroup>
      <SideGroup title="입력">
          <div className="agent-inputs">
            {agent === "dispatch" && (
              <>
                <p className="small">데이터 번호 {seed} · 심어둔 문제 {faults.join("·") || "없음"} <span className="muted">(비교 탭 설정)</span></p>
                <label title="처리 순서 앞에서부터 (1~100건). 늘리면 시간·비용이 건수만큼 늘어난다 (10건 약 1분 · $0.015)">지시서 건수 (1~100) <input type="number" min={1} max={MAX_ITEMS} value={items}
                  onChange={(e) => setItems(Math.max(1, Math.min(MAX_ITEMS, Number(e.target.value) || 1)))} /></label>
                <label title="L5면 단계마다 기록이 남아 끝난 뒤에도 같은 타임라인을 다시 볼 수 있다">하네스 레벨{" "}
                  <select value={level} onChange={(e) => setLevel(e.target.value)}>
                    {["L0", "L1", "L2", "L3", "L4", "L5"].map((l) => <option key={l}>{l}</option>)}
                  </select>
                </label>
              </>
            )}
            {(agent === "analysis" || agent === "supervisor") && (
              <>
                <label>규칙 실행 결과{" "}
                  <select value={ruleRun} onChange={(e) => setRuleRun(e.target.value)}>
                    {(sources?.rule_runs ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </label>
                <button disabled={busy || sameRuleRun?.id === ruleRun} onClick={ruleBaseline}
                  title="비교 탭에 설정된 데이터 번호·심어둔 문제로 규칙 방식 전체 실행을 고른다. 없으면 새로 만든다 (규칙 엔진만 써서 AI 비용 없음)">
                  {sameRuleRun ? (sameRuleRun.id === ruleRun ? "지금 조건의 실행을 고름" : "지금 조건의 실행 고르기")
                    : "지금 조건으로 규칙 방식 실행 (비용 0)"}
                </button>
                <span className="muted small">지금 조건: 데이터 {seed} · 심어둔 문제 {faults.join("·") || "없음"} (비교 탭 설정)</span>
                {agent === "analysis"
                  ? <label><input type="checkbox" checked={perspectives} onChange={(e) => setPerspectives(e.target.checked)} /> 관점별로 분석</label>
                  : <label><input type="checkbox" checked={useSaved} onChange={(e) => setUseSaved(e.target.checked)} /> 저장된 제약 사용</label>}
              </>
            )}
            {agent === "proposals" && (
              <>
                <label>분석 리포트{" "}
                  <select value={reportId} onChange={(e) => setReportId(e.target.value)}>
                    {(sources?.reports ?? []).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                </label>
                {!sources?.reports.length && <p className="muted small">분석 리포트가 없습니다. 분석 에이전트를 먼저 실행하세요.</p>}
                <label><input type="checkbox" checked={useSaved} onChange={(e) => setUseSaved(e.target.checked)} /> 저장된 제약 사용</label>
              </>
            )}
            {agent === "opinion" && (
              <>
                <label>개선안{" "}
                  <select value={proposalId} onChange={(e) => setProposalId(e.target.value)}>
                    {(sources?.proposals ?? []).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </label>
                {!sources?.proposals.length && <p className="muted small">개선안이 없습니다. 개선 에이전트를 먼저 실행하세요.</p>}
                <label>의견 한 줄 <input value={opinion} onChange={(e) => setOpinion(e.target.value)} /></label>
                <OpinionHelp chips={opinionChips(hints, adapter)} onPick={setOpinion} />
              </>
            )}
          </div>

      </SideGroup>
      {cache && !cache.demo && (
        <SideGroup title="선택">
          {cache && !cache.demo && (
            <label className="small agent-cache" title={`서버 전체 설정 (${cache.source}). 켜면 AI에게 보내는 입력이 이전과 똑같을 때 API를 부르지 않고 저장된 응답을 그대로 쓴다(비용 0, 결과도 같다). 끄면 매번 실제로 부른다(비용). 다음 실행부터 적용`}>
              <input type="checkbox" checked={cache.enabled} onChange={(e) => toggleCache(e.target.checked)} />{" "}
              저장된 AI 응답 재사용 (캐시)
              <span className="muted"> {cache.enabled ? "· 같은 입력이면 비용 0, 결과 같음" : "· 매번 실제 호출 (비용)"}</span>
            </label>
          )}
        </SideGroup>
      )}
      </SidePanel>

      {/* 오른쪽 맨 위: 에이전트 고르기 → 실행, 지난 실행(누르면 펼침) */}
      <div className="agent-run-bar">
          <div className="agent-list agent-list-row" role="radiogroup" aria-label="에이전트">
            {AGENTS.map((a) => (
              <button key={a.id} role="radio" aria-checked={agent === a.id} className={agent === a.id ? "agent-pick active" : "agent-pick"}
                title={a.desc} onClick={() => { setAgent(a.id); setConfirming(false); setError(null); }}>
                <strong>{a.label}</strong>
                <span className="muted small">{info?.agents.find((x) => x.agent === a.id)?.model ?? ""}</span>
              </button>
            ))}
          </div>
          {!confirming ? (
            <button className="primary" disabled={busy || missing || !me} onClick={() => setConfirming(true)}>실행</button>
          ) : (
            <div className="agent-confirm" role="alertdialog" aria-label="실행 확인">
              {info?.demo ? (
                <p className="small">{info.note}. 비용이 들지 않습니다.</p>
              ) : (
                <p className="small">실제 AI로 실행합니다 (비용).<br />
                  제공사 <strong>{me?.provider}</strong> · 모델 <strong>{me?.model}</strong>
                  {me?.effort ? ` · 생각 깊이 ${me.effort}` : ""}<br />호출 상한: {me?.max_calls}
                  <br />캐시: {cache?.enabled ? "켬 (이전과 같은 입력이면 저장된 응답, 비용 0)" : "끔 (매번 실제 호출)"}</p>
              )}
              <button className="primary" onClick={start}>실행</button> <button onClick={() => setConfirming(false)}>취소</button>
            </div>
          )}
          {error && (
            <div className="critical-text small agent-error">
              ✕ {error}
              {latestSaved && (
                <div><button onClick={() => { setError(null); setCurrent({ agent, id: latestSaved.id }); }}>
                  최근 저장된 실행 보기 ({latestSaved.label})</button></div>
              )}
            </div>
          )}

        <details className="agent-history-box">
          <summary>지난 실행 보기 ({history.length}건, 다시 보기는 API 호출 없음)</summary>
          <ol className="agent-history">
            {history.length === 0 && <li className="muted small">아직 없습니다.</li>}
            {history.map((h) => (
              <li key={h.id}>
                <button className={current?.id === h.id ? "link active" : "link"} onClick={() => setCurrent({ agent, id: h.id })}>
                  {h.id}
                </button>{" "}
                <span className="muted small">{h.status === "done" ? "" : `${h.status} · `}{h.label}</span>
              </li>
            ))}
          </ol>
        </details>
      </div>

      <div className="agent-tab-body">
        <div className="agent-tab-main">
          {!current && <div className="panel muted">위에서 에이전트를 고르고 왼쪽에서 입력을 정해 실행하거나, 지난 실행을 펼쳐 고르세요.</div>}
          {current && !shown && <div className="panel muted">불러오는 중…</div>}
          {shown && <Summary t={shown} onOpenReport={onOpenReport} onOpenBatch={onOpenBatch} />}
          {shown && shown.agent === "supervisor" && !shown.live && <SupervisorResult t={shown} adapter={adapter} />}
          {shown && graph && <InnerGraph graph={graph} t={shown} terms={terms} flash={flash} />}
          {shown && (shown.agent === "supervisor"
            ? <SupervisorTimeline t={shown} terms={terms} flash={flash} adapter={adapter} />
            : <Timeline t={shown} terms={terms} flash={flash} />)}
        </div>
      </div>
    </section>
  );
}

function Summary({ t, onOpenReport, onOpenBatch }: {
  t: AgentTabTimeline; onOpenReport?: (reportId: string) => void; onOpenBatch?: (batchId: string) => void;
}) {
  const u = t.usage;
  const running = t.live || t.status === "running";
  return (
    <div className="panel agent-summary">
      <div className="agent-summary-line">
        <strong>{AGENTS.find((a) => a.id === t.agent)?.label}</strong>{" "}
        <span>{t.input}</span> <span aria-hidden>→</span>{" "}
        <span className={t.status === "error" ? "critical-text" : ""}>
          {running ? "실행 중…" : t.output ?? (t.status === "error" ? `실패: ${t.error ?? ""}` : "–")}
        </span>
      </div>
      <div className="muted small">
        {u.provider ?? "–"} · {u.deployment && u.deployment !== u.model ? `${u.model} (${u.deployment})` : u.model ?? "–"}
        {" · "}호출 {fmtNum(u.calls)}
        {u.cached_calls ? <span title="AI에게 보낸 입력이 이전과 똑같아 API를 부르지 않고 저장된 응답을 썼다 (비용 0)">
          {` (캐시 ${u.cached_calls}${u.calls ? `/${u.calls}` : ""})`}</span> : null}
        {" · "}토큰 입력 {fmtNum(u.input_tokens)}
        {u.cache_read_tokens ? ` + 캐시 ${fmtNum(u.cache_read_tokens)}` : ""} / 출력 {fmtNum(u.output_tokens)}
        {" · "}{u.seconds != null ? `${u.seconds.toFixed(1)}초` : "–"}
        {u.cost_usd != null ? ` · $${u.cost_usd.toFixed(4)}${u.cost_estimated ? " (추정)" : ""}` : running ? "" : " · 비용 미확인"}
        {" · "}<span className="muted">{t.id}</span>
      </div>
      {t.note && <p className="muted small">{t.note}</p>}
      {t.agent === "analysis" && t.status === "done" && onOpenReport && (
        <p>
          <button onClick={() => onOpenReport(t.id)}
            title="발견 카드·근거 데이터·지도 강조·사람 판정을 문제 찾기 탭에서 본다. 다시 분석하지 않으므로 비용이 들지 않는다">
            문제 찾기 탭에서 보기 →
          </button>
        </p>
      )}
      {t.agent === "proposals" && t.status === "done" && onOpenBatch && (
        <p>
          <button onClick={() => onOpenBatch(t.id)}
            title="개선안 카드·순위·미리 돌려보기·사람 승인을 개선 제안 탭에서 본다. 다시 만들지 않으므로 비용이 들지 않는다">
            개선 제안 탭에서 보기 →
          </button>
        </p>
      )}
      {t.agent === "opinion" && !running && <OpinionResult t={t} />}
    </div>
  );
}

// 일반 보기: 노드·연결 이름을 쉬운 말로, 노드 종류·id는 숨김. "기술 정보 보기"를 켜면 LangGraph 탭과 같은 원래 표시
function InnerGraph({ graph, t, terms, flash, title }: {
  graph: AgentsGraph; t: AgentTabTimeline; terms: Terms; flash: string | null; title?: string;
}) {
  const [tech, setTech] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);   // 팀 그림에서 누른 에이전트 (그 내부 그림을 아래에)
  const sub = graph.agents[t.graph];
  const team = isTeam(t);
  const views = useMemo(() => {
    const counts: Record<string, number> = {};
    const last: Record<string, TimelineEvent> = {};
    for (const e of t.events) {
      const n = nodeFor(t, e);
      if (!n) continue;
      if (team && e.item) {      // 부른 에이전트 안의 일은 횟수에 넣지 않는다 (요청 횟수만). 마지막 내용으로만
        last[n] = e;
        continue;
      }
      counts[n] = (counts[n] ?? 0) + 1;
      last[n] = e;
    }
    const lastNode = flash ?? workingNode(t);
    const out: Record<string, NodeView> = {};
    for (const n of sub?.nodes ?? []) {
      const e = last[n.id];
      out[n.id] = {
        state: t.live && lastNode === n.id ? "running" : counts[n.id] ? "done" : "idle",
        badge: counts[n.id] ? `${counts[n.id]}회` : undefined,
        summary: e ? (tech ? e.text : terms.brief(e)) : undefined,
      };
    }
    return out;
  }, [sub, t.events, t.live, tech, terms, flash, team]);
  // 방금 오간 선: 요청을 보냈으면 Supervisor → 받는 쪽, 답이 왔으면 보낸 쪽 → Supervisor
  const active = useMemo(() => {
    const out = new Set<string>();
    const w = t.live ? flash ?? workingNode(t) : null;
    if (team && w && w !== "supervisor") out.add(`supervisor->${w}`);
    const e = t.events[t.events.length - 1];
    if (team && t.live && e && !e.item && e.type === "tool") out.add(`${TEAM_TOOL[e.name ?? ""] ?? "engine"}->supervisor`);
    return out;
  }, [t, flash, team]);
  const plain = useMemo(() => sub && !tech && !team ? {
    nodes: sub.nodes.map((n) => {
      const p = PLAIN_NODES[n.id];
      return p ? { ...n, label: p.label ?? n.label, description: p.description } : n;
    }),
    edges: sub.edges.map((e) => (e.label && PLAIN_EDGES[e.label] ? { ...e, label: PLAIN_EDGES[e.label] } : e)),
  } : sub, [sub, tech, team]);
  if (!sub || !plain) return null;
  const pickedAgent = picked ? SUB_AGENT[picked] : null;
  return (
    <div className="panel gc-panel">
      <h3>{title ?? (team ? "Supervisor와 에이전트들" : "처리 흐름")}{" "}
        <span className="muted small">({team ? "Supervisor가 요청하고 각 에이전트·규칙 엔진이 보고한다 · 횟수는 요청 횟수 · 분석·개선 에이전트 카드를 누르면 그 안의 흐름"
          : "지나간 단계에 횟수 표시"} · 카드에 마우스를 올리면 설명{t.level ? ` · 하네스 ${t.level}` : ""}{t.live ? " · 실행 중" : ""})</span>
        <label className="small gc-tech-toggle" title="노드 종류·id와 원래 이름을 보여 준다 (LangGraph 탭과 같은 표시)">
          <input type="checkbox" checked={tech} onChange={(e) => setTech(e.target.checked)} /> 기술 정보 보기
        </label>
      </h3>
      <GraphCanvas ariaLabel="에이전트 내부 그래프" nodes={plain.nodes} edges={plain.edges} views={views} showIds={tech}
        activeEdges={active} height={team ? 340 : 300} nodeWidth={150} nodeHeight={tech ? 66 : 56} minFitZoom={0.55} padding={0.2}
        onNodeClick={team ? (id) => setPicked(SUB_AGENT[id] ? (picked === id ? null : id) : null) : undefined} />
      <p className="muted small gc-legend">
        {team
          ? "Supervisor에서 나가는 선: 요청(분석 요청·개선 요청·미리 돌려보기·검색·판단 보고서) · 돌아오는 선: 보고(마우스를 올리면 이름) · 점선: Supervisor가 그때그때 고르는 요청"
          : "실선: 항상 이어지는 단계 · 점선: 상황에 따라 고르는 갈림길(선 이름이 조건) · 아래로 도는 선: 앞 단계로 되돌아감(마우스를 올리면 이름)"}
        {t.live ? (team ? " · 파랗게 채운 카드: 지금 일하는 쪽 · 굵게 움직이는 선: 방금 오간 요청·보고"
          : " · 파랗게 채운 카드: 지금 실행 중인 단계 · 굵게 움직이는 선: 방금 지나간 길") : ""}
      </p>
      {pickedAgent && graph.agents[pickedAgent.node] && (() => {
        // 누른 에이전트의 내부 흐름: Supervisor가 부를 때마다 쌓인 그 에이전트의 진행 줄만 (분석 R1, R2 … 모두)
        const mine = t.events.filter((e) => e.item?.startsWith(pickedAgent.prefix));
        const last = t.events[t.events.length - 1];
        const inner: AgentTabTimeline = { ...t, agent: pickedAgent.agent, graph: pickedAgent.node, events: mine,
          live: t.live && !!last?.item?.startsWith(pickedAgent.prefix) };
        return <InnerGraph graph={graph} t={inner} terms={terms} flash={null}
          title={`${pickedAgent.label} 내부 (Supervisor가 부른 ${new Set(mine.map((e) => e.item)).size}번 모두)`} />;
      })()}
    </div>
  );
}

interface Segment { item: string; events: TimelineEvent[] }
function splitByItem(events: TimelineEvent[]): Segment[] {
  const out: Segment[] = [];
  for (const e of events) {
    if (e.type === "item" || !out.length) out.push({ item: e.item ?? "", events: e.type === "item" ? [] : [e] });
    else out[out.length - 1].events.push(e);
  }
  return out;
}

// 지시서 하나: 접힌 머리줄에 요약 (응답·도구 횟수, 검사, 결정), 펼치면 단계마다 한 줄
function ItemSegment({ seg, terms, open }: { seg: Segment; terms: Terms; open: boolean }) {
  const ev = seg.events;
  const llm = ev.filter((e) => e.type === "llm").length;
  const tools = ev.filter((e) => e.type === "tool").length;
  const checks = ev.filter((e) => e.type === "check").map((e) => terms.check(e));
  const bad = checks.filter((c) => c.tone === "bad").length;
  const retry = checks.filter((c) => c.tone === "info").length;
  const decision = [...ev].reverse().find((e) => e.type === "decision");
  return (
    <li className="tl-segment">
      <details open={open}>
        <summary>
          <strong>▸ {seg.item}</strong>
          <span className="muted small"> · 응답 {llm}번 · 도구 {tools}번 · 검사 {checks.length - bad - retry ? `✓${checks.length - bad - retry}` : ""}
            {retry ? ` ↻${retry}` : ""}{bad ? ` ✕${bad}` : ""}</span>
          {decision && <span className="small"> · {terms.decision({ ...decision, item: undefined })}</span>}
        </summary>
        <ol className="agent-timeline tl-segment-rows">
          {groupRepeats(ev).map(({ e, group }) => <TimelineRow key={e.seq} e={e} group={group} terms={terms} showItem={false} />)}
        </ol>
      </details>
    </li>
  );
}

function Timeline({ t, terms, flash }: { t: AgentTabTimeline; terms: Terms; flash: string | null }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && t.live) el.scrollTop = el.scrollHeight;
  }, [t.events.length, t.live]);
  // 실행 중 AI 응답을 기다리는 동안 경과 시간 (도구는 대개 1초 안에 끝나고, 시간은 대부분 AI 판단에 든다)
  const working = workingNode(t);
  const last = t.events[t.events.length - 1];
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!t.live) return;
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [t.live]);
  const waited = last?.at != null ? Math.max(0, Math.round(now - last.at)) : null;
  // 배정은 지시서마다 접는다 (항목 머리줄 ▸ 기준). 펼치면 그 지시서 안의 단계가 한 줄씩
  const segments = useMemo(() => (t.agent === "dispatch" ? splitByItem(t.events) : null), [t.agent, t.events]);
  const [fold, setFold] = useState<{ open: boolean; v: number }>({ open: false, v: 0 });   // 모두 펼치기·접기 (v가 바뀌면 다시 그림)
  return (
    <div className="panel">
      <h3>진행 기록 <span className="muted small">(AI 판단 → 도구 사용 → 검사 · {t.total_events}줄 · 이름 옆 회색 글씨는 실제로 불린 코드
        {segments ? ` · 지시서 ${segments.length}건, 누르면 펼침` : ""}{t.live ? " · 실행 중 한 줄씩 쌓임" : ""})</span>
        {segments && segments.length > 1 && (
          <span className="tl-fold-all">
            <button className="link-button small" onClick={() => setFold({ open: true, v: fold.v + 1 })}>모두 펼치기</button>{" "}
            <button className="link-button small" onClick={() => setFold({ open: false, v: fold.v + 1 })}>모두 접기</button>
          </span>
        )}
      </h3>
      {t.events.length === 0 && <p className="muted small">{t.live ? "첫 응답을 기다리는 중…" : "기록이 없습니다."}</p>}
      <ol className="agent-timeline" ref={ref}>
        {segments
          ? segments.map((seg, i) => (
            <ItemSegment key={`${seg.item}-${fold.v}`} seg={seg} terms={terms}
              open={fold.v ? fold.open : t.live && i === segments.length - 1} />
          ))
          : groupRepeats(t.events).map(({ e, group }) => (
            <TimelineRow key={e.seq} e={e} group={group} terms={terms} showItem={t.agent !== "dispatch"} itemLabels={t.item_labels}
              nested={t.agent === "supervisor" && !!e.item} />
          ))}
        {working === "ai" && !flash && t.events.length > 0 && (
          <li className="tl-thinking muted"><span className="tl-turn" /><span className="tl-kind">AI 판단</span>
            AI가 생각하는 중…{waited != null ? ` ${waited}초` : ""}</li>
        )}
      </ol>
    </div>
  );
}

// 원본(도구 이름·입력·결과 JSON)은 접어 둔다. 디버깅할 때 펼쳐 본다
function Raw({ e }: { e: TimelineEvent }) {
  const name = e.type === "tool" ? e.name : e.type === "llm" && e.tools?.length ? e.tools.join(", ")
    : e.type === "check" || e.type === "nudge" ? e.text : null;
  if (!name && !e.input && !e.output) return null;
  return (
    <details className="tl-raw">
      <summary>자세히</summary>
      {name && <div><code>{name}</code>{e.ref ? <span className="muted"> {e.ref}</span> : null}</div>}
      {e.input ? <div>입력 <code>{e.input}</code></div> : null}
      {e.output ? <div>결과 <code>{e.output}</code></div> : null}
    </details>
  );
}

function TimelineRow({ e, terms, showItem, itemLabels, nested = false, group }: {
  e: TimelineEvent; terms: Terms; showItem: boolean; itemLabels?: Record<string, string>;
  nested?: boolean;   // Supervisor가 부른 에이전트의 줄: 들여 써서 Supervisor 자신의 턴과 나눈다
  group?: TimelineEvent[];   // 연달아 같은 도구를 부른 줄들 (×N으로 한 줄)
}) {
  const n = nested ? " tl-sub" : "";
  const count = group?.length ?? 1;
  const code = <code className="tl-code" title="실제로 불린 코드">{codeOf(e, count)}</code>;
  if (e.type === "item") return <li className="tl-item">▸ {e.item} {code}</li>;
  const turn = e.turn ? <span className="tl-turn" title={`AI의 ${e.turn}번째 응답`}>{e.turn}번째</span> : <span className="tl-turn" />;
  // 배정은 항목 머리줄(▸)로 나뉘므로 줄마다 항목을 붙이지 않는다. 관점별 분석은 관점을 붙인다
  const where = showItem && e.item && e.type !== "decision" ? <span className="muted small"> [{itemLabels?.[e.item] ?? e.item}]</span> : null;
  if (e.type === "llm") {
    return <li className={"tl-llm" + n}>{turn}<span className="tl-kind">AI 판단</span>{code}{terms.aiAsked(e)}{where}<Raw e={e} /></li>;
  }
  if (e.type === "tool") {
    const bad = (group ?? [e]).filter((x) => x.ok === false).length;
    return (
      <li className={(bad ? "tl-tool tl-bad" : "tl-tool") + n}>
        {turn}<span className="tl-kind">도구 사용</span> {terms.tool(e.name ?? e.text)}{code}
        {bad ? <span className="tl-io">→ 오류{count > 1 ? ` ${bad}건` : ""}</span> : null}{where}
        {count > 1 ? <GroupRaw group={group!} /> : <Raw e={e} />}
      </li>
    );
  }
  if (e.type === "check") {
    const c = terms.check(e);
    return (
      <li className={`tl-check tl-${c.tone}${n}`}>
        {turn}<span className="tl-kind">{c.tone === "ok" ? "✓" : c.tone === "bad" ? "✕" : "↻"} {c.label}</span>{code}
        {c.detail}{where}<Raw e={e} />
      </li>
    );
  }
  if (e.type === "decision") return <li className="tl-decision"><span className="tl-turn" /><span className="tl-kind">결정</span>{code}{terms.decision(e)}</li>;
  if (e.type === "nudge") {
    return <li className={"tl-check tl-info" + n}>{turn}<span className="tl-kind">↻ 재요청</span>{code}AI가 글로만 답해서 결과를 제출하라고 다시 요청함<Raw e={e} /></li>;
  }
  if (e.type === "end") return <li className={"tl-end muted" + n}><span className="tl-turn" />{terms.end(e)}{code}{where}</li>;
  return <li className="tl-end muted"><span className="tl-turn" />{e.text}</li>;
}

// 묶인 도구 호출들의 원본 (호출마다 입력·결과)
function GroupRaw({ group }: { group: TimelineEvent[] }) {
  return (
    <details className="tl-raw">
      <summary>자세히</summary>
      {group.map((e) => (
        <div key={e.seq}><code>{e.name}</code>{e.ref ? <span className="muted"> {e.ref}</span> : null}
          {e.input ? <> 입력 <code>{e.input}</code></> : null}{e.output ? <> → <code>{e.output}</code></> : null}</div>
      ))}
    </details>
  );
}

// 연달아 같은 도구를 부른 줄(같은 응답·같은 항목)을 하나로 묶는다. 단계 순서는 그대로
function groupRepeats(events: TimelineEvent[]): { e: TimelineEvent; group?: TimelineEvent[] }[] {
  const out: { e: TimelineEvent; group?: TimelineEvent[] }[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev && e.type === "tool" && prev.e.type === "tool" && prev.e.name === e.name && prev.e.turn === e.turn
        && prev.e.item === e.item) {
      prev.group = [...(prev.group ?? [prev.e]), e];
    } else {
      out.push({ e });
    }
  }
  return out;
}

// Supervisor (M18) 판단 보고서: 추천안(코드가 돌린 미리 돌려보기 요약), 사람에게 묻는 것, 원인 가설·시도 기록
function SupervisorResult({ t, adapter }: { t: AgentTabTimeline; adapter: DomainAdapter }) {
  const j = t.judgment;
  const recs = t.recommendations ?? [];
  const fmt = (k: string, v: number | null) => {
    const f = adapter.metrics.find((m) => m.key === k)?.format;
    return v == null ? "–" : f ? fmtMetric(v, f) : v.toFixed(2);
  };
  const label = (k: string) => adapter.metrics.find((m) => m.key === k)?.label ?? k;
  return (
    <div className="panel judgment-card">
      <h3>판단 보고서 <span className="muted small">(규칙은 바꾸지 않음 · 반영은 개선 탭·LangGraph agents 탭에서 사람이)</span></h3>
      {!j && (
        <p className="critical-text small">
          ✕ {t.failure?.label ?? "판단 보고서 없음"}{t.failure?.reason ? `: ${t.failure.reason}` : ""}
          {(t.problems ?? []).length > 0 && <><br />{(t.problems ?? []).join(" · ")}</>}
        </p>
      )}
      {j?.summary && <p>{j.summary}</p>}
      {recs.length > 0 && (
        <ol className="small">
          {recs.map((r) => (
            <li key={r.proposal_id}>
              <strong>{r.title}</strong> <span className="muted">({r.proposal_id} · 확신도 {r.confidence})</span>
              <br />
              {Object.entries(r.primary).map(([k, [b, a]]) => `${label(k)} ${fmt(k, b)} → ${fmt(k, a)}`).join(" · ")}
              {r.constraint_violations > 0 && <span className="warning-text"> · 제약 위반 {r.constraint_violations}건</span>}
              <br />기대 효과: {r.expected_effect} · 잃는 것: {r.loses}
            </li>
          ))}
        </ol>
      )}
      {j && (j.questions_for_human ?? []).length > 0 && (
        <div className="judgment-ask small">
          <strong>사람에게 묻는 것</strong>
          <ul>{j.questions_for_human.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
      {j && (
        <details className="small">
          <summary>원인 가설 {j.hypotheses.length}개 · 시도 기록 {j.attempts.length}단계 · 추천하지 않은 안 {(j.not_recommended ?? []).length}건</summary>
          <ul>
            {j.hypotheses.map((h, i) => (
              <li key={i}><strong>{h.statement}</strong> (확신도 {h.confidence}) — 지지: {h.support} · 반대: {h.against}
                <br /><span className="muted">뒤집을 증거: {h.would_flip}</span></li>
            ))}
          </ul>
          <ol>{j.attempts.map((a, i) => <li key={i}>{a.what} — {a.why} → <em>{a.learned}</em></li>)}</ol>
          {(j.not_recommended ?? []).length > 0 && (
            <ul>{(j.not_recommended ?? []).map((n, i) => <li key={i}>추천하지 않음 {n.proposal_id}: {n.reason}</li>)}</ul>
          )}
        </details>
      )}
    </div>
  );
}

// 의견 정리 결과: 정리한 제약 + 사람이 확정해 저장 (LangGraph agents 탭의 "제약 확인"과 같은 일)
function OpinionResult({ t }: { t: AgentTabTimeline }) {
  const [saved, setSaved] = useState<string[]>(t.saved ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSaved(t.saved ?? []); setErr(null); }, [t.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const cs = (t.constraints ?? []) as Constraint[];
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      setSaved((await api.agentTabOpinionSave(t.id)).saved);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="small">
      <ul>
        {cs.map((c, i) => <li key={i}>{constraintText(c)} <span className="muted">(<code>{JSON.stringify(c)}</code>)</span></li>)}
        {(t.problems ?? []).map((p, i) => <li key={`p${i}`} className="critical-text">✕ {p}</li>)}
      </ul>
      {t.status === "done" && cs.length > 0 && (saved.length ? (
        <p className="good-text">✓ 제약 {saved.length}개 저장됨. 다음 개선안 요청에서 "저장된 제약 사용"을 켜면 쓰인다 (개선 제안 탭 저장된 제약에서 끄고 켬)</p>
      ) : (
        <p>
          <button className="primary" disabled={busy} onClick={save}
            title="정리한 제약이 의견과 맞으면 확정해 저장한다. 형식은 코드가 다시 검사한다. 저장하면 다음 개선안 요청·LangGraph agents 실행이 불러오고, 의견은 문서 검색 색인에 현장 의견으로 남는다">
            제약 확정해 저장
          </button>{" "}
          <span className="muted">의견과 맞을 때만 저장하세요. 저장 전에는 개선안에 영향이 없습니다</span>
        </p>
      ))}
      {err && <p className="critical-text">✕ {err}</p>}
    </div>
  );
}

// Supervisor 진행 기록 (대화 형식): Supervisor → 받는 쪽 요청, 그 쪽의 진행(접힘), 받는 쪽 → Supervisor 보고.
// 저장된 실행은 서버가 원본에서 만든 messages를, 실행 중에는 진행 줄을 쓴다.
const TEAM_LABEL: Record<string, string> = {
  supervisor: "Supervisor", analysis_agent: "분석 에이전트", proposal_agent: "개선 에이전트", engine: "규칙 엔진",
  search: "문서 검색", check: "보고서 검사",
};

function SupervisorTimeline({ t, terms, flash, adapter }: {
  t: AgentTabTimeline; terms: Terms; flash: string | null; adapter: DomainAdapter;
}) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && t.live) el.scrollTop = el.scrollHeight;
  }, [t.events.length, t.live]);
  // 부른 에이전트의 진행: item("분석 R1", "개선 B1") → 줄들. 같은 종류는 부른 순서대로
  const subs = useMemo(() => {
    const byItem = new Map<string, TimelineEvent[]>();
    for (const e of t.events) if (e.item) byItem.set(e.item, [...(byItem.get(e.item) ?? []), e]);
    return byItem;
  }, [t.events]);
  const order = (prefix: string) => [...subs.keys()].filter((k) => k.startsWith(prefix));
  const headline = adapter.metrics.filter((m) => m.headline || m.primary);
  const fmt = (k: string, v: number | null) => {
    const f = adapter.metrics.find((m) => m.key === k)?.format;
    return v == null ? "–" : f ? fmtMetric(v, f) : v.toFixed(2);
  };
  const working = t.live ? flash ?? workingNode(t) : null;
  const own = t.events.filter((e) => !e.item);
  const seen: Record<string, number> = {};
  const rows: JSX.Element[] = [];
  const subDetails = (to: string, key: string) => {
    const prefix = to === "analysis_agent" ? "분석" : to === "proposal_agent" ? "개선" : null;
    if (!prefix) return null;
    const i = seen[prefix] = (seen[prefix] ?? -1) + 1;
    const item = order(prefix)[i];
    const evs = item ? subs.get(item) ?? [] : [];
    if (!evs.length) return null;
    return (
      <li key={`${key}-sub`} className="tl-subgroup">
        <details open={t.live && working === to}>
          <summary className="muted small">{TEAM_LABEL[to]} 진행 {evs.length}줄 ({item})</summary>
          <ol className="agent-timeline">
            {groupRepeats(evs.map((e) => ({ ...e, item: undefined }))).map(({ e, group }) =>
              <TimelineRow key={e.seq} e={e} group={group} terms={terms} showItem={false} nested />)}
          </ol>
        </details>
      </li>
    );
  };
  own.forEach((e, idx) => {
    const turn = e.turn ? <span className="tl-turn" title={`Supervisor의 ${e.turn}번째 응답`}>{e.turn}번째</span> : <span className="tl-turn" />;
    if (e.type === "llm") {
      const asked = e.tools ?? [];
      if (!asked.length) {
        rows.push(<li key={e.seq} className="tl-msg">{turn}<span className="tl-kind">Supervisor</span> 도구 없이 글로만 답함<Raw e={e} /></li>);
        return;
      }
      // 실행 중이고 아직 보고가 오지 않은 요청: 받는 쪽이 일하는 중
      const answered = own.slice(idx + 1).some((x) => x.type === "tool" || x.type === "check");
      if (t.live && !answered) {
        asked.forEach((name, j) => {
          const to = TEAM_TOOL[name] ?? "supervisor";
          rows.push(<li key={`${e.seq}-p${j}`} className="tl-msg tl-ask">{turn}
            <span className="tl-kind">Supervisor → {TEAM_LABEL[to]}</span> {terms.tool(name)}<code className="tl-code">{name}(…)</code>
            <span className="muted"> · {TEAM_LABEL[to]}가 일하는 중…</span></li>);
          const d = subDetails(to, `${e.seq}-p${j}`);
          if (d) rows.push(d);
        });
      }
      return;
    }
    if (e.type === "tool") {
      const m = t.messages?.[e.ref ?? ""];
      const to = m?.to ?? TEAM_TOOL[e.name ?? ""] ?? "supervisor";
      const ask = m?.ask ?? (terms.args(e.input) || terms.tool(e.name ?? ""));
      const where = m?.slice ? ` · 구간: ${terms.args(JSON.stringify(m.slice))}` : "";
      rows.push(<li key={`${e.seq}-a`} className="tl-msg tl-ask">{turn}
        <span className="tl-kind">Supervisor → {TEAM_LABEL[to]}</span><code className="tl-code">{codeOf(e)}</code>{ask}{where}</li>);
      const d = subDetails(to, String(e.seq));
      if (d) rows.push(d);
      const metrics = m?.metrics ? headline.filter((h) => m.metrics?.[h.key]).map((h) => {
        const [b, a] = m.metrics![h.key];
        return `${h.label} ${fmt(h.key, b)} → ${fmt(h.key, a)}`;
      }).join(" · ") : "";
      rows.push(<li key={`${e.seq}-r`} className={"tl-msg tl-reply" + (e.ok === false ? " tl-bad" : "")}><span className="tl-turn" />
        <span className="tl-kind">{TEAM_LABEL[to]} → Supervisor</span> {m?.reply ?? (e.ok === false ? "오류" : "결과 받음")}
        {metrics && <span className="tl-io"> · {metrics}</span>}<Raw e={e} /></li>);
      return;
    }
    if (e.type === "check") {
      const c = terms.check(e);
      rows.push(<li key={e.seq} className={`tl-msg tl-${c.tone}`}>{turn}
        <span className="tl-kind">보고서 검사 → Supervisor</span><code className="tl-code">{codeOf(e)}</code>{c.tone === "ok" ? "✓ 통과" : `✕ 반려: ${c.detail}`}<Raw e={e} /></li>);
      return;
    }
    if (e.type === "end") rows.push(<li key={e.seq} className="tl-end muted"><span className="tl-turn" />{terms.end(e)}<code className="tl-code">{codeOf(e)}</code></li>);
  });
  return (
    <div className="panel">
      <h3>진행 기록 <span className="muted small">(Supervisor와 에이전트들이 주고받은 요청·보고 · 각 에이전트의 세부 진행은 접혀 있음{t.live ? " · 실행 중 한 줄씩 쌓임" : ""})</span></h3>
      {t.events.length === 0 && <p className="muted small">{t.live ? "Supervisor의 첫 판단을 기다리는 중…" : "기록이 없습니다."}</p>}
      <ol className="agent-timeline" ref={ref}>
        {rows}
        {t.live && working === "supervisor" && !flash && own.length > 0 && (
          <li className="tl-thinking muted"><span className="tl-turn" /><span className="tl-kind">Supervisor</span>생각하는 중…</li>
        )}
      </ol>
    </div>
  );
}

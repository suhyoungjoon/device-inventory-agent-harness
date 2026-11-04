import { useEffect, useRef, useState } from "react";
import { api, isGone } from "../api";
import type { DomainAdapter } from "../domains/types";
import type { AgentEvent, AgentsGraph, AgentsLoop, AgentsMode, AgentsRecord, AgentsRecordRow, AgentsRun, Constraint, DomainInfo, HarnessInfo, JudgmentView } from "../types";
import type { MetricSpec } from "../domains/types";
import { fmtMetric, fmtUsd } from "./MetricsPanel";
import { constraintText } from "./ImprovementPanel";
import { TERMS, tip } from "../terms";
import GraphCanvas, { type NodeView } from "./GraphCanvas";
import AgentsTimeline from "./AgentsTimeline";
import SidePanel, { SideGroup } from "./SidePanel";
import { usePoll } from "./usePoll";
import { useSessionState, useStoredId } from "./useStoredId";
import { opinionChips } from "./opinionHelp";
import { StepBar, type StepAction } from "./WorkflowPanel";

// LangGraph agents (M10, 가로 그래프 M11): 배정·분석·개선 제안 에이전트의 내부까지 LangGraph 하위 그래프로 만든 별도 탭.
// 위 = 상위 그래프(에이전트 단위로 멈춤), 아래 = 고른 에이전트의 내부 그래프. 둘 다 왼쪽→오른쪽 그래프로 그리고,
// 방금 지나간 연결은 움직이는 선으로 보여준다. 맨 아래는 고른 단계의 결과와 실시간 진행 기록.
// 그림은 모두 서버가 컴파일한 그래프(get_graph)로 그린다. 하네스 레벨을 바꾸면 배정 에이전트 그래프 모양이 바뀐다.

const AGENT_NAMES: Record<string, string> = {
  dispatch_agent: "배정 에이전트",
  analysis_agent: "분석 에이전트",
  proposal_agent: "개선 제안 에이전트",
  opinion_agent: "의견 정리 에이전트",
  check_end: "종료 판정 Supervisor",
  supervisor_agent: "Supervisor 지휘 에이전트",
  simulate: "미리 돌려보기 (배정 에이전트 재실행)",
};

const PROVIDER_LABEL: Record<string, string> = { anthropic: "Claude", azure_openai: "Azure OpenAI" };

export default function AgentsPanel({
  domain,
  adapter,
  harness,
  seed,
  faults,
  level,
}: {
  domain: DomainInfo;
  adapter: DomainAdapter;
  harness: HarnessInfo | null;
  seed: number;
  faults: string[];
  level: string;
}) {
  const [form, setForm] = useSessionState("oah.agents.form", {   // 입력값도 탭을 옮겨도 그대로
    seed, faults: faults.length ? faults : domain.faults.map((f) => f.id), items: 10, level,
    llm: "fake" as "fake" | "claude", pace: 0.2, perspectives: false,
    end_check: "fixed" as "fixed" | "supervisor", use_saved_constraints: true,
    mode: "fixed" as AgentsMode,      // M18: 분석·개선 구간을 Supervisor가 지휘 (켜고 끄기, 기본 꺼짐)
    auto: false,                      // 자동 진행: 사람 단계(사람 검토·제약 확인)에서만 멈추고 나머지는 이어서
  });
  // 실제 AI 이름: 서버 설정의 제공사·모델 (값 "claude"는 API 계약상 이름이고 제공사는 서버 설정이 정한다)
  const realAi = `${PROVIDER_LABEL[harness?.llm.provider ?? "anthropic"] ?? harness?.llm.provider} ${harness?.llm.model ?? ""}`.trim();
  const [graph, setGraph] = useState<AgentsGraph | null>(null);
  const [flowId, setFlowId] = useStoredId("oah.agents.flowId", (id) => api.agentsGet(id));   // 탭을 옮겨도 이어서
  const [liveRun, setRun] = useState<AgentsRun | null>(null);
  const [liveEvents, setEvents] = useState<AgentEvent[]>([]);
  // 저장한 실행 기록 재생 (M20): AI를 부르지 않고 단계를 하나씩 드러낸다. 재생 중에는 이 기록이 화면의 실행이다
  const [replay, setReplay] = useState<{ rec: AgentsRecord; n: number } | null>(null);
  const [records, setRecords] = useState<AgentsRecordRow[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const run = replay ? replayRun(replay.rec, replay.n) : liveRun;
  const events = replay ? run!.events : liveEvents;
  useEffect(() => {
    if (!replay || replay.n >= replay.rec.steps.length) return;
    const t = setTimeout(() => setReplay((r) => r && { ...r, n: r.n + 1 }), 400 + form.pace * 4000);
    return () => clearTimeout(t);
  }, [replay, form.pace]);
  const lastI = useRef(-1);
  const [tick, setTick] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 실행 중에는 그 실행의 레벨, 아니면 고른 레벨의 그래프 (레벨을 바꾸면 배정 에이전트 그림이 바로 바뀐다)
  const inFlight = (!!run && run.status !== "done") || !!replay;
  const runLevel = inFlight && run ? run.inputs.level ?? form.level : form.level;
  // 관점별 분석이면 분석 에이전트 그림이 "관점 노드들(병렬) → 합치기"로 바뀐다 (M12-b)
  const runPerspectives = inFlight && run ? !!run.inputs.perspectives : form.perspectives;
  // 종료 판정: 고정 규칙 또는 Supervisor 에이전트 (M15-D). 실행 중에는 그 실행의 방식
  const runEndCheck = inFlight && run ? run.end_check ?? "fixed" : form.end_check;
  // 분석·개선 지휘 (M18): 켜면 상위 그래프의 분석 → 개선 제안 → 미리 돌려보기가 Supervisor 노드 하나로 바뀐다.
  // 실행 전에도 바꾸면 그래프가 바로 그 모드의 모양으로 다시 그려진다 (Supervisor가 있을 때·없을 때 흐름)
  const runMode: AgentsMode = inFlight && run ? run.mode ?? "fixed" : form.mode;

  useEffect(() => {
    api.agentsGraph(runLevel, domain.name, runPerspectives, runEndCheck, runMode).then(setGraph).catch((e) => setError(String(e)));
  }, [runLevel, runPerspectives, runEndCheck, runMode, domain.name]);

  const gone = (e: unknown) => {   // 서버를 다시 띄워 실행이 없으면 계속 묻지 않고 처음 화면으로
    if (isGone(e)) { setFlowId(null); setRun(null); setEvents([]); lastI.current = -1; setError("서버를 다시 띄워 진행 중이던 실행이 사라졌습니다. 처음부터 다시 시작하세요."); }
    throw e;
  };
  const polled = usePoll<AgentsRun>(flowId ? () => api.agentsGet(flowId, lastI.current).catch(gone) : null,
    (r) => r.status !== "running", [flowId, tick], 300);
  useEffect(() => {
    if (!polled || polled.id !== flowId) return;
    setRun(polled);
    const fresh = polled.events.filter((e) => e.i > lastI.current);
    if (fresh.length) {
      lastI.current = fresh[fresh.length - 1].i;
      setEvents((es) => [...es, ...fresh]);
    }
  }, [polled]); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const start = () => guard(async () => {
    setReplay(null);
    setSaved(null);
    const r = await api.agentsStart({ domain: domain.name, ...form, metrics: adapter.metrics });
    lastI.current = -1;
    setEvents([]);
    setPicked(null);
    setRun(r);
    setFlowId(r.id);
    setTick((t) => t + 1);
  });
  const saveRecord = () => guard(async () => {
    if (!flowId) return;
    const r = await api.agentsSave(flowId);
    setSaved(`기록 저장: ${r.id} (${r.steps}단계)`);
    setRecords(null);
  });
  const openRecord = (id: string) => guard(async () => {
    const rec = await api.agentsRecord(id);
    setFlowId(null);
    setRun(null);
    setEvents([]);
    lastI.current = -1;
    setPicked(null);
    setSaved(null);
    setReplay({ rec, n: 0 });
  });
  // 자동 진행: 다음 단계를 기다리는 상태면 "다음 실행"을 대신 누른다 (사람 단계·오류·끝에서는 멈춘다)
  const autoStepped = useRef(-1);
  useEffect(() => {
    if (!form.auto || replay || error || !liveRun || liveRun.status !== "paused" || liveRun.waiting !== "next") return;
    const n = liveRun.steps.length;
    if (autoStepped.current === n) return;
    const t = setTimeout(() => { autoStepped.current = n; step("next"); }, 700);
    return () => clearTimeout(t);
  }, [form.auto, replay, error, liveRun?.status, liveRun?.waiting, liveRun?.steps.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const step = (action: StepAction, constraints?: Constraint[]) => guard(async () => {
    if (!flowId) return;
    setRun(await api.agentsStep(flowId, action, note, constraints));
    setNote("");
    setTick((t) => t + 1);
  });

  if (graph && !graph.available) {
    return (
      <section className="panel">
        <h2>LangGraph agents</h2>
        <p className="warning-text">이 화면은 LangGraph가 필요합니다: {graph.reason}</p>
      </section>
    );
  }

  const topLabel = (id: string) => (id === "__end__" ? "끝" : graph?.top.nodes.find((n) => n.id === id)?.label ?? id);
  const isAgent = (id: string | null | undefined) => !!id && (!!graph?.agents[id] || id === "simulate");
  // 아래 줄에 보일 에이전트: 사람이 고른 것 > 지금 실행 중인 것 > 다음 차례 > 배정 에이전트
  const running = run?.status === "running" ? run.current : null;
  const liveAgent = isAgent(running) ? running : null;
  const nextAgent = run?.next[0] && graph?.agents[run.next[0]] ? run.next[0] : null;
  const shown = (isAgent(picked) ? picked : null) ?? liveAgent ?? nextAgent ?? "dispatch_agent";
  // 결과 칸에 보일 단계: 고른 노드 > 실행 중 > 마지막으로 끝난 단계
  const lastStep = run?.steps[run.steps.length - 1]?.node ?? null;
  const focus = picked ?? running ?? lastStep;
  const levels = Object.keys(harness?.levels ?? { L3: 1 });
  const demo = graph?.demo ?? false;

  // 상위 그래프: 노드 상태·결과 한 줄, 방금 지나간 연결 (마지막으로 끝난 단계 → 지금/다음 단계)
  const topViews: Record<string, NodeView> = {};
  for (const n of graph?.top.nodes ?? []) {
    const steps = run?.steps.filter((s) => s.node === n.id) ?? [];
    topViews[n.id] = {
      state: nodeState(n.id, run),
      summary: steps.length ? steps[steps.length - 1].lines[0] : undefined,
      badge: steps.length > 1 ? `${steps.length}회` : undefined,
      selected: n.id === shown || n.id === picked,
    };
  }
  const topActive = new Set<string>();
  const towards = running ?? run?.next[0];
  if (run && towards) topActive.add(`${lastStep ?? "__start__"}->${towards}`);

  return (
    <section className="workflow agents">
      <SidePanel>
      <SideGroup title="데이터 (기본값)">
        <label title={tip("seed")}>
          {TERMS.seed.label} <input type="number" value={form.seed} onChange={(e) => setForm({ ...form, seed: Number(e.target.value) })} />
        </label>
        <fieldset>
          <legend className="muted" title={tip("faults")}>{TERMS.faults.label}</legend>
          {domain.faults.map((f) => (
            <label key={f.id} title={f.name}>
              <input type="checkbox" checked={form.faults.includes(f.id)}
                onChange={() => setForm({ ...form, faults: form.faults.includes(f.id) ? form.faults.filter((x) => x !== f.id) : [...form.faults, f.id].sort() })} />
              {f.id}
            </label>
          ))}
        </fieldset>
        <label title="처리 순서 앞에서부터 이 건수만 배정 에이전트가 처리한다 (비용 때문)">
          처리할 건수 (1~100) <input type="number" min={1} max={100} value={form.items}
            onChange={(e) => setForm({ ...form, items: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
        </label>
      </SideGroup>
      <SideGroup title="에이전트 설정">
        <label title="배정 에이전트 그래프의 모양을 정한다 (바꾸면 아래 그래프가 바로 다시 그려진다)">
          하네스 레벨{" "}
          <select value={form.level} onChange={(e) => { setForm({ ...form, level: e.target.value }); setPicked("dispatch_agent"); }}
            disabled={!!run && run.status !== "done"}>
            {levels.map((l) => <option key={l}>{l}</option>)}
          </select>
        </label>
        <label title={demo ? "저장된 결과 보기에서는 가짜 AI만 쓴다 (비용 없음)" : `실제 AI(${realAi})는 비용이 든다. 제공사·모델은 configs/llm.yaml (LLM_PROVIDER)`}>
          AI{" "}
          <select value={demo ? "fake" : form.llm} disabled={demo}
            onChange={(e) => setForm({ ...form, llm: e.target.value as "fake" | "claude" })}>
            <option value="fake">가짜 AI (리허설)</option>
            <option value="claude">실제 AI (비용)</option>
          </select>
        </label>
        <label title="분석 에이전트를 관점(실패 패턴·자원 활용·시간 수급)마다 따로 동시에 돌린 뒤 합칩니다 (LangGraph fan-out/fan-in). AI 비용은 관점 수만큼 늘어납니다">
          <input type="checkbox" checked={form.perspectives} disabled={inFlight}
            onChange={(e) => { setForm({ ...form, perspectives: e.target.checked }); setPicked("analysis_agent"); }} />{" "}
          관점별 분석
        </label>
        <label title="이전 실행에서 사람이 확정해 저장한 제약을 처음부터 씁니다 (개선 제안 탭의 저장된 제약에서 끄고 켭니다)">
          <input type="checkbox" checked={form.use_saved_constraints} disabled={inFlight}
            onChange={(e) => setForm({ ...form, use_saved_constraints: e.target.checked })} />{" "}
          저장된 제약 불러오기
        </label>
        <label className="ag-mode" title="켜면 분석 → 개선 제안 → 미리 돌려보기 구간을 Supervisor 에이전트가 지휘합니다. 분석·개선 에이전트와 계산 도구를 도구로 부르며 다음 행동을 스스로 정하고, 판단 보고서(추천안·원인 가설·시도 기록·사람에게 묻는 것)를 냅니다. 반영은 그대로 사람 승인. 끄면 지금의 고정 흐름">
          <input type="checkbox" checked={form.mode === "supervisor"} disabled={inFlight}
            onChange={(e) => { setForm({ ...form, mode: e.target.checked ? "supervisor" : "fixed" });
              setPicked(e.target.checked ? "supervisor_agent" : "analysis_agent"); }} />{" "}
          Supervisor 지휘
        </label>
        <label title="회차가 끝났을 때 다음 단계를 누가 고를지. Supervisor는 허용된 단계(다음 회차·다시 제안·결과 보고) 중에서만 고르고, 최대 회차는 코드가 막습니다">
          종료 판정{" "}
          <select value={form.end_check} disabled={inFlight}
            onChange={(e) => { setForm({ ...form, end_check: e.target.value as "fixed" | "supervisor" }); setPicked("check_end"); }}>
            <option value="fixed">고정 규칙</option>
            <option value="supervisor">Supervisor 에이전트</option>
          </select>
        </label>
        <label title="켜면 다음 실행을 누르지 않아도 단계를 이어서 진행하고, 사람 검토·제약 확인에서만 멈춥니다. 사람 단계를 마치면 다시 이어 갑니다">
          <input type="checkbox" checked={!!form.auto} onChange={(e) => setForm({ ...form, auto: e.target.checked })} />{" "}
          자동 진행 (사람 단계에서만 멈춤)
        </label>
        <label title="내부 단계 사이 간격. 가짜 AI는 너무 빨라 눈으로 따라가기 어렵다">
          속도{" "}
          <select value={form.pace} onChange={(e) => setForm({ ...form, pace: Number(e.target.value) })}>
            <option value={0}>바로</option>
            <option value={0.1}>빠르게</option>
            <option value={0.2}>보통</option>
            <option value={0.5}>천천히</option>
          </select>
        </label>
      </SideGroup>
      </SidePanel>

      {/* 오른쪽 맨 위: 실행과 단계 진행 (왼쪽은 기본값·선택 항목) */}
      <div className="run-bar">
        <button className="primary" onClick={start} disabled={!graph || run?.status === "running"}>
          {run ? "처음부터 다시" : "에이전트 준비"}
        </button>
        <span className="badge" title="에이전트 내부까지 LangGraph StateGraph 하위 그래프">LangGraph</span>
        <button disabled={!liveRun || liveRun.status === "running" || !!replay} onClick={saveRecord}
          title="이 실행의 단계 기록을 파일로 저장합니다 (runs/agents_flows). 서버를 다시 켜도, 시연 모드에서도 다시 열어 재생할 수 있습니다">
          기록 저장
        </button>
        {records === null ? (
          <button onClick={() => guard(async () => setRecords(await api.agentsRecords()))} title="저장한 실행 기록을 열어 타임라인·그래프 진행을 재생합니다 (AI 호출 없음)">
            기록 열기
          </button>
        ) : (
          <select value="" aria-label="저장한 실행 기록" onChange={(e) => e.target.value && openRecord(e.target.value)}>
            <option value="">{records.length ? "기록 고르기…" : "저장한 기록 없음"}</option>
            {records.map((r) => (
              <option key={r.id} value={r.id}>
                {r.saved_at ? new Date(r.saved_at * 1000).toLocaleString("ko-KR") : r.id} · {r.mode === "supervisor" ? "Supervisor" : "고정 흐름"}
                {" "}· {r.rounds}회차 {r.steps}단계 · {r.llm === "claude" ? "실제 AI" : "가짜 AI"}{r.cost_usd != null ? ` · $${r.cost_usd.toFixed(2)}` : ""}
              </option>
            ))}
          </select>
        )}
      <div className="status-line" aria-live="polite">
        {error && <span className="critical-text">✕ {error}</span>}
        {saved && <span className="good-text small">✓ {saved}</span>}
        {replay && (
          <span className="small">
            저장된 기록 재생: {replay.rec.id} · {Math.min(replay.n, replay.rec.steps.length)}/{replay.rec.steps.length}단계 (AI 호출 없음){" "}
            <button className="link-button" onClick={() => setReplay({ ...replay, n: 0 })}>처음부터 재생</button>{" "}
            <button className="link-button" onClick={() => setReplay({ ...replay, n: replay.rec.steps.length })}>끝으로</button>{" "}
            <button className="link-button" onClick={() => setReplay(null)}>닫기</button>
          </span>
        )}
        {run && <span className="muted small">AI: {run.llm === "fake" ? "가짜 AI (수치는 AI 성능과 무관)" : `실제 AI · ${realAi}`}</span>}
      </div>
      </div>

      {run?.waiting === "approval" && run.approval?.kind === "confirm_constraints" ? (
        <ConfirmConstraints key={run.steps.length} ask={run.approval} onConfirm={(cs) => step("confirm", cs)}
          onRewrite={() => step("reject")} />
      ) : (
      <StepBar run={run} nextLabel={run?.next[0] ? topLabel(run.next[0]) : null}
        currentLabel={run?.current ? topLabel(run.current) : null} note={note} setNote={setNote} onStep={step}
        approval={run?.approval ?? null}
        opinionChips={run?.approval && !run.approval.kind ? opinionChips(run.approval.opinion_hints, adapter) : undefined}
        idleText="입력을 고르고 [에이전트 준비]를 누르면 첫 단계 앞에서 멈춥니다. 에이전트 하나가 끝날 때마다 멈춥니다."
        doneText="그래프의 노드를 누르면 그 단계의 결과와 에이전트 내부를 다시 볼 수 있습니다." />
      )}

      {graph && (
        <div className="panel gc-panel">
          <h2>상위 그래프 <span className="muted small">(StateGraph · {runMode === "supervisor" ? "Supervisor 지휘" : "고정 흐름"} · 노드를 누르면 아래에 내부·결과)</span></h2>
          <GraphCanvas ariaLabel="상위 그래프" nodes={graph.top.nodes} edges={graph.top.edges} views={topViews}
            activeEdges={topActive} onNodeClick={(id) => !id.startsWith("__") && setPicked(picked === id ? null : id)}
            height={320} nodeWidth={160} nodeHeight={74} minFitZoom={0.82} follow={towards ?? lastStep ?? "__start__"} />
          <Legend />
        </div>
      )}

      {graph && (
        <AgentsTimeline steps={run?.steps ?? []} running={running} label={topLabel} picked={picked}
          events={events} innerLabel={(agent, node) => graph.agents[agent === "simulate" ? "dispatch_agent" : agent]?.nodes.find((n) => n.id === node)?.label ?? node}
          runningKind={graph.top.nodes.find((n) => n.id === running)?.kind as "ai" | "rule" | "human" | undefined}
          onPick={(id) => setPicked(picked === id ? null : id)} live={run?.status === "running"} />
      )}

      {run?.waiting === "approval" && run.approval?.judgment && (
        <JudgmentCard key={run.steps.length} j={run.approval.judgment} specs={adapter.metrics}
          dimLabel={(k) => domain.dimensions.dimensions[k]?.label ?? k} valueLabel={(v) => adapter.valueNames?.[v] ?? v} />
      )}

      {run?.loop && <LoopPanel loop={run.loop} specs={adapter.metrics} />}

      <AgentInside graph={graph} agent={shown} run={run} events={events} live={liveAgent === shown} />

      <div className="ag-bottom">
        <div className="panel">
          <h2>{focus ? topLabel(focus) : "단계 결과"} <span className="muted small">{focus ? "결과" : ""}</span></h2>
          <StepResult run={run} node={focus} description={graph?.top.nodes.find((n) => n.id === focus)?.description} />
        </div>
        <EventLog agent={shown} events={events} live={liveAgent === shown} graph={graph} />
      </div>
    </section>
  );
}

// 저장한 기록의 앞 n단계를 실행처럼 보이게 (재생). 내부 진행 기록은 마지막으로 드러난 단계가 끝난 시각까지
function replayRun(rec: AgentsRecord, n: number): AgentsRun {
  const done = n >= rec.steps.length;
  const until = done ? Infinity : rec.steps[n - 1]?.at ?? 0;
  const events = rec.events.filter((e) => e.at <= until);
  const counts: Record<string, Record<string, number>> = {};
  for (const e of events) (counts[e.agent] ??= {})[e.node] = (counts[e.agent][e.node] ?? 0) + 1;
  return {
    id: rec.id, status: done ? "done" : "running", current: done ? null : rec.steps[n].node, error: null, next: [],
    waiting: null, approval: null, steps: rec.steps.slice(0, n), llm: rec.llm, events, counts,
    last_event: events[events.length - 1] ?? null, proposals: done ? rec.proposals : [], inputs: rec.inputs,
    loop: done ? rec.loop : undefined, end_check: rec.graph.end_check, mode: rec.graph.mode,
  };
}

type NodeState = NonNullable<NodeView["state"]>;

function nodeState(id: string, run: AgentsRun | null): NodeState {
  if (!run) return "idle";
  if (run.status === "running" && run.current === id) return "running";
  if (run.next[0] === id) return run.error ? "error" : run.waiting === "approval" ? "waiting" : "next";
  if (run.steps.some((s) => s.node === id)) return "done";
  return "idle";
}

function Legend() {
  return (
    <div className="gc-legend small muted" aria-label="범례">
      <span><i className="gc-dot gc-ai" /> AI</span>
      <span><i className="gc-dot gc-check" /> 검사</span>
      <span><i className="gc-dot gc-rule" /> 규칙 계산·도구</span>
      <span><i className="gc-dot gc-human" /> 사람</span>
      <span>── 바로 연결 · ╌╌ 조건부 연결 (라벨 = 갈래) · 아래로 도는 선 = 되돌아감 (이름은 마우스를 올리거나 지나갈 때)</span>
      <span className="gc-legend-active">━ 방금 지나간 연결</span>
    </div>
  );
}

function StepResult({ run, node, description }: { run: AgentsRun | null; node: string | null; description?: string }) {
  const steps = (node && run?.steps.filter((s) => s.node === node)) || [];
  if (!node) return <p className="muted small">실행하면 단계마다 결과가 여기에 나옵니다.</p>;
  if (steps.length === 0) return <p className="muted small">{description}</p>;
  return (
    <>
      {steps.map((s, k) => (
        <ul key={k} className="wf-lines small">
          {steps.length > 1 && <li className="muted">{k + 1}회차</li>}
          {s.lines.map((line, j) => <li key={j}>{line}</li>)}
        </ul>
      ))}
      {run?.error && run.next[0] === node && <p className="critical-text small">✕ {run.error} — [다시 실행]</p>}
    </>
  );
}

// 고른 에이전트의 내부 그래프(하위 그래프): 노드별 지나간 횟수, 지금 노드, 방금 지나간 연결
// 실행 중 지금 일하는 노드. 진행 기록은 일이 끝난 뒤에 쌓여서(AI 판단 줄은 응답이 와야 생김) 마지막 줄의 노드를
// 강조하면 한 단계 늦게 보인다 (AI가 생각하는 동안 '도구 사용'이 강조됨). 마지막 줄의 다음 차례를 본다
const SUBMIT_LIKE = /^(submit_|choose_next_step)/;
function workingNode(mine: AgentEvent[], dispatch: boolean): string | null {
  const e = mine[mine.length - 1];
  if (!e) return dispatch ? "next_item" : "ai";
  if (/^(분석|개선) [RB]\d+ · /.test(e.text)) return "tools";      // Supervisor가 부른 에이전트가 일하는 중
  if (e.node === "ai") {
    const m = /^\d+번째: (.+)$/.exec(e.text);
    const names = m && m[1] !== "글로만 답함" ? m[1].split(", ") : [];
    if (!names.length) return "nudge";
    if (names.every((n) => SUBMIT_LIKE.test(n))) return dispatch ? "submit" : "check";
    return "tools";
  }
  if (["tools", "next_item", "retry", "nudge"].includes(e.node)) return "ai";
  if (e.node === "check" && e.text.startsWith("✕")) return "ai";             // 반려 → 고쳐 오게
  return e.node;
}

// 도구·검사는 0.1초 안에 끝나 화면이 상태를 읽는 사이에 지나간다. 새로 들어온 줄에 있으면 1.2초 보여 준다 (표시만)
const FLASH_MS = 1200;
function useFlash(mine: AgentEvent[], live: boolean): string | null {
  const [flash, setFlash] = useState<string | null>(null);
  const seen = useRef(mine.length);
  useEffect(() => {
    const prev = seen.current;
    seen.current = mine.length;
    if (!live || mine.length <= prev) return;
    const hit = [...mine.slice(prev)].reverse().find((e) => ["tools", "check", "validate", "guardrail", "submit"].includes(e.node));
    if (!hit) return;
    setFlash(hit.node);
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [mine.length, live]); // eslint-disable-line react-hooks/exhaustive-deps
  return live ? flash : null;
}

function AgentInside({ graph, agent, run, events, live }: {
  graph: AgentsGraph | null;
  agent: string;
  run: AgentsRun | null;
  events: AgentEvent[];
  live: boolean;
}) {
  // 미리 돌려보기는 배정 에이전트 하위 그래프를 다시 쓴다
  const sub = graph?.agents[agent === "simulate" ? "dispatch_agent" : agent];
  const mine = events.filter((e) => e.agent === agent);
  const flash = useFlash(mine, live);
  if (!sub) return null;
  const last = mine[mine.length - 1];
  const prev = mine[mine.length - 2];
  const dispatchLike = agent === "dispatch_agent" || agent === "simulate";
  const working = live ? flash ?? workingNode(mine, dispatchLike) : null;
  const counts = run?.counts[agent] ?? {};
  const views: Record<string, NodeView> = {};
  for (const n of sub.nodes) {
    const visits = counts[n.id] ?? 0;
    views[n.id] = {
      state: working === n.id ? "running" : visits ? "done" : "idle",
      badge: visits ? `${visits}회` : undefined,
      summary: [...mine].reverse().find((e) => e.node === n.id)?.text,
    };
  }
  const active = new Set<string>();
  if (last && working && working !== last.node) active.add(`${last.node}->${working}`);   // 지금 넘어가는 길
  else if (last && prev) active.add(`${prev.node}->${last.node}`);
  else if (last) active.add(`__start__->${last.node}`);
  const dispatch = agent === "dispatch_agent" || agent === "simulate";
  return (
    <div className="panel gc-panel">
      <h2>
        {AGENT_NAMES[agent] ?? agent} 내부{" "}
        <span className="muted small">(LangGraph 하위 그래프{dispatch ? ` · 하네스 레벨 ${graph?.level}` : ""}{live ? " · 실행 중" : ""})</span>
      </h2>
      <p className="muted small">
        {dispatch
          ? "지시서마다 이 그래프를 한 바퀴 돈다. 레벨을 올리면 도구 사용 → 규칙 위반 검사·다시 시도 → 위험 결정 확인 → 과정 저장 노드가 붙는다."
          : agent === "analysis_agent" && graph?.perspectives
          ? "관점별 분석: 관점 노드들이 동시에 돈다(fan-out). 관점 노드 하나가 그 관점의 도구·질문만 가진 분석 에이전트(AI 판단 ⇄ 도구 → 근거 검사)다. 합치기(fan-in)는 같은 구간·사유의 발견을 하나로 묶고 관점마다 다른 해석은 나란히 남긴다."
          : agent === "supervisor_agent"
          ? "Supervisor가 다음 행동을 스스로 고른다: 도구 노드에서 분석 에이전트·개선 에이전트를 부르거나(그 진행은 '분석 R1 · …'처럼 보인다), 미리 돌려보기(진단 신호 포함)·파라미터 훑기를 한다. 판단 보고서는 코드가 검사한다(미리 돌려본 적용 가능한 안만 추천, 근거 수치는 인용한 결과에 있어야 함). 호출 상한 전체 40·분석 3·개선 4, 예산 상한."
          : "AI 판단 ⇄ 도구 사용을 오가다 제출하면 검사한다. 분석·개선 제안 에이전트가 같은 틀(build_tool_agent)을 쓴다."}
      </p>
      <GraphCanvas ariaLabel={`${AGENT_NAMES[agent] ?? agent} 내부 그래프`} nodes={sub.nodes} edges={sub.edges}
        views={views} activeEdges={active} height={360} nodeWidth={150} nodeHeight={70} minFitZoom={0.6} padding={0.24} />
    </div>
  );
}

function EventLog({ agent, events, live, graph }: { agent: string; events: AgentEvent[]; live: boolean; graph: AgentsGraph | null }) {
  const ref = useRef<HTMLOListElement>(null);
  const mine = events.filter((e) => e.agent === agent);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [mine.length]);
  const sub = graph?.agents[agent === "simulate" ? "dispatch_agent" : agent];
  const name = (id: string) => sub?.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <div className="panel">
      <h2>진행 기록 <span className="muted small">{AGENT_NAMES[agent] ?? agent}{live ? " · 실시간" : ""}</span></h2>
      <ol className="event-log small" ref={ref} aria-label="에이전트 진행 기록">
        {mine.length === 0 && <li className="muted">아직 실행하지 않았습니다.</li>}
        {mine.slice(-200).map((e) => (
          <li key={e.i} className={e.text.startsWith("✕") ? "critical-text" : e.text.startsWith("✓") ? "good-text" : undefined}>
            <span className="muted">{name(e.node)}</span> {e.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

const ACTION_LABEL = { approve: "승인", reject: "반려", opinion: "의견" } as const;

// 개선 루프 (M15-B): 지금 회차, 회차별 핵심 지표 전→후, 쓴 제약, 끝나면 결과 보고
function LoopPanel({ loop, specs }: { loop: AgentsLoop; specs: MetricSpec[] }) {
  const primary = specs.filter((s) => s.primary);
  const rounds = loop.report?.rounds ?? loop.rounds;
  const cons = loop.report?.constraints ?? loop.constraints;
  if (!loop.round && !rounds.length) return null;
  return (
    <div className="panel loop-panel">
      <h2>
        개선 루프{" "}
        <span className="muted small">
          {loop.report ? `끝 · ${loop.report.stop_reason}` : `${loop.round ?? 1}회차 진행 중`}
          {!loop.report && loop.decisions.length > 0 && ` · 이번 회차 결정 ${loop.decisions.map((d) => ACTION_LABEL[d.action]).join("·")}`}
        </span>
      </h2>
      {rounds.length > 0 && (
        <div className="table-scroll">
          <table className="compare-table-inner">
            <thead>
              <tr>
                <th>회차</th>
                {primary.map((s) => <th key={s.key} className="num">{s.label} 전 → 후</th>)}
                <th>승인·반려·의견</th><th className="num">AI 비용</th><th className="num">시간</th>
              </tr>
            </thead>
            <tbody>
              {rounds.map((r) => (
                <tr key={r.round}>
                  <td>{r.round}회차{r.params_version_after !== r.params_version_before && <span className="muted small"> (규칙 v{r.params_version_before}→v{r.params_version_after})</span>}</td>
                  {primary.map((s) => (
                    <td key={s.key} className="num">{fmtMetric(r.before[s.key], s.format)} → <strong>{fmtMetric(r.after[s.key], s.format)}</strong></td>
                  ))}
                  <td className="small">
                    {r.decisions.map((d, i) => (
                      <div key={i}><span className={d.action === "approve" ? "good-text" : d.action === "opinion" ? "warning-text" : "muted"}>{ACTION_LABEL[d.action]}</span> {d.title}{d.note && <span className="muted"> — {d.note}</span>}</div>
                    ))}
                    {!r.decisions.length && <span className="muted">결정 없음</span>}
                  </td>
                  <td className="num">{fmtUsd(r.cost_usd)}</td>
                  <td className="num">{r.seconds.toFixed(1)}초</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cons.length > 0 && (
        <p className="small">쓴 제약: {cons.map((c, i) => (
          <span key={i} className="chip">{constraintText(c)} <span className="muted">({c.source})</span></span>
        ))}
          {!!loop.saved_loaded?.length && <span className="muted"> · 그중 저장된 제약에서 불러온 것 {loop.saved_loaded.length}개</span>}
          {!!loop.saved_skipped?.length && <span className="warning-text"> · 지금 규칙과 맞지 않아 뺀 저장 제약 {loop.saved_skipped.length}개</span>}
        </p>
      )}
      {loop.report && (
        <div className="small">
          <strong>결과 보고</strong>
          <ul>
            {loop.report.lines.map((l) => <li key={l}>{l}</li>)}
            <li>종료 이유: {loop.report.stop_reason}</li>
            <li>남은 문제: {loop.report.remaining.length ? loop.report.remaining.map((f) => `${f.id} ${f.title}`).join(", ") : "없음"}</li>
            <li>AI 비용 합 {fmtUsd(loop.report.cost_usd)} · 시간 합 {loop.report.seconds.toFixed(1)}초</li>
          </ul>
        </div>
      )}
    </div>
  );
}

const BOUND_KEYS = { param: ["min", "max"], metric: ["min", "max", "max_drop", "max_rise"] } as const;
const BOUND_LABEL: Record<string, string> = { min: "최소", max: "최대", max_drop: "감소 한도", max_rise: "증가 한도" };

function whenText(w?: Record<string, string[]>) {
  return w ? Object.entries(w).map(([k, v]) => `${k}=${v.join(",")}`).join("; ") : "";
}

function parseWhen(text: string): Record<string, string[]> | undefined | null {
  const t = text.trim();
  if (!t) return undefined;
  const out: Record<string, string[]> = {};
  for (const part of t.split(";").map((x) => x.trim()).filter(Boolean)) {
    const m = /^([\w]+)\s*=\s*(.+)$/.exec(part);
    if (!m) return null;
    out[m[1]] = m[2].split(",").map((x) => x.trim()).filter(Boolean);
  }
  return out;
}

// 제약 확인 (M15 후속): 의견 정리 에이전트가 만든 제약을 사람이 확정 · 고쳐서 확정 · 다시 적기
function ConfirmConstraints({ ask, onConfirm, onRewrite }: {
  ask: NonNullable<AgentsRun["approval"]>;
  onConfirm: (cs: Constraint[]) => void;
  onRewrite: () => void;
}) {
  const [rows, setRows] = useState(() => (ask.constraints ?? []).map((c) => ({
    c, keep: true, when: whenText(c.when),
    bounds: Object.fromEntries(BOUND_KEYS[c.type].map((k) => [k, c[k] != null ? String(c[k]) : ""])) as Record<string, string>,
  })));
  const [err, setErr] = useState<string | null>(null);
  const confirm = () => {
    const out: Constraint[] = [];
    for (const r of rows.filter((x) => x.keep)) {
      const { min: _a, max: _b, max_drop: _c, max_rise: _d, when: _w, ...base } = r.c;   // eslint-disable-line @typescript-eslint/no-unused-vars
      const next: Constraint = { ...base };
      for (const [k, v] of Object.entries(r.bounds)) {
        if (v.trim() === "") continue;
        const n = Number(v);
        (next as unknown as Record<string, unknown>)[k] = Number.isFinite(n) ? n : v;   // 숫자가 아니면 그대로 보내 서버가 형식 오류로 돌려준다
      }
      if (r.c.type === "param") {
        const w = parseWhen(r.when);
        if (w === null) { setErr(`구간 형식: "차원=값1,값2; 차원=값" (${r.when})`); return; }
        if (w) next.when = w;
      }
      out.push(next);
    }
    setErr(null);
    onConfirm(out);
  };
  return (
    <div className="verdict wf-bar wf-review confirm-constraints" role="status">
      <span><strong>제약 확인</strong>{ask.round ? ` · ${ask.round}회차` : ""} · 의견 “{ask.opinion}” → 제약 {ask.constraints?.length ?? 0}개</span>
      <span className="muted small">AI가 정리한 제약입니다. 맞으면 확정, 숫자·구간을 고쳐서 확정, 뜻이 다르면 다시 적기. 확정한 제약만 다음 제안에 쓰입니다.</span>
      {ask.error && <span className="warning-text small">⚠ 고친 제약이 형식에 맞지 않습니다: {ask.error}</span>}
      {err && <span className="warning-text small">⚠ {err}</span>}
      <table className="compare-table-inner small">
        <thead><tr><th>쓰기</th><th>대상</th><th>한도</th><th>구간 (파라미터만)</th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input type="checkbox" checked={r.keep} aria-label="이 제약 쓰기"
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))} /></td>
              <td><code>{r.c.type === "param" ? r.c.path : r.c.metric}</code></td>
              <td>
                {BOUND_KEYS[r.c.type].map((k) => (
                  <label key={k} className="bound">{BOUND_LABEL[k]}{" "}
                    <input value={r.bounds[k]} size={6} aria-label={BOUND_LABEL[k]}
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, bounds: { ...x.bounds, [k]: e.target.value } } : x)))} />
                  </label>
                ))}
              </td>
              <td>{r.c.type === "param"
                ? <input value={r.when} placeholder="예: area_zone=boundary" aria-label="구간"
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, when: e.target.value } : x)))} />
                : <span className="muted">–</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="primary" onClick={confirm}>확정</button>
      <button onClick={onRewrite} title="정리된 제약을 버리고 사람 검토로 돌아가 의견을 다시 적습니다">다시 적기</button>
    </div>
  );
}

// Supervisor 판단 보고서 (M18-c): 사람 검토 때 이 추천의 근거와 보고서 전체
const CONF_CLASS: Record<string, string> = { 높음: "good-text", 중간: "", 낮음: "warning-text" };
const END_REASON: Record<string, string> = {
  good_enough: "충분히 좋은 안 확보", no_further_gain: "더 나아질 여지 없음",
  not_solvable_by_params: "파라미터로 못 푸는 문제", budget: "예산 초과",
};

function JudgmentCard({ j, specs, dimLabel, valueLabel }: {
  j: JudgmentView; specs: MetricSpec[]; dimLabel: (k: string) => string; valueLabel: (v: string) => string;
}) {
  const r = j.recommendation;
  const d = j.diagnosis;
  const spec = (k: string) => specs.find((m) => m.key === k);
  const metric = (k: string, v: number) => { const f = spec(k)?.format; return f ? fmtMetric(v, f) : v.toFixed(2); };
  return (
    <div className="panel judgment-card">
      <h2>Supervisor 판단 보고서 <span className="muted small">(이 추천 {r.proposal_id} · 반영은 사람이 결정)</span></h2>
      {j.summary && <p>{j.summary}</p>}
      <dl className="judgment-rec">
        <dt>기대 효과</dt><dd>{r.expected_effect}</dd>
        <dt>잃는 것</dt><dd>{r.loses}</dd>
        <dt>확신도</dt><dd className={CONF_CLASS[r.confidence] ?? ""}>{r.confidence}</dd>
        <dt>근거</dt><dd className="muted small">Supervisor 도구 호출 {r.cited_calls.join(", ")}</dd>
      </dl>
      {d && (
        <div className="small">
          <strong>진단 신호</strong>
          <ul>
            {d.target_changes.map((t) => (
              <li key={t.finding} className={t.improved ? "" : "warning-text"}>
                {d.targeted ? "겨냥한 구간" : "발견 구간"} {t.finding}: 실패율 {(t.before * 100).toFixed(1)}% → {(t.after * 100).toFixed(1)}%
                {t.improved ? "" : " (줄지 않음: 원인 가설을 의심)"}
              </li>
            ))}
            {d.worsened_metrics.length
              ? d.worsened_metrics.map((w) => <li key={w.metric} className="warning-text">나빠진 지표: {spec(w.metric)?.label ?? w.label} {metric(w.metric, w.before)} → {metric(w.metric, w.after)}</li>)
              : <li>나빠진 지표 없음</li>}
            {d.missed_slices && d.missed_slices.length > 0 && (
              <li>분석이 놓친 구간: {d.missed_slices.slice(0, 3).map((m) => `${dimLabel(m.dimension)} ${valueLabel(String(m.value))} (실패 ${m.failed}건)`).join(" · ")}</li>
            )}
            {d.dominated_by && d.dominated_by.length > 0 && <li className="warning-text">훑기 결과 중 모든 지표가 더 나은 점 {d.dominated_by.length}개</li>}
          </ul>
        </div>
      )}
      {j.questions_for_human.length > 0 && (
        <div className="judgment-ask">
          <strong>사람에게 묻는 것</strong>
          <ul>{j.questions_for_human.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
      <details>
        <summary>원인 가설 {j.hypotheses.length}개 · 시도 기록 {j.attempts.length}단계 · 추천하지 않은 안 {j.not_recommended.length}건
          {j.end_reason ? ` · 끝낸 이유: ${END_REASON[j.end_reason] ?? j.end_reason}` : ""}</summary>
        <h3 className="small">원인 가설</h3>
        <ul className="small">
          {j.hypotheses.map((h, i) => (
            <li key={i}><strong>{h.statement}</strong> <span className={CONF_CLASS[h.confidence] ?? ""}>(확신도 {h.confidence})</span>
              <br />지지: {h.support} · 반대: {h.against}<br /><span className="muted">뒤집을 증거: {h.would_flip}</span></li>
          ))}
        </ul>
        <h3 className="small">시도 기록</h3>
        <ol className="small">{j.attempts.map((a, i) => <li key={i}>{a.what} — {a.why} → <em>{a.learned}</em></li>)}</ol>
        {j.not_recommended.length > 0 && (
          <>
            <h3 className="small">추천하지 않은 안</h3>
            <ul className="small">{j.not_recommended.map((n, i) => <li key={i}>{n.proposal_id}: {n.reason}</li>)}</ul>
          </>
        )}
      </details>
    </div>
  );
}

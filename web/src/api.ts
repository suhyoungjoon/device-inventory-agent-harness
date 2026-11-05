import type {
  CompareResult, Dataset, DemoCatalogEntry, DemoManifest, DomainDefinition, DecisionRecord, DomainInfo, FindingLabel, HarnessInfo, Memory, HistoryRow, Proposal, ProposalBatch, Report, Run,
  SpecEstimate, TraceRecord, WorkflowGraph, WorkflowRun, AgentsGraph, AgentsRun, SweepAxis, SweepResult, Sensitivity, ChangeCard, SavedConstraint,
  AgentTabInfo, AgentTabSources, AgentsRecord, AgentsRecordRow, AgentTabHistoryRow, AgentTabTimeline, TabAgent, ProposalOutcome, AgentsMode, LlmCacheState, OpinionHint,
} from "./types";

// 서버에 그 실행이 없음 (서버를 다시 띄워 메모리의 실행이 사라짐)
export const isGone = (e: unknown) => (e as { status?: number })?.status === 404;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.detail ?? `${res.status} ${res.statusText}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

export interface RunOptions {
  agent: "rule" | "ai";
  level?: string;
  repeats?: number;
  scope?: string[];
  groupId?: string;
}

export const api = {
  // 도메인 결과 화면 데이터 (M21, 팩에 result_view가 있을 때만)
  runView: <T,>(runId: string) => request<T>(`/runs/${runId}/view`),
  // 에이전트 탭 (M16)
  agentTabInfo: () => request<AgentTabInfo>("/agent-tab/info"),
  agentTabSources: () => request<AgentTabSources>("/agent-tab/sources"),
  agentTabHistory: (agent: TabAgent) => request<AgentTabHistoryRow[]>(`/agent-tab/history?agent=${agent}`),
  agentTabTimeline: (agent: TabAgent, id: string, after = -1) =>
    request<AgentTabTimeline>(`/agent-tab/timeline/${agent}/${id}?after=${after}`),
  agentTabOpinion: (proposalId: string, opinion: string) =>
    request<{ id: string }>("/agent-tab/opinion", { method: "POST", body: JSON.stringify({ proposal_id: proposalId, opinion }) }),
  llmCache: () => request<LlmCacheState>("/llm/cache"),
  setLlmCache: (enabled: boolean) =>
    request<LlmCacheState>("/llm/cache", { method: "POST", body: JSON.stringify({ enabled }) }),
  proposalOpinionHints: (id: string) => request<{ hints: OpinionHint[] }>(`/proposals/${id}/opinion-hints`),
  agentTabOpinionSave: (id: string, constraints?: unknown[]) =>
    request<{ saved: string[]; constraints: unknown[] }>(`/agent-tab/opinion/${id}/save`, { method: "POST",
      body: JSON.stringify(constraints ? { constraints } : {}) }),
  agentTabSupervisor: (runId: string, useSavedConstraints: boolean) =>
    request<{ id: string }>("/agent-tab/supervisor", { method: "POST",
      body: JSON.stringify({ run_id: runId, use_saved_constraints: useSavedConstraints }) }),
  proposeWith: (reportId: string, useSavedConstraints: boolean) =>
    request<{ id: string }>("/proposals", { method: "POST",
      body: JSON.stringify({ report_id: reportId, use_saved_constraints: useSavedConstraints }) }),
  agentsGraph: (level: string, domain?: string, perspectives = false, endCheck?: "fixed" | "supervisor",
    mode: AgentsMode = "fixed") =>
    request<AgentsGraph>(`/agents/graph?level=${level}` + (perspectives && domain ? `&domain=${domain}&perspectives=true` : "")
      + (endCheck ? `&end_check=${endCheck}` : "") + (mode === "supervisor" ? "&mode=supervisor" : "")),
  agentsStart: (body: { domain: string; seed: number; faults: string[]; items: number; level: string; metrics: unknown[];
    llm: "fake" | "claude"; pace: number; perspectives?: boolean; end_check?: "fixed" | "supervisor";
    use_saved_constraints?: boolean; mode?: AgentsMode }) => request<AgentsRun>("/agents/runs", { method: "POST", body: JSON.stringify(body) }),
  agentsGet: (id: string, after = -1) => request<AgentsRun>(`/agents/runs/${id}?after=${after}`),
  agentsSave: (id: string) => request<{ id: string; steps: number }>(`/agents/runs/${id}/save`, { method: "POST" }),
  agentsRecords: () => request<AgentsRecordRow[]>("/agents/records"),
  agentsRecord: (id: string) => request<AgentsRecord>(`/agents/records/${id}`),
  agentsStep: (id: string, action: "next" | "approve" | "reject" | "opinion" | "confirm", note = "", constraints?: unknown[]) =>
    request<AgentsRun>(`/agents/runs/${id}/step`, { method: "POST", body: JSON.stringify({ action, note, constraints }) }),
  workflowGraph: () => request<WorkflowGraph>("/workflow/graph"),
  workflowStart: (body: { domain: string; seed: number; faults: string[]; items: number; level: string; metrics: unknown[] }) =>
    request<WorkflowRun>("/workflow/runs", { method: "POST", body: JSON.stringify(body) }),
  workflowGet: (id: string) => request<WorkflowRun>(`/workflow/runs/${id}`),
  workflowStep: (id: string, action: "next" | "approve" | "reject" | "opinion" | "confirm", note = "") =>
    request<WorkflowRun>(`/workflow/runs/${id}/step`, { method: "POST", body: JSON.stringify({ action, note }) }),
  domains: () => request<DomainInfo[]>("/domains"),
  harness: () => request<HarnessInfo>("/harness/levels"),
  demo: () =>
    request<{ demo: boolean; manifest?: DemoManifest; work_dir?: string; catalog?: DemoCatalogEntry[] }>("/demo"),
  createDataset: (domain: string, seed: number, faults: string[]) =>
    request<Dataset>(`/domains/${domain}/datasets`, {
      method: "POST",
      body: JSON.stringify({ seed, faults }),
    }),
  definition: (domain: string, answers = false) =>
    request<DomainDefinition>(`/domains/${domain}/definition${answers ? "?answers=true" : ""}`),
  dataset: (domain: string, id: string) => request<Dataset>(`/domains/${domain}/datasets/${id}`),
  ruleRun: (datasetId: string, opts: Omit<RunOptions, "agent">) =>
    request<Run>("/runs", {
      method: "POST",
      body: JSON.stringify({ dataset_id: datasetId, agent: "rule", scope: opts.scope, group_id: opts.groupId }),
    }),
  aiRuns: (datasetId: string, opts: Omit<RunOptions, "agent">) =>
    request<{ group_id: string; runs: Run[] }>("/runs", {
      method: "POST",
      body: JSON.stringify({
        dataset_id: datasetId,
        agent: "ai",
        level: opts.level,
        repeats: opts.repeats ?? 1,
        scope: opts.scope,
        group_id: opts.groupId,
      }),
    }),
  run: (runId: string) => request<Run>(`/runs/${runId}`),
  decisions: (runId: string) => request<DecisionRecord[]>(`/runs/${runId}/decisions`),
  traces: (runId: string, itemId: string) => request<TraceRecord[]>(`/runs/${runId}/traces/${itemId}`),
  compare: (runIds: string[]) => request<CompareResult>(`/compare?runs=${runIds.join(",")}`),
  // --- M4: 분석·개선 ---
  params: (domain: string) =>
    request<{ params: Record<string, unknown>; spec_sections: Record<string, string> }>(`/domains/${domain}/params`),
  analyze: (runId: string, opts: { perspectives?: boolean } = {}) =>
    request<{ id: string }>("/analysis", { method: "POST", body: JSON.stringify({ run_id: runId, ...opts }) }),
  report: (id: string) => request<Report>(`/analysis/${id}`),
  label: (id: string, findingId: string, label: FindingLabel | null) =>
    request<Report>(`/analysis/${id}/labels`, { method: "POST", body: JSON.stringify({ finding_id: findingId, label }) }),
  propose: (reportId: string) =>
    request<{ id: string }>("/proposals", { method: "POST", body: JSON.stringify({ report_id: reportId }) }),
  batch: (id: string) => request<ProposalBatch>(`/proposals/batches/${id}`),
  proposal: (id: string) => request<Proposal>(`/proposals/${id}`),
  proposalOutcome: (id: string, profile?: string) =>
    request<ProposalOutcome>(`/proposals/${id}/outcome`, { method: "POST", body: JSON.stringify(profile ? { profile } : {}) }),
  simulate: (id: string, body: { confirm?: boolean; level?: string; scope?: string[] } = {}) =>
    request<Proposal | { needs_confirmation: true; estimate: SpecEstimate } | { id: string; status: string }>(
      `/proposals/${id}/simulate`, { method: "POST", body: JSON.stringify(body) }),
  approve: (id: string, note: string, force = false, approver = "") =>
    request<Proposal>(`/proposals/${id}/approve`, { method: "POST", body: JSON.stringify({ note, force, approver }) }),
  reject: (id: string, note: string) =>
    request<Proposal>(`/proposals/${id}/reject`, { method: "POST", body: JSON.stringify({ note }) }),
  history: () => request<HistoryRow[]>("/history"),
  // --- M13: 파라미터 가시화 (규칙 엔진만, AI 비용 0) ---
  sweep: (datasetId: string, axes: SweepAxis[], metrics?: string[]) =>
    request<SweepResult>("/params/sweep", { method: "POST", body: JSON.stringify({ dataset_id: datasetId, axes, metrics }) }),
  sensitivity: (datasetId: string) => request<Sensitivity>(`/params/sensitivity?dataset_id=${encodeURIComponent(datasetId)}`),
  paramsHistory: (domain: string) => request<ChangeCard[]>(`/params/history?domain=${encodeURIComponent(domain)}`),
  memory: (domain: string) => request<Memory>(`/memory?domain=${encodeURIComponent(domain)}`),
  // 저장된 제약 (M15 후속): 사람이 확정한 제약. 켜진 것은 다음 개선안 요청·agents 탭 실행이 불러온다
  savedConstraints: (domain: string, all = false) =>
    request<SavedConstraint[]>(`/constraints?domain=${encodeURIComponent(domain)}${all ? "&all=true" : ""}`),
  toggleConstraint: (id: string, on: boolean) =>
    request<SavedConstraint>(`/constraints/${id}/${on ? "activate" : "deactivate"}`, { method: "POST" }),

  // 진행 상황 SSE. 닫는 함수를 돌려준다.
  stream: (runId: string, onEvent: (e: { status: string; done?: number; total?: number }) => void) => {
    const source = new EventSource(`/runs/${runId}/stream`);
    source.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      onEvent(data);
      if (data.status === "done" || data.status === "error") source.close();
    };
    source.onerror = () => source.close();
    return () => source.close();
  },
};

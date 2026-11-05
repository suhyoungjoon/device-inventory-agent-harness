// core/interfaces.py 표준 레코드와 API 응답 형태

export interface DecisionRecord {
  item_id: string;
  decision: Record<string, unknown> | null;
  status: "success" | "failed" | "blocked" | "pending_approval";
  reason_code: string | null;
  evidence: string;
  dims: Record<string, string>;
  metrics: Record<string, number>;
}

export interface Violation {
  item_id: string;
  rule: string;
  message: string;
}

export interface TraceRecord {
  run_id: string;
  item_id: string;
  step: number;
  kind: "llm" | "tool_call" | "validate" | "retry" | "guardrail" | "approval";
  input: unknown;
  output: unknown;
  ts: number;
}

export interface Dimensions {
  dimensions: Record<string, { label: string; values?: string[]; format?: string }>;
  // 자원 단위 발견 (M12-d): 발견의 resources에 적을 수 있는 자원 종류
  resources?: Record<string, { label: string; id_field: string; traits?: Record<string, { label: string }> }>;
  reason_codes: Record<string, string>;
  violation_rules: Record<string, string>;
  names?: Record<string, string>;   // 차원 값·사유 코드 → 쉬운 이름 (분석 리포트 문장용, 조건 칩에도 씀)
}

export interface DomainFault {
  id: string;
  name: string;
  expected?: string;
  generation?: Record<string, unknown>; // answers=true일 때만
  answer?: Record<string, unknown>;     // answers=true일 때만
}

export interface DomainDefinition {
  domain: string;
  params: Record<string, unknown>;
  spec_sections: Record<string, string>;
  dimensions: Dimensions;
  core_reason_codes: Record<string, string>;
  faults: DomainFault[];
  tools: { name: string; description: string }[];   // AI agent 조회 도구 (L2부터 제공)
  files: Record<string, string>;
}

export interface DomainInfo {
  name: string;
  dimensions: Dimensions;
  faults: { id: string; name: string }[];
  core_reason_codes: Record<string, string>;
}

export interface Dataset {
  id: string;
  domain: string;
  seed: number;
  faults: string[];
  items: number;
  instance?: unknown;
  item_ids?: string[];
}

export interface Usage {
  calls?: number;
  cached_calls?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd: number | null;
  provider?: string;
  deployment?: string;
  cost_estimated?: boolean;   // 단가가 추정치 (configs/llm.yaml pricing_estimated)
}

export interface RunProgress {
  done?: number;
  total?: number;
  state?: string;
  error?: string;
}

export interface Run {
  run_id: string;
  domain: string;
  dataset_id: string;
  agent: "rule" | "ai";
  level: string | null;
  model: string | null;
  seed: number;
  params_version: number | null;
  status: "running" | "done" | "error";
  metrics: Record<string, number> | null;
  violations: Violation[] | null;
  group_id?: string | null;
  repeat?: number | null;
  scope?: string[] | null;
  meta?: { items?: number; seconds?: number; usage?: Usage; error?: string; effort?: string } | null;
  progress?: RunProgress | null;
  replayed?: boolean;   // 저장된 실행을 재생 중 (시연 모드)
}

export interface HarnessLevel {
  name: string;
  spec: boolean;
  tools: boolean;
  validate_loop: boolean;
  guardrail: boolean;
  trace: "minimal" | "full";
  max_retries: number;
}

export interface HarnessInfo {
  levels: Record<string, HarnessLevel>;
  llm: { provider?: string; model: string; effort: string; cache: boolean; concurrency: number; max_llm_calls_per_item: number };
  demo?: DemoManifest | null;   // 시연 모드일 때 번들 정보
}

export interface DemoManifest {
  created_at: string;
  git_ref: string | null;
  git_commit: string | null;
  note: string;
  counts: Record<string, number>;
}

export interface DemoCatalogEntry {
  dataset_id: string;
  level: string;
  items: number;
  runs: number;
}

export interface CompareSummary {
  agent: "rule" | "ai";
  level: string | null;
  runs: number;
  metrics: Record<string, number | null>;
  violations: number | null;
  seconds_per_item: number | null;
  cost_per_item_usd: number | null;
  cost_unknown?: boolean;
  cost_estimated?: boolean;
  consistency: number | null;
}

export interface CompareResult {
  runs: unknown[];
  summary: CompareSummary[];
}

// --- M4: 분석·개선 ---

export interface Finding {
  id: string;
  title: string;
  description: string;
  slice?: Record<string, string[]>;
  reason_codes?: string[];
  metric?: { name: string; direction: "low" | "high" };
  hypothesis?: string;
  impact?: string;      // 현장에서 생기는 일 한 문장 (쉬운 말, 이후 분석부터)
  concepts_removed?: { hypothesis?: string; impact?: string };   // 데이터에 없는 개념이 남아 뺀 추정 원인·현장 영향
  cited_calls: string[];
  // 관점별 분석 (M12-b): 이 발견을 찾은 관점과, 같은 발견에 대한 다른 관점의 해석
  perspectives?: string[];
  perspective_names?: string[];
  alternatives?: FindingAlternative[];
  related?: string[];   // 구간이 겹치는(한쪽이 더 좁은) 다른 발견 ID
  slice_removed?: Record<string, string[]>;   // 선언되지 않은 차원·값이라 구간에서 뺀 것
  resources?: FindingResources;               // 자원 단위 발견 (M12-d)
  resources_removed?: { kind?: string; ids?: string[]; traits?: Record<string, string[]> };   // 인용 결과에 없어 뺀 것
}

export interface FindingResources {
  kind: string;
  ids: string[];
  traits?: Record<string, string[]>;
}

export interface FindingAlternative {
  perspective: string;
  perspective_name: string;
  title: string;
  description: string;
  hypothesis?: string | null;
  cited_calls: string[];
}

export interface PerspectiveResult {
  name: string;
  error: string | null;
  findings: number;
  dropped: number;
  stop: string | null;
  usage?: Usage & { llm_calls?: number; seconds?: number };
}

export interface ToolCall {
  name: string;
  input: unknown;
  output: unknown;
  is_error: boolean;
  perspective?: string;
}

export interface FaultScore {
  name: string;
  detected: boolean;
  matched_findings: string[];
  status?: "detected" | "pending" | "missed";   // pending: 근거는 맞고 사람의 원인 확인 대기 (M12-a 이전 채점엔 없음)
  confirm_cause?: boolean;
}

// 발견 판정: 정답에 없는 발견은 valid/false_positive, 원인 확인 대상 발견은 cause_ok/cause_wrong
export type FindingLabel = "valid" | "false_positive" | "cause_ok" | "cause_wrong";

export interface Score {
  faults: Record<string, FaultScore>;
  detected: number;
  total: number;
  detection_rate: number | null;
  unmatched_findings: string[];
  pending?: number;
  labels: Record<string, FindingLabel>;
  false_positives: number;
  valid_unmatched: number;
  unlabeled: number;
}

// 회차 간 장기 기억 (M12-c): 사람이 내린 판단을 다음 회차 에이전트 입력으로
export interface MemoryItem {
  id: string;
  title: string;
  at?: number;
  params_version?: number | null;
  stale?: boolean;
  // 반려 개선안
  kind?: "params" | "spec";
  change?: string;
  reason?: string;
  // 발견 판정
  label?: FindingLabel;
  hypothesis?: string | null;
}

export interface Memory {
  rejections: MemoryItem[];
  judgments: MemoryItem[];
  item_ids: string[];
  version: string | null;
}

export interface Report {
  id: string;
  run_id: string;
  status: "running" | "done" | "error";
  error?: string | null;
  body: {
    summary: string;
    findings: Finding[];
    dropped: { finding: Finding; problems: string[] }[];
    calls: Record<string, ToolCall>;
    stop: string;
    feedback_rounds: number;
    usage: Usage & { llm_calls?: number; seconds?: number };
    memory?: Memory | null;
    perspectives?: Record<string, PerspectiveResult>;
  } | null;
  score: Score | null;
}

export interface ProposalBody {
  title: string;
  kind: "params" | "spec";
  rationale: string;
  expected_effect?: string;
  target_findings: string[];
  params_changes?: { path: string; value: unknown }[];
  override_rules?: { when: Record<string, string[]>; set: Record<string, unknown> }[];
  spec_edits?: { section: string; text: string }[];
}

export interface Simulation {
  kind?: "params" | "spec";
  replayed?: boolean;
  before?: Record<string, number>;
  after?: Record<string, number>;
  violations_after?: number;
  violations_before?: number;
  // label·unit (M21): 도메인이 구간 비교 기준을 정할 때 (예: 결품률, 대)
  slices?: Record<string, { before: { items: number; failed: number; fail_rate: number; label?: string; unit?: string }; after: { items: number; failed: number; fail_rate: number; label?: string; unit?: string } }>;
  seconds?: number;
  cost_usd?: number;
  run_ids?: Record<string, string>;
  error?: string;
  constraint_violations?: { index: number; type: "param" | "metric"; message: string }[];
  // 최소 변경 추천 (M15-A): 같은 핵심 지표를 내는 가장 작은 변경. 숫자 하나 바꾸는 안만
  minimal_change?: { path: string; current: number; proposed: number; recommended: number; same_primary: boolean;
    metrics: Record<string, number>; violations_after: number } | null;
}

// 개선안 제시 기준 (M15-A): main 본안(순위) · cut 개수 초과 · reference 참고 · hidden 지배당함 · pending 아직
export type RankTier = "main" | "cut" | "reference" | "hidden" | "pending";
export interface Ranking {
  order: string[];
  entries: Record<string, { tier: RankTier; rank: number | null; gain: number | null; loss: number | null; worse: string[]; reasons: string[] }>;
  cut: string[];
  config: { max_proposals: number; per_finding: number; min_effect: number };
}

// 사람이 정한 한도 (M12-a). 입력 화면은 이 레포에 없고 API로 받는다
export interface Constraint {
  type: "param" | "metric";
  path?: string;
  metric?: string;
  min?: number;
  max?: number;
  max_drop?: number;
  max_rise?: number;
  when?: Record<string, string[]>;   // 구간 조건 (파라미터 제약만, M15 후속)
  source: string;
  note?: string;
  id?: string;                        // 저장된 제약의 id (M15 후속)
}

export interface SavedConstraint {
  id: string;
  domain: string;
  body: Constraint;
  opinion: string | null;
  origin: string | null;
  params_version: number | null;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface Proposal {
  id: string;
  batch_id: string;
  report_id: string;
  kind: "params" | "spec";
  status: "proposed" | "invalid" | "simulating" | "simulated" | "approved" | "rejected" | "stale";
  body: ProposalBody;
  errors: string[];
  simulation: Simulation | null;
  decision: { action: string; note: string; params_version_before?: number; params_version_after?: number; forced?: boolean } | null;
}

export interface ProposalBatch {
  id: string;
  report_id: string;
  status: "running" | "done" | "error";
  error?: string | null;
  meta: { usage: Usage & { seconds?: number }; trials: number; params_version?: number; constraints?: Constraint[]; memory?: Memory | null;
    saved_constraints?: string[] } | null;
  proposals: Proposal[];
  ranking?: Ranking | null;
}

export interface SpecEstimate {
  level: string;
  items: number;
  runs: number;
  estimate_usd: number | null;
  per_item_usd?: number;
  note?: string;
  replayed?: boolean;
}

export interface HistoryRow {
  proposal_id: string;
  round: number | null;
  status: "approved" | "rejected";
  kind: "params" | "spec";
  title: string;
  target_findings: string[];
  decision: Proposal["decision"];
  before: Record<string, number> | null;
  after: Record<string, number> | null;
  cycle: { analysis_seconds?: number; proposal_seconds?: number; simulation_seconds?: number; llm_cost_usd: number | null };
}

// --- M13: 파라미터 가시화 ---
export type ParamKind = "policy" | "estimate" | "fixed" | "governance";

export interface SweepAxis {
  path: string;
  values: unknown[];
}

export interface SweepPoint {
  values: Record<string, unknown>;
  metrics: Record<string, number>;
  violations: number;
  items: number;
}

export interface SweepResult {
  axes: (SweepAxis & { kind: ParamKind })[];
  points: SweepPoint[];
  base: SweepPoint;
  warnings: string[];
  seconds: number;
  cached: boolean;
  params_version: number;
}

export interface SensitivityRow {
  path: string;
  kind: ParamKind;
  bounds: [number, number];
  current: number;
  values: number[];
  points: SweepPoint[];
  ranges: Record<string, { min: number; max: number; spread: number }>;
  flat_around_current: [number, number] | null;   // 현재 값을 포함해 결과가 같은 구간
  items: number;
}

export interface Sensitivity {
  rows: SensitivityRow[];
  metrics: string[];
  steps: number;
  seconds: number;
  cached: boolean;
}

// 변경 이력 카드: 승인으로 params 버전이 오를 때마다 하나 (before가 null이면 M13 이전 기록이라 "기록 없음")
export interface ChangeCard {
  proposal_id: string;
  report_id: string | null;
  title: string | null;
  version_before: number | null;
  version_after: number;
  changes: { path: string; before: unknown; after: unknown }[];
  override_rules: { when: Record<string, unknown>; set: Record<string, unknown>; before: Record<string, unknown> | null }[];
  findings: { id: string; title: string | null }[];
  metrics_before: Record<string, number> | null;
  metrics_after: Record<string, number> | null;
  violations_after: number | null;
  approver: string | null;
  note: string | null;
  forced: boolean;
  at: number | null;
}

// --- Agent workflow (LangGraph, M9) ---
export interface WorkflowNode {
  id: string;
  label?: string;
  kind?: "rule" | "ai" | "human";
  tab?: string;
  description?: string;
}

export interface WorkflowEdge {
  source: string;
  target: string;
  label: string | null;
  conditional: boolean;
}

export interface WorkflowGraph {
  available: boolean;
  reason?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowStep {
  node: string;
  lines: string[];
  data: Record<string, unknown>;
  at: number;
  // M20 타임라인 (LangGraph agents): 회차, 종류, 시작·소요(사람 노드는 비우고 waited), 그 단계의 AI 비용,
  // 사람 검토의 결정, Supervisor 시도 기록 요약
  round?: number;
  kind?: "ai" | "rule" | "human";
  started?: number;
  seconds?: number | null;
  waited?: boolean;
  cost_usd?: number;
  decision?: { action: "approve" | "reject" | "opinion"; title: string; note?: string };
  sub?: { tool: string; summary: string }[];
}

export interface WorkflowRun {
  id: string;
  status: "paused" | "running" | "done";
  current: string | null;
  error: string | null;
  next: string[];
  waiting: "next" | "approval" | null;
  approval: { proposal_id: string; question: string } | null;
  steps: WorkflowStep[];
  ids: Partial<Record<"dataset_id" | "rule_run_id" | "ai_run_id" | "full_rule_run_id" | "report_id" | "batch_id" | "proposal_id", string>>;
  inputs: { domain?: string; seed?: number; faults?: string[]; items?: number; level?: string; scope?: string[] };
  progress?: { run_id: string; done: number | null; total: number | null } | null;   // AI 방식 실행 단계가 도는 중이면 몇 건째
}

// --- LangGraph agents (M10) ---
export interface AgentsGraph {
  available: boolean;
  reason?: string;
  demo?: boolean;
  level?: string;
  perspectives?: boolean;
  end_check?: "fixed" | "supervisor";
  mode?: AgentsMode;
  top: { nodes: (WorkflowNode & { agent?: boolean })[]; edges: WorkflowEdge[] };
  agents: Record<string, { nodes: WorkflowNode[]; edges: WorkflowEdge[] }>;
}

export interface AgentEvent {
  i: number;
  agent: string;
  node: string;
  text: string;
  at: number;
}

export interface AgentsRun extends Omit<WorkflowRun, "ids" | "inputs" | "approval"> {
  llm: "fake" | "claude";
  approval: {
    proposal: number; title: string; question: string; round?: number; rank?: number | null; reasons?: string[];
    opinion_error?: string; minimal_change?: { path: string; current: number; recommended: number; proposed: number } | null;
    kind?: "confirm_constraints"; opinion?: string; constraints?: Constraint[]; error?: string;   // 제약 확인 (M15 후속)
    judgment?: JudgmentView;   // Supervisor 모드 (M18): 이 추천의 근거와 판단 보고서
    opinion_hints?: OpinionHint[];   // 의견 추천 재료 (코드 계산)
  } | null;
  events: AgentEvent[];
  counts: Record<string, Record<string, number>>;
  last_event: AgentEvent | null;
  proposals: { title: string; kind: string; status: string; errors: string[]; rank?: { tier: string; rank: number | null; reasons: string[] } | null }[];
  inputs: { domain?: string; seed?: number; faults?: string[]; items?: number; level?: string; perspectives?: boolean };
  loop?: AgentsLoop;
  end_check?: "fixed" | "supervisor" | null;
  mode?: AgentsMode | null;
}

// 실행 기록 (M20): 끝난(또는 사람 대기에서 멈춘) 실행을 파일로 저장해 다시 열어 재생한다
export interface AgentsRecordRow {
  id: string; saved_at: number | null; status: string; llm: "fake" | "claude" | null; mode: AgentsMode | null;
  steps: number; rounds: number; cost_usd: number | null;
}
export interface AgentsRecord {
  id: string; saved_at: number; status: string; llm: "fake" | "claude";
  graph: { level: string; perspectives: boolean; end_check: "fixed" | "supervisor" | null; mode: AgentsMode };
  inputs: AgentsRun["inputs"]; steps: WorkflowStep[]; loop?: AgentsLoop; proposals: AgentsRun["proposals"];
  events: AgentEvent[];
}

// 분석·개선 Supervisor (M18): 켜고 끄기
export type AgentsMode = "fixed" | "supervisor";
export type Confidence = "높음" | "중간" | "낮음";
export interface JudgmentView {
  recommendation: { proposal_id: string; cited_calls: string[]; expected_effect: string; loses: string; confidence: Confidence };
  summary?: string;
  hypotheses: { statement: string; support: string; against: string; confidence: Confidence; would_flip: string }[];
  attempts: { what: string; why: string; learned: string }[];
  questions_for_human: string[];
  not_recommended: { proposal_id: string; reason: string }[];
  end_reason?: string;
  diagnosis?: {
    targeted?: boolean;
    target_changes: { finding: string; before: number; after: number; delta: number; improved: boolean }[];
    worsened_metrics: { metric: string; label: string; before: number; after: number; delta: number }[];
    missed_slices: { dimension: string; value: string; failed: number; share_of_failed: number }[] | null;
    dominated_by: { values: Record<string, unknown>; metrics: Record<string, number> }[] | null;
  } | null;
}

// 개선 루프 (M15-B): 회차 기록과 결과 보고
export interface LoopDecision { action: "approve" | "reject" | "opinion"; title: string; note: string; round?: number }
export interface LoopRound {
  round: number;
  before: Record<string, number>;
  after: Record<string, number>;
  approved: string[];
  decisions: LoopDecision[];
  cost_usd: number | null;
  seconds: number;
  params_version_before?: number;
  params_version_after?: number;
}
export interface AgentsLoop {
  round: number | null;
  rounds: LoopRound[];
  constraints: Constraint[];
  stop_reason: string | null;
  decisions: LoopDecision[];
  saved_loaded?: { id: string }[];
  saved_skipped?: { id: string; error: string }[];
  judgment?: { failure: { label: string; reason: string } | null; problems: string[];
    counts: Record<string, number>; budget: { spent_usd: number; max_usd: number | null; seconds: number } } | null;
  report: {
    rounds: LoopRound[]; stop_reason: string; decisions: LoopDecision[]; constraints: Constraint[];
    remaining: { id: string; title: string }[]; cost_usd: number | null; seconds: number; lines: string[];
    total: Record<string, { before: number | null; after: number | null }>;
  } | null;
}

// --- 에이전트 탭 (M16) ---
export type TabAgent = "dispatch" | "analysis" | "proposals" | "opinion" | "supervisor";

export interface AgentTabInfo {
  agents: { agent: TabAgent; label: string; provider: string; model: string; effort: string | null; max_calls: string }[];
  demo: boolean;
  fake: boolean;
  note: string | null;
}

export interface AgentTabSources {
  rule_runs: {
    id: string; label: string; dataset_id: string;
    seed?: number | null; faults?: string[]; full?: boolean; current_params?: boolean;   // 같은 조건 실행 찾기용
  }[];
  reports: { id: string; label: string; run_id: string }[];
  proposals: { id: string; label: string; batch_id: string; status: string }[];
}

export interface AgentTabHistoryRow {
  id: string;
  status: string;
  created_at: number;
  label: string;
}

export interface TimelineEvent {
  seq: number;
  at?: number;          // 실행 중 기록의 시각 (초, 서버 시계). 저장된 기록에는 없다
  type: "llm" | "tool" | "check" | "item" | "decision" | "end" | string;
  turn: number | null;
  item?: string;
  text: string;
  name?: string;
  input?: string;
  output?: string;
  ok?: boolean;
  label?: string;
  problems?: string[];
  ref?: string;
  status?: string;
  tools?: string[];                          // llm: AI가 요청한 도구 이름들
  decision?: Record<string, unknown> | null; // decision: 결정 내용 (도메인 형식)
  reason_code?: string | null;               // decision: 실패 사유 코드
}

export interface AgentTabTimeline {
  agent: TabAgent;
  id: string;
  status: string;
  live: boolean;
  error?: string | null;
  input: string;
  output: string | null;
  usage: { provider?: string | null; model?: string | null; deployment?: string | null; calls?: number | null;
    input_tokens?: number | null; cache_read_tokens?: number | null; output_tokens?: number | null;
    cost_usd?: number | null; seconds?: number | null; cost_estimated?: boolean;
    cached_calls?: number | null };   // 저장된 응답(캐시)을 쓴 호출 수
  graph: string;
  level?: string;
  note?: string | null;
  events: TimelineEvent[];
  total_events: number;
  constraints?: unknown[];
  problems?: string[];
  saved?: string[];                         // 의견 정리: 사람이 확정해 저장한 제약 id
  messages?: Record<string, TeamMessage>;   // Supervisor: 호출 번호 → 누가 누구에게 무엇을 (저장된 실행만)
  item_labels?: Record<string, string>;   // 관점별 분석: 관점 id → 이름
  // Supervisor (M18): 판단 보고서와 추천안 (코드가 돌린 미리 돌려보기 요약)
  judgment?: Omit<JudgmentView, "recommendation" | "diagnosis"> | null;
  recommendations?: (JudgmentView["recommendation"] & {
    title: string; primary: Record<string, [number | null, number | null]>; constraint_violations: number;
    diagnosis?: JudgmentView["diagnosis"];
  })[];
  failure?: { label: string; reason: string } | null;
}

// --- 계획 vs 실적 (M17) ---
export interface OutcomePart {
  plan: { assigned: number; on_time: number; violations: number; avg_travel_min: number };
  outcome: {
    orders: number; promise_kept: number; promise_kept_rate: number; complaint_rate: number; cancel_rate: number;
    unserved_rate: number; avg_carry_days: number; changed: number; moved_day: number;
    changed_same_day_resolve: number; changed_carryover: number; changed_reschedule: number;
  };
}

export interface ProposalOutcome {
  proposal_id: string;
  params_version: number;
  profile: string;
  seeds: number[];
  promise_window_min: number;
  current: OutcomePart;
  proposal: OutcomePart;
  seconds: number;
  note: string;
}
// AI 응답 캐시 (서버 전체, 켜고 끄기)
export interface LlmCacheState { enabled: boolean; demo: boolean; source: string }
// Supervisor 대화 한 쌍 (에이전트 탭): Supervisor가 보낸 요청과 받은 보고
export interface TeamMessage {
  ref: string; tool: string; to: string; ok: boolean; ask?: string; reply: string;
  slice?: Record<string, string[]> | null; change?: Record<string, unknown> | null;
  report_id?: string; batch?: string; metrics?: Record<string, [number | null, number | null]>; worsened?: string[];
}
// 의견 추천 재료 (사람 검토의 의견 보내기): 서버가 개선안 변경값·미리 돌려본 결과에서 고른 한도. 문장은 화면이 만든다
export interface OpinionHint {
  type: "param" | "metric";
  bound: "max" | "min" | "max_drop" | "max_rise";
  value: number;
  path?: string; base?: string; index?: number | null; current?: number; proposed?: number;
  when?: Record<string, string[]> | null;
  metric?: string; label?: string; format?: string; unit?: string; better?: string; worse_by?: number;
}

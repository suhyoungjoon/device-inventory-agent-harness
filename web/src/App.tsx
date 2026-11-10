import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import AnalysisPanel from "./components/AnalysisPanel";
import ComparePanel from "./components/ComparePanel";
import { SideSlotContext } from "./components/SidePanel";
import Details, { ExpandAllContext, readExpandAll, saveExpandAll } from "./components/Details";
import DomainPanel from "./components/DomainPanel";
import ImprovementPanel from "./components/ImprovementPanel";
import TracePanel from "./components/TracePanel";
import { adapters } from "./domains";
import type { Scope } from "./domains/types";
import { CORE_REASON_NAMES, L, setDomainTerms, TERMS, tip, type TermKey } from "./terms";
import type { CompareSummary, Dataset, DecisionRecord, DemoCatalogEntry, DomainInfo, HarnessInfo, Run, WorkflowRun } from "./types";

// LangGraph 탭 두 개는 탭을 열 때 불러온다 (그래프 라이브러리 React Flow가 커서 첫 화면을 가볍게)
const WorkflowPanel = lazy(() => import("./components/WorkflowPanel"));
const AgentsPanel = lazy(() => import("./components/AgentsPanel"));
const AgentRunsPanel = lazy(() => import("./components/AgentRunsPanel"));
const AgentGuidePanel = lazy(() => import("./components/AgentGuidePanel"));

type Tab = "domain" | "compare" | "trace" | "analysis" | "improve" | "guide" | "agentRuns" | "workflow" | "agents";
// 왼쪽 메뉴: 묶음(group)으로 나누고, 단계별 실행은 순서 번호(step)를 붙인다. desc는 오른쪽 화면 머리글의 한 줄 설명
const TABS: { id: Tab; term: TermKey; group: string; step?: number; desc: string; milestone?: string }[] = [
  { id: "domain", term: "tabDomain", group: "준비", desc: "규칙 엔진이 쓰는 규칙·설정값과 가상 데이터를 확인합니다." },
  { id: "compare", term: "tabCompare", group: "단계별 실행", step: 1, desc: "같은 데이터를 규칙 방식과 AI 방식으로 풀어 나란히 비교합니다." },
  { id: "trace", term: "tabTrace", group: "단계별 실행", step: 2, desc: "AI가 한 건을 결정한 과정(응답 · 조회 · 검사 · 다시 시도)을 단계별로 봅니다." },
  { id: "analysis", term: "tabAnalysis", group: "단계별 실행", step: 3, desc: "분석 에이전트가 실행 결과에서 반복되는 문제를 찾습니다." },
  { id: "improve", term: "tabImprove", group: "단계별 실행", step: 4, desc: "개선 에이전트가 규칙 설정값 개선안을 내고, 미리 돌려본 뒤 사람이 승인합니다." },
  { id: "guide", term: "tabGuide", group: "에이전트", desc: "에이전트와 하네스 구성을 설명합니다 (실행 없음)." },
  { id: "agentRuns", term: "tabAgentRuns", group: "에이전트", desc: "에이전트를 하나씩 실행하고 턴 · 도구 · 하네스 검사를 봅니다." },
  { id: "workflow", term: "tabWorkflow", group: "에이전트", desc: "단계별 실행을 그래프 하나로 이어 한 단계씩 실행합니다." },
  { id: "agents", term: "tabAgents", group: "에이전트", desc: "배정 → 분석 → 개선 → 사람 승인 → 반영까지 전체 흐름을 LangGraph로 실행합니다." },
];
const TAB_GROUPS = [...new Set(TABS.map((t) => t.group))];

const sameScope = (a: string[] | null | undefined, b: string[] | null) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export default function App() {
  const [domains, setDomains] = useState<DomainInfo[]>([]);
  const [domainName, setDomainName] = useState("");
  const [harness, setHarness] = useState<HarnessInfo | null>(null);
  const [demoCatalog, setDemoCatalog] = useState<DemoCatalogEntry[]>([]);
  const [tab, setTab] = useState<Tab>("compare");
  const [fatal, setFatal] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState(readExpandAll);
  const [sideSlot, setSideSlot] = useState<HTMLElement | null>(null);   // 왼쪽 칸: 탭의 선택 항목이 여기에 그려진다

  // 실험 세션 상태
  const [seed, setSeed] = useState(42);
  const [faults, setFaults] = useState<string[]>([]);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [scopeId, setScopeId] = useState("");
  const [level, setLevel] = useState("L3");
  const [repeats, setRepeats] = useState(1);
  const [runs, setRuns] = useState<Run[]>([]);
  const [decisions, setDecisions] = useState<Record<string, DecisionRecord[]>>({});
  const [shownAiRunId, setShownAiRunId] = useState<string | null>(null);
  const [summary, setSummary] = useState<CompareSummary[]>([]);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const streams = useRef<(() => void)[]>([]);

  useEffect(() => {
    Promise.all([api.domains(), api.harness()])
      .then(([d, h]) => {
        setDomains(d);
        setDomainName(d[0]?.name ?? "");
        setHarness(h);
        if (h.demo) api.demo().then((d) => setDemoCatalog(d.catalog ?? [])).catch(() => undefined);
      })
      .catch((e) => setFatal(String(e)));
    return () => streams.current.forEach((close) => close());
  }, []);

  const domain = domains.find((d) => d.name === domainName);
  const adapter = domain ? adapters[domain.name] : undefined;
  setDomainTerms(adapter?.terms);   // [M21] 공통 화면 문구를 이 도메인 용어로 (L())
  // 사유 코드: 화면에는 짧은 이름, 마우스를 올리면 설명 문장
  const reasonDetails = useMemo(
    () => ({ ...(domain?.core_reason_codes ?? {}), ...(domain?.dimensions.reason_codes ?? {}) }),
    [domain],
  );
  const reasonLabels = useMemo(
    () => ({ ...reasonDetails, ...CORE_REASON_NAMES, ...(adapter?.reasonNames ?? {}) }),
    [reasonDetails, adapter],
  );
  // 워크플로우에서 이어받은 범위(앞 N건)가 기본 범위 목록에 없으면 목록에 더한다
  const [extraScope, setExtraScope] = useState<Scope | null>(null);
  const scopes = useMemo(
    () => (dataset && adapter ? [...adapter.scopes(dataset.instance, dataset.item_ids ?? []), ...(extraScope ? [extraScope] : [])] : []),
    [dataset, adapter, extraScope],
  );
  const scope = scopes.find((s) => s.id === scopeId) ?? null;
  const scopeItems = scope?.items ?? null;
  const inScope = runs.filter((r) => r.dataset_id === dataset?.id && sameScope(r.scope, scopeItems));
  const ruleRun = [...inScope].reverse().find((r) => r.agent === "rule" && r.status === "done") ?? null;
  const aiRuns = inScope.filter((r) => r.agent === "ai");
  const shownAiRun = aiRuns.find((r) => r.run_id === shownAiRunId) ?? [...aiRuns].reverse().find((r) => r.status === "done") ?? aiRuns[aiRuns.length - 1] ?? null;

  const upsert = useCallback((run: Run) => {
    setRuns((rs) => (rs.some((r) => r.run_id === run.run_id) ? rs.map((r) => (r.run_id === run.run_id ? { ...r, ...run } : r)) : [...rs, run]));
  }, []);
  const loadDecisions = useCallback(async (runId: string) => {
    const d = await api.decisions(runId);
    setDecisions((m) => ({ ...m, [runId]: d }));
  }, []);

  // 비교표: 현재 범위에서 끝난 run들
  const doneIds = inScope.filter((r) => r.status === "done").map((r) => r.run_id).join(",");
  useEffect(() => {
    if (!doneIds) return setSummary([]);
    api.compare(doneIds.split(",")).then((c) => setSummary(c.summary)).catch(() => undefined);
  }, [doneIds]);

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

  const generate = () =>
    guard("데이터 생성 중", async () => {
      if (!domain || !adapter) return;
      const ds = await api.createDataset(domain.name, seed, faults);
      const full = await api.dataset(domain.name, ds.id);
      setDataset(full);
      setExtraScope(null);
      const options = adapter.scopes(full.instance, full.item_ids ?? []);
      // 기본 범위: 1일차 (실험 범위 결정), 없으면 첫 번째
      setScopeId((options.find((s) => s.items && s.items.length > 10) ?? options[0])?.id ?? "");
      setSelectedItem(null);
    });

  const runRule = async () => {
    if (!dataset) return;
    const run = await api.ruleRun(dataset.id, { scope: scopeItems ?? undefined });
    await loadDecisions(run.run_id);
    upsert(run);
  };

  const onRunRule = () => guard(`${TERMS.rule.label} 실행 중`, runRule);

  // 분석 탭: 결함 패턴이 가장 잘 드러나는 전체(10일치) 규칙 agent 실행
  const runFullRule = async () => {
    if (!dataset) return;
    const run = await api.ruleRun(dataset.id, {});
    await loadDecisions(run.run_id);
    upsert(run);
  };

  const onRunAi = () =>
    guard(`${TERMS.ai.label} 실행 요청 중`, async () => {
      if (!dataset) return;
      if (!ruleRun) await runRule(); // 같은 범위의 기준선
      const { runs: created } = await api.aiRuns(dataset.id, { level, repeats, scope: scopeItems ?? undefined });
      created.forEach((run) => {
        upsert({ ...run, progress: { done: 0, total: run.scope?.length ?? dataset.items } });
        const close = api.stream(run.run_id, async (e) => {
          upsert({ ...run, status: e.status as Run["status"], progress: { done: e.done, total: e.total } });
          if (e.status === "done" || e.status === "error") {
            const fresh = await api.run(run.run_id);
            if (fresh.status === "done") await loadDecisions(run.run_id);
            upsert(fresh);
          }
        });
        streams.current.push(close);
      });
      setShownAiRunId(created[0]?.run_id ?? null);
    });

  const selectItem = (id: string) => setSelectedItem(id);

  // 에이전트 탭에서 만든 분석 리포트를 문제 찾기 탭에서 연다 (다시 분석하지 않음, 비용 없음).
  // 그 리포트가 분석한 실행의 데이터·결정을 불러와야 지도 강조와 사람 판정이 동작한다.
  // 개선안 묶음도 같은 방식으로 개선 제안 탭에서 연다 (묶음이 읽은 리포트 → 실행 → 데이터)
  const openReport = (reportId: string, batchId: string | null = null) =>
    guard(batchId ? "개선안 불러오는 중" : "분석 결과 불러오는 중", async () => {
      if (!domain) return;
      const report = await api.report(reportId);
      const run = await api.run(report.run_id);
      const full = await api.dataset(domain.name, run.dataset_id);
      setSeed(full.seed);
      setFaults(full.faults);
      setDataset(full);
      await loadDecisions(run.run_id);
      upsert(run);
      setReportId(reportId);
      setBatchId(batchId);
      setSelectedItem(null);
      setTab(batchId ? "improve" : "analysis");
    });
  const openBatch = async (batchId: string) => {
    const batch = await api.batch(batchId).catch(() => null);
    if (batch) openReport(batch.report_id, batchId);
  };

  // Agent workflow 탭의 결과를 다른 탭이 이어받는다 (같은 데이터·실행·분석·제안을 그 탭에서 자세히 본다)
  const adoptWorkflow = (flow: WorkflowRun, target: string) =>
    guard("워크플로우 결과 불러오는 중", async () => {
      if (!domain || !adapter || !flow.ids.dataset_id) return;
      const full = await api.dataset(domain.name, flow.ids.dataset_id);
      setSeed(full.seed);
      setFaults(full.faults);
      setDataset(full);
      const scopeKey = JSON.stringify(flow.inputs.scope ?? null);
      const options = adapter.scopes(full.instance, full.item_ids ?? []);
      const matched = options.find((s) => JSON.stringify(s.items) === scopeKey);
      const wf = flow.inputs.scope;
      const extra = !matched && wf?.length ? { id: `wf-${wf.length}`, label: `워크플로우 범위: 앞 ${wf.length}건`, items: wf } : null;
      setExtraScope(extra);
      setScopeId((matched ?? extra ?? options[0])?.id ?? "");
      if (flow.inputs.level) setLevel(flow.inputs.level);
      for (const id of [flow.ids.rule_run_id, flow.ids.ai_run_id, flow.ids.full_rule_run_id]) {
        if (!id) continue;
        await loadDecisions(id);
        upsert(await api.run(id));
      }
      if (flow.ids.ai_run_id) setShownAiRunId(flow.ids.ai_run_id);
      if (flow.ids.report_id) setReportId(flow.ids.report_id);
      if (flow.ids.batch_id) setBatchId(flow.ids.batch_id);
      setSelectedItem(null);
      setTab(target as Tab);
    });

  return (
    <ExpandAllContext.Provider value={expandAll}>
    <div className="app">
      <header className="app-bar">
        <h1>Optimization Agent Harness</h1>
        {domains.length > 1 ? (
          <label className="domain-pick" title={tip("domain")}>
            <span className="muted small">업무</span>
            <select value={domainName} onChange={(e) => setDomainName(e.target.value)}>
              {domains.map((d) => (
                <option key={d.name} value={d.name}>{adapters[d.name]?.title ?? d.name}</option>
              ))}
            </select>
          </label>
        ) : (
          domainName && <span className="muted" title={tip("domain")}>{TERMS.domain.label}: {adapters[domainName]?.title ?? domainName}</span>
        )}
        <label className="expand-all small muted" title="모든 상세보기를 펼친 채로 본다 (이 브라우저에 기억)">
          <input type="checkbox" checked={expandAll}
            onChange={(e) => { setExpandAll(e.target.checked); saveExpandAll(e.target.checked); }} /> 모두 펼치기
        </label>
      </header>
      {harness?.demo && <DemoBanner manifest={harness.demo} catalog={demoCatalog} />}
      <div className="app-layout">
      <aside className="app-side">
      <nav className="tabs tabs-vertical" role="tablist" aria-orientation="vertical" aria-label="메뉴">
        {TAB_GROUPS.map((g) => (
          <div key={g} className="nav-group" role="presentation">
            <div className="nav-group-title" aria-hidden="true">{g}</div>
            {TABS.filter((t) => t.group === g).map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                disabled={!!t.milestone}
                title={t.milestone ? `${t.milestone}에서 추가` : tip(t.term)}
                onClick={() => !t.milestone && setTab(t.id)}
              >
                {t.step && <span className="nav-step" aria-hidden="true">{t.step}</span>}
                <span className="nav-label">{TERMS[t.term].label}</span>
                {t.milestone && <span className="badge">{t.milestone}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="side-settings">
        <div className="side-settings-title" aria-hidden="true">이 화면의 설정</div>
        <div ref={setSideSlot} className="side-slot" />
      </div>
      </aside>
      <SideSlotContext.Provider value={sideSlot}>
      <main>
        {(() => {
          const cur = TABS.find((t) => t.id === tab);
          return cur && (
            <div className="page-head">
              <div className="page-title">
                <h2>{cur.step && <span className="nav-step" aria-hidden="true">{cur.step}</span>}{TERMS[cur.term].label}</h2>
                <p className="muted">{L(cur.desc)}</p>
              </div>
              <dl className="page-context" aria-label="지금 보는 데이터">
                <div><dt>업무</dt><dd>{(adapter?.title ?? domainName) || "–"}</dd></div>
                <div><dt>데이터</dt><dd>{dataset ? `번호 ${dataset.seed} · ${dataset.items.toLocaleString()}건` : "아직 없음"}</dd></div>
                <div><dt>심어둔 문제</dt><dd>{dataset ? (dataset.faults.length ? dataset.faults.join(" · ") : "없음") : "–"}</dd></div>
              </dl>
            </div>
          );
        })()}
        {fatal && <p className="critical-text">✕ 서버에 연결할 수 없습니다: {fatal}</p>}
        {domain && adapter && tab === "domain" && (
          <DomainPanel domainName={domain.name} adapter={adapter} dataset={dataset} busy={busy} onGenerate={generate} />
        )}
        {domain && adapter && tab === "compare" && (
          <ComparePanel
            domain={domain}
            adapter={adapter}
            harness={harness}
            reasonLabels={reasonLabels}
            reasonDetails={reasonDetails}
            seed={seed}
            setSeed={setSeed}
            faults={faults}
            toggleFault={(id) => setFaults((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id].sort()))}
            dataset={dataset}
            scopes={scopes}
            scopeId={scopeId}
            setScopeId={setScopeId}
            level={level}
            setLevel={setLevel}
            repeats={repeats}
            setRepeats={setRepeats}
            ruleRun={ruleRun}
            aiRuns={aiRuns}
            shownAiRun={shownAiRun}
            setShownAiRun={setShownAiRunId}
            decisionsOf={(id) => decisions[id]}
            summary={summary}
            selectedItem={selectedItem}
            onSelectItem={selectItem}
            busy={busy}
            error={error}
            onGenerate={generate}
            onRunRule={onRunRule}
            onRunAi={onRunAi}
          />
        )}
        {domain && tab === "trace" && (
          <TracePanel
            runs={aiRuns}
            ruleDecisions={(ruleRun && decisions[ruleRun.run_id]) || []}
            decisionsOf={(id) => decisions[id]}
            selectedItem={selectedItem}
            onSelectItem={selectItem}
            reasonLabels={reasonLabels}
            reasonDetails={reasonDetails}
            decisionText={adapter?.decisionText}
          />
        )}
        {domain && adapter && tab === "analysis" && (
          <AnalysisPanel
            domain={domain}
            adapter={adapter}
            reasonLabels={reasonLabels}
            reasonDetails={reasonDetails}
            dataset={dataset}
            runs={runs.filter((r) => r.dataset_id === dataset?.id)}
            decisionsOf={(id) => decisions[id]}
            loadDecisions={loadDecisions}
            onRunFullRule={runFullRule}
            reportId={reportId}
            setReportId={(id) => {
              setReportId(id);
              setBatchId(null);
            }}
          />
        )}
        {domain && adapter && tab === "workflow" && (
          <Suspense fallback={<p className="muted">불러오는 중…</p>}>
            <WorkflowPanel domain={domain} adapter={adapter} harness={harness} seed={seed} faults={faults} level={level}
            onAdopt={adoptWorkflow} />
          </Suspense>
        )}
        {tab === "guide" && (
          <Suspense fallback={<p className="muted">에이전트 소개 불러오는 중…</p>}>
            <AgentGuidePanel harness={harness} />
          </Suspense>
        )}
        {domain && adapter && tab === "agentRuns" && (
          <Suspense fallback={<p className="muted">에이전트 화면 불러오는 중…</p>}>
            <AgentRunsPanel domain={domain} adapter={adapter} seed={seed} faults={faults} onOpenReport={(id) => openReport(id)} onOpenBatch={openBatch} />
          </Suspense>
        )}
        {domain && adapter && tab === "agents" && (
          <Suspense fallback={<p className="muted">그래프 화면 불러오는 중…</p>}>
            <AgentsPanel domain={domain} adapter={adapter} harness={harness} seed={seed} faults={faults} level={level} />
          </Suspense>
        )}
        {domain && adapter && tab === "improve" && (
          <ImprovementPanel
            domainName={domain.name}
            adapter={adapter}
            harness={harness}
            scopes={scopes}
            reportId={reportId}
            batchId={batchId}
            setBatchId={setBatchId}
            datasetId={dataset?.id ?? null}
          />
        )}
      </main>
      </SideSlotContext.Provider>
      </div>
    </div>
    </ExpandAllContext.Provider>
  );
}

function DemoBanner({ manifest, catalog }: { manifest: NonNullable<HarnessInfo["demo"]>; catalog: DemoCatalogEntry[] }) {
  return (
    <div className="demo-banner" role="note">
      <strong title={tip("demo")}>{TERMS.demo.label}</strong>
      <span>AI 결과는 저장해 둔 것을 다시 보여주고(비용 없음), 승인은 임시 사본에만 반영됩니다.</span>
      <Details summary={`상세보기 (저장 정보${catalog.length ? ` · 다시 볼 수 있는 AI 실행 ${catalog.length}개` : ""})`}>
        <span className="small">
          AI 호출·인터넷 없이 동작합니다. {TERMS.rule.label}과 {TERMS.simulate.label}는 실제로 계산합니다. 서버를 다시 켜면 승인 전 상태로 돌아갑니다.
        </span>
        <span className="muted small">
          저장 시각 {manifest.created_at}
          {manifest.git_commit && ` · ${manifest.git_ref} ${manifest.git_commit.slice(0, 7)}`}
          {manifest.note && ` · ${manifest.note}`}
        </span>
        {catalog.length > 0 && (
          <span className="muted small">
            다시 볼 수 있는 AI 실행:{" "}
            {catalog.map((c) => `${c.dataset_id} ${c.level} ${c.items}건 ×${c.runs}`).join(" · ")}
          </span>
        )}
      </Details>
    </div>
  );
}

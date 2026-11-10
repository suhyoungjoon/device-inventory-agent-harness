import type { DomainAdapter, Scope } from "../types";
import InventoryView from "./InventoryView";
import { BRANCH, MAKER, VALUE_LABELS } from "./names";

// 항목 ID "W1-A-M01" = 주차 · 지점 · 모델
export const inventoryAdapter: DomainAdapter = {
  ResultView: InventoryView,
  title: "단말 재고·구매",
  terms: { item: "발주 항목", decide: "발주", decided: "발주 결정", agent: "발주 에이전트", unassigned: "미발주", unit: "건",
           opinionExample: "플래그십은 안전재고 2주까지만" },
  metrics: [
    { key: "stockout_rate", label: "결품률", format: "pct", headline: true, primary: true, better: "down",
      tech: "못 판 수요 ÷ 전체 수요 (재고가 없어 팔지 못한 비율, 계획 기간 8주)" },
    { key: "fill_rate", label: "충족률", format: "pct", headline: true, better: "up",
      tech: "수요를 다 채운 주의 비율 (주차 × 지점 × 모델 칸 기준)" },
    { key: "avg_stock_days", label: "평균 재고일수", format: "day", headline: true, better: "down",
      tech: "주말 재고 합 ÷ 수요 합 × 7. 높으면 재고가 남아돈다" },
    { key: "purchase_amount", label: "구매 금액", format: "manwon", better: "down",
      tech: "발주량 × 단가 합 (결정 범위 항목)" },
    { key: "excess_stock_value", label: "과잉재고 금액", format: "manwon", better: "down",
      tech: "계획 끝 재고(입고 예정 포함) 중 실제 주평균 수요 4주 치를 넘는 물량 × 단가" },
    { key: "forecast_mape", label: "예측 오차", format: "pct", better: "down",
      tech: "MAPE: |규칙 예측 − 실제 수요| ÷ 실제 수요 평균 (예측은 이동평균 × 신제품 보정, AI가 직접 예측하지 않음)" },
  ],
  valueNames: VALUE_LABELS,
  decisionText: (d) => `${String(d.order_qty)}대 발주 (${MAKER[String(d.supplier)] ?? String(d.supplier)})`,
  reasonNames: {
    BUDGET_SHORT: "주간 예산 부족",
    WAREHOUSE_FULL: "창고 자리 부족",
    SUPPLY_CAP: "제조사 공급 한도 초과",
    EOL_BLOCKED: "단종 예정이라 발주 금지",
  },
  toolNames: {
    get_stock: "재고·입고 예정 보기",
    get_demand_history: "과거 수요 보기",
    calc_forecast: "예측·필요량 계산",
    get_limits: "남은 예산·공급·창고 한도 보기",
    stockout_by: "조건별 결품 보기",
    branch_stock_stats: "지점별 재고 현황 보기",
    supply_usage: "제조사 공급 한도 사용률 보기",
    forecast_error: "예측 오차 보기",
    demand_volatility: "수요 변동 보기",
  },
  argNames: { branch: "지점", model: "모델", weeks: "주 수", group_by: "묶는 기준", filters: "조건", sort_by: "정렬" },
  opinionExamples: ["안전재고는 3주 치를 넘지 말 것", "플래그십은 안전재고 2주까지만", "구매 금액이 5% 넘게 늘면 안 됨"],
  opinionText: (h) => {
    if (h.type !== "param" || h.base !== "safety.weeks") return null;
    return h.bound === "max" ? `안전재고는 ${h.value}주 치를 넘지 말 것` : `안전재고는 ${h.value}주 치 이상 유지`;
  },
  plainText: (text) => text
    .replace(/(?<![A-Za-z0-9])M([ABC])(?![A-Za-z0-9])/g, (_m, b: string) => `제조사 ${b}`)
    .replace(/지점\s*([ABC])(?![A-Za-z0-9])/g, (m, b: string) => BRANCH[b] ?? m),
  sliceText: (slice) => Object.entries(slice).map(([, vals]) => vals.map((v) => VALUE_LABELS[v] ?? v).join("·")).join(" · "),
  glossary: {
    결품: "재고가 없어 팔지 못한 수요",
    결품률: "수요 중 재고가 없어 팔지 못한 비율",
    안전재고: "수요가 예측보다 많을 때를 대비해 더 두는 재고 (예측 수요 × 안전재고 주수)",
    리드타임: "발주하고 입고될 때까지 걸리는 주 수 (제조사마다 다르다)",
    "입고 예정": "이미 발주해서 다음 주 이후 들어올 물량",
    "최소 발주 단위": "발주량은 이 수(5대)의 배수여야 한다",
    "단종 예정": "곧 판매를 끝낼 모델. 정해진 주차부터 새로 발주하지 않는다",
    재고일수: "지금 재고로 며칠 팔 수 있는지 (높으면 재고가 남아돈다)",
  },
  background: [
    "가상의 통신 대리점 단말 재고 업무다. 지점 3곳(서초·강남·송파)이 단말 10종을 매주 발주한다. 실제 모델명·제조사·가격은 쓰지 않는다.",
    "계획 기간 8주 × 지점 3 × 모델 10 = 발주 결정 240건. 앞 주의 발주·입고가 다음 주 재고로 이어진다.",
    "수요 예측은 규칙 계산이다(최근 몇 주 평균 × 신제품 보정). AI는 예측을 직접 하지 않고, 결과를 분석해 예측·발주 규칙의 설정값을 바꾸는 개선안을 낸다.",
    "발주량 = 예측 × (리드타임 + 검토주기) + 안전재고 − 현재고 − 입고 예정. 주간 예산·제조사 공급 한도·창고 용량·단종 제한을 지켜야 한다.",
  ],
  data: {
    tables: [
      { key: "branches", label: "지점", idField: "id" },
      { key: "makers", label: "제조사", idField: "id" },
      { key: "models", label: "모델", idField: "id" },
    ],
    hidden: [],
    fieldLabels: {
      id: "ID", name: "이름", warehouse_capacity: "창고 용량(대)", supply_cap: "주간 공급 한도(대)", family: "모델군",
      maker: "제조사", phase: "출시 단계", unit_cost: "단가(만원)", launch_offset: "출시(계획 몇 주 전)", eol_week: "발주 금지 주차",
    },
    format: (_t, field, value) => {
      if (["family", "phase", "maker"].includes(field) && typeof value === "string") return VALUE_LABELS[value] ?? value;
      return undefined;
    },
  },
  tradeoff: { axes: ["safety.weeks", "forecast.window_weeks"], metrics: ["stockout_rate", "purchase_amount"] },
  scopes: (_instance, itemIds) => {
    const week1 = itemIds.filter((id) => id.startsWith("W1-"));
    const byBranch = new Map<string, string[]>();
    for (const id of itemIds) {
      const b = id.split("-")[1];
      byBranch.set(b, [...(byBranch.get(b) ?? []), id]);
    }
    const out: Scope[] = [];
    if (week1.length > 10) out.push({ id: "pilot", label: "1주차 서초 10건 (시범)", items: week1.slice(0, 10) });
    if (week1.length) out.push({ id: "W1", label: `1주차 전 지점 (${week1.length}건)`, items: week1 });
    for (const [b, items] of byBranch) out.push({ id: `B-${b}`, label: `${BRANCH[b] ?? b} 8주 (${items.length}건)`, items });
    out.push({ id: "all", label: `전체 ${itemIds.length}건`, items: null });
    return out;
  },
};

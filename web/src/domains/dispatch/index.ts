import type { DomainAdapter, Scope } from "../types";
import DispatchDataMap from "./DispatchDataMap";
import DispatchMap, { stageName } from "./DispatchMap";
import { VALUE_LABELS as LABELS, hhmm } from "./districtMap";
import { josa } from "../../components/opinionHelp";

export const dispatchAdapter: DomainAdapter = {
  ResultView: DispatchMap,
  title: "출동 배정",
  data: {
    tables: [
      { key: "branches", label: "지점", idField: "id" },
      { key: "workers", label: "작업자", idField: "id" },
      { key: "orders", label: "지시서", idField: "id" },
    ],
    hidden: ["polygon"],
    fieldLabels: {
      id: "ID", name: "이름", day: "날짜", branch: "지점", work_type: "작업유형", media: "매체", difficulty: "난이도",
      building_type: "건물유형", desired: "희망시간", x: "x(km)", y: "y(km)", skills: "기술", certs: "자격", cei: "CEI",
      available: "가능시간",
    },
    format: (_table, field, value) => {
      if (field === "desired" && typeof value === "number") return hhmm(value);
      if (field === "available" && Array.isArray(value)) return `${hhmm(value[0])}~${hhmm(value[1])}`;
      if (field === "certs" && Array.isArray(value)) return value.map((v) => LABELS[v] ?? v).join(", ") || "없음";
      if (["work_type", "difficulty", "building_type"].includes(field) && typeof value === "string")
        return `${LABELS[value] ?? value} (${value})`;
      return undefined;
    },
    View: DispatchDataMap,
  },
  tradeoff: { axes: ["matching.area_extension_km[2]", "matching.time_window_min[2]"], metrics: ["assignment_rate", "on_time_rate"] },
  metrics: [
    { key: "assignment_rate", label: "배정 성공률", format: "pct", headline: true, primary: true, better: "up",
      tech: "할당성공률: 배정된 지시서 ÷ 전체 지시서" },
    { key: "desired_time_match_rate", label: "희망시간 준수율", format: "pct", headline: true, better: "up",
      tech: "희망시간 일치율: 배정된 지시서 중 고객 희망시각에 정확히 시작한 비율" },
    { key: "on_time_rate", label: "정시 배정 비율", format: "pct", better: "up",
      tech: "희망시각에 정확히 시작하도록 배정된 지시서 ÷ 전체 지시서 (배정이 늘어도 착시가 없는 정시 서비스 기준)" },
    { key: "avg_travel_min", label: "평균 이동시간", format: "min", headline: true, better: "down",
      tech: "직전 위치에서 지시서까지 이동시간 평균 (직선거리 × 우회계수 ÷ 평균 속도)" },
    { key: "worker_utilization", label: "작업자 가동률", format: "pct", better: "up",
      tech: "작업자 활용률: 작업 시간 합 ÷ 작업자 가능시간 합" },
    { key: "stage_1_share", label: "조건 그대로 배정", format: "pct", tech: "1단계 매칭 비율 (시간·지역 조건 완화 없음)" },
    { key: "stage_2_share", label: "조금 완화해 배정", format: "pct", tech: "2단계 매칭 비율 (시간·지역 조건을 한 단계 완화)" },
    { key: "stage_3_share", label: "많이 완화해 배정", format: "pct", tech: "3단계 매칭 비율 (시간·지역 조건을 최대로 완화)" },
  ],
  valueNames: LABELS,
  decisionText: (d) => `${String(d.worker_id)} ${String(d.start_time)} (${stageName(d.matching_stage)})`,
  toolNames: {
    get_order: "지시서 내용 확인",
    find_candidates: "배정 가능한 작업자 찾기",
    check_assignment: "배정해도 되는지 확인",
    get_worker_schedule: "작업자 일정 보기",
    get_travel_time: "이동 시간 계산",
    demand_by_hour: "시간대별 수요 보기",
    worker_stats: "작업자별 가동 현황 보기",
  },
  argNames: {
    order_id: "지시서", worker_id: "작업자", stage: "완화 단계", start_time: "시작", branch: "지점",
    // worker_stats 정렬 기준 (값으로 나온다)
    busy_min: "작업 시간", jobs: "작업 건수", utilization: "가동률", available_min: "가능 시간",
  },
  // 의견 보내기 도움: 의견 정리 에이전트가 그대로 제약으로 바꿀 수 있게 한도 숫자가 든 문장
  opinionExamples: ["관할 밖 4km 초과 출동 불가", "경계 지역은 관할 밖 3km까지만", "정시 배정 비율이 1%p 넘게 떨어지면 안 됨",
                    "희망시각에서 60분 넘게 벗어나 배정하지 말 것"],
  opinionText: (h) => {
    if (h.type !== "param") return null;
    const where = whenText(h.when);
    const head = where ? `${where}${josa(where, "은", "는")} ` : "";
    if (h.base === "matching.area_extension_km")
      return h.bound === "max" ? `${head}관할 밖 ${h.value}km 초과 출동 불가` : `${head}관할 밖 출동 거리는 ${h.value}km 이상 유지`;
    if (h.base === "matching.time_window_min")
      return h.bound === "max" ? `${head}희망시각에서 ${h.value}분 넘게 벗어나 배정하지 말 것`
        : `${head}희망시각 허용 오차는 ${h.value}분 이상 유지`;
    return null;
  },
  reasonNames: {
    NO_SKILL: "기술 보유자 없음",
    NO_CERT: "자격 보유자 없음",
    NO_TIME_MATCH: "희망시간에 가능한 사람 없음",
    OUT_OF_AREA: "갈 수 있는 거리 밖",
    CAPACITY: "일정이 꽉 참",
  },
  // 문제 찾기 쉽게 읽기
  plainText: (text, instance) => {
    const name = branchNames(instance);
    return text
      .replace(/지점\s*([A-Z])(?![A-Za-z0-9])/g, (m, b: string) => (name[b] ? `${name[b]}지점` : m))
      .replace(/(?<![A-Za-z0-9])([A-Z])\s*지점/g, (m, b: string) => (name[b] ? `${name[b]}지점` : m))
      .replace(/(?<![A-Za-z0-9])branch\s*([A-Z])(?![A-Za-z0-9])/g, (m, b: string) => (name[b] ? `${name[b]}지점` : m))
      .replace(/(?<![A-Za-z0-9])([A-Z])\+/g, (m, b: string) => (name[b] ? `${name[b]}지점+` : m));
  },
  sliceText: (slice, instance) => {
    const name = branchNames(instance);
    return Object.entries(slice).map(([dim, vals]) => {
      const vs = vals.map(String);
      if (dim === "hour") return `${vs.map((v) => Number(v)).join("·")}시`;
      if (dim === "branch") return vs.map((v) => `${name[v] ?? v}지점`).join("·");
      return vs.map((v) => LABELS[v] ?? v).join("·");
    }).join(" · ");
  },
  glossary: {
    지시서: "고객 집을 방문해 하는 작업 한 건",
    개통: "새 회선을 설치해 서비스를 시작하는 작업",
    장애: "고장 난 회선을 고치는 작업",
    HFC: "광케이블과 동축 케이블을 섞은 회선 (케이블 인터넷). 이 기술이 있는 작업자만 맡을 수 있다",
    FTTx: "광케이블을 건물·집까지 끌어온 회선 (광 인터넷). 이 기술이 있는 작업자만 맡을 수 있다",
    CATV: "케이블TV 동축 회선. 이 기술이 있는 작업자만 맡을 수 있다",
    승주: "전봇대에 올라가서 하는 작업. 승주 자격이 있는 작업자만 할 수 있다",
    고위험: "추락·감전 위험이 큰 작업. 고위험 자격이 있는 작업자만 할 수 있다",
    옥외: "건물 밖에서 하는 작업 (작업 시간이 더 걸린다)",
    관할: "지점이 맡는 구역. 작업자는 원래 자기 지점 관할 안으로 출동한다",
    "경계 지역": "다른 지점 관할과 맞닿은 곳(경계에서 1km 안). 관할 밖 출동을 허용해야 배정되는 경우가 많다",
    "일정이 꽉 참": "기술·자격·거리가 맞는 작업자는 있지만, 그 시간에 이미 다른 작업이 잡혀 있어 넣을 자리가 없음",
    "희망시간에 가능한 사람 없음": "자격이 맞는 작업자의 근무 가능시간이 고객 희망시각(허용 오차 포함)과 맞지 않음",
    "갈 수 있는 거리 밖": "관할 밖으로 허용한 거리를 넘어서야 갈 수 있어 보낼 작업자가 없음",
    "기술 보유자 없음": "이 회선 매체(HFC·FTTx·CATV) 기술을 가진 작업자가 없음",
    "자격 보유자 없음": "승주·고위험 작업에 필요한 자격을 가진 작업자가 없음",
    미배정: "작업자를 정하지 못한 지시서. 고객 방문이 미뤄지거나 다시 일정을 잡아야 한다",
    가동률: "작업자가 일할 수 있는 시간 중 실제로 작업한 시간의 비율",
    활용률: "작업자가 일할 수 있는 시간 중 실제로 작업한 시간의 비율",
    CEI: "작업자 숙련 등급 점수 (높을수록 숙련)",
  },
  background: [
    "가상의 통신 설치·수리 출동 업무다. 기사가 고객 집을 방문해 회선을 개통(새로 설치)하거나 장애를 고친다.",
    "지점 3곳(서초·강남·송파)에 지점마다 작업자 10명. 지시서는 하루 150건 × 10일 = 1500건.",
    "지시서마다 작업유형(개통·장애), 회선 매체(HFC·FTTx·CATV), 난이도(일반·승주·옥외·고위험), 건물유형(주택·아파트), 고객 희망시각이 있다.",
    "배정 규칙: 매체 기술과 난이도 자격은 반드시 맞아야 한다. 시간(희망시각과의 차이)과 지역(관할 밖 거리)은 3단계로 조금씩 넓혀 가며 작업자를 찾는다.",
    "배정은 그날 안에서만 한다(다음 날로 넘기지 않음). 미배정 사유는 5가지: 기술 보유자 없음 · 자격 보유자 없음 · 희망시간에 가능한 사람 없음 · 갈 수 있는 거리 밖 · 일정이 꽉 참.",
  ],
  // 지시서 ID는 "D01-O015" 형식: 날짜별로 묶는다
  scopes: (_instance, itemIds) => {
    const days = new Map<string, string[]>();
    for (const id of itemIds) {
      const day = id.split("-")[0];
      days.set(day, [...(days.get(day) ?? []), id]);
    }
    const perDay: Scope[] = [...days.entries()].map(([day, items]) => ({
      id: day,
      label: `${Number(day.slice(1))}일차 (${items.length}건)`,
      items,
    }));
    const first = perDay[0];
    // AI 시범 범위: 1일차 처리 순서 앞 10·50·100건 (AI 비용·시간 때문에 일부만, 최대 100건)
    const sample: Scope[] = first
      ? [10, 50, 100].filter((n) => n < (first.items ?? []).length).map((n) => ({
          id: `${first.id}-${n}`, label: `${Number(first.id.slice(1))}일차 앞 ${n}건${n === 10 ? " (시범)" : ""}`,
          items: (first.items ?? []).slice(0, n) }))
      : [];
    return [...sample, ...perDay, { id: "all", label: `전체 ${itemIds.length}건`, items: null }];
  },
};

// 지점 코드 → 이름 (데이터의 branches.name, 예: B → 강남)
function branchNames(instance: unknown): Record<string, string> {
  const branches = (instance as { branches?: Record<string, { name?: string }> } | null)?.branches ?? {};
  return Object.fromEntries(Object.entries(branches).map(([k, v]) => [k, v.name ?? k]));
}

// 구간 조건(when) → 쉬운 말 (예: {area_zone: [boundary]} → "경계 지역", {hour: ["10","16"]} → "10·16시")
function whenText(when?: Record<string, string[]> | null): string {
  if (!when) return "";
  return Object.entries(when).map(([dim, vals]) => {
    const vs = (Array.isArray(vals) ? vals : [vals]).map(String);
    if (dim === "hour") return `${vs.map((v) => Number(v)).join("·")}시`;
    if (dim === "branch") return `${vs.join("·")}지점`;
    return vs.map((v) => LABELS[v] ?? v).join("·");
  }).join(" ");
}

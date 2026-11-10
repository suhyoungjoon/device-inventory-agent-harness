// 화면 용어 (M8-a). 화면에는 쉬운 말(label)만 보이고, 원래 용어(tech)는 마우스를 올리면 보인다.
// 코드·API·설정 파일의 이름은 바꾸지 않는다. 도메인 고유 용어(지표 이름, 미배정 사유 등)는 도메인 어댑터에 둔다.
// 같은 목록이 화면 매뉴얼(docs/ui-guide.md)의 용어표다.

import type { HarnessLevel } from "./types";

export interface TermDef {
  label: string;
  tech: string;
}

const t = (label: string, tech: string): TermDef => ({ label, tech });

export const TERMS = {
  outcome: t("실적 (가상 고객 반응)", "계획 vs 실적 (M17): 계획(규칙 엔진 배정)에 현실 모델의 고객 반응·이월을 붙여 만든 실적. 참고용, AI에게 보이지 않음"),
  promiseKept: t("약속 준수", "promise_kept: 원래 희망 날짜에, 희망 시각 ±60분 안에 완료된 지시서 (실적). 계획의 '정시 배정'과 다르다"),
  // 탭
  tabDomain: t("규칙·데이터", "도메인 탭"),
  tabCompare: t("비교", "비교 탭"),
  tabTrace: t("결정 과정", "트레이스 탭"),
  tabAnalysis: t("문제 찾기", "분석 탭"),
  tabImprove: t("개선 제안", "개선 탭"),
  tabGuide: t("에이전트 소개", "핵심 에이전트(배정·분석·개선·의견 정리·Supervisor), 하네스 레벨, LangGraph 구성 설명 (실행 없음)"),
  tabAgentRuns: t("에이전트", "에이전트 탭 (M16): 배정·분석·개선·의견 정리 에이전트를 하나씩 실행하고 턴 → 도구 → 하네스 검사를 본다"),
  tabAgents: t("LangGraph agents", "LangGraph 에이전트 탭 (M10): 배정·분석·개선 제안 에이전트 내부까지 LangGraph 하위 그래프"),
  tabWorkflow: t("Agent workflow", "LangGraph 워크플로우 탭 (M9): 위 단계를 그래프 하나로 한 단계씩 실행"),
  // 두 방식
  rule: t("규칙 방식", "규칙 agent (기준선)"),
  ai: t("AI 방식", "AI agent"),
  aiAnalysis: t("AI 분석", "분석 agent"),
  // 데이터·실행
  seed: t("데이터 번호", "seed: 같은 번호면 같은 데이터"),
  faults: t("심어둔 문제", "결함 패턴 (faults.yaml)"),
  scope: t("처리할 건수", "실행 범위 (scope)"),
  dataset: t("데이터", "데이터셋"),
  domain: t("업무", "도메인"),
  demo: t("저장된 결과 보기", "시연 모드 (재생)"),
  // 하네스
  harness: t("하네스 레벨", "하네스 레벨 (configs/harness_levels.yaml)"),
  spec: t("업무 규칙 문서", "도메인 명세 (domain-spec.md)"),
  tools: t("조회 기능", "도구 (tools)"),
  validateLoop: t("규칙 위반 검사", "검증 루프 (validate_loop)"),
  guardrail: t("위험 결정 확인", "가드레일 (guardrail)"),
  trace: t("과정 기록", "트레이스 (trace)"),
  llm: t("AI 호출", "LLM 호출"),
  // 결과
  violations: t("규칙 위반", "필수조건 위반 (사후 채점: 모든 결정을 validate()로 다시 검사)"),
  violationRules: t("지켜야 할 규칙", "필수조건 (violation_rules)"),
  unassigned: t("미배정", "미할당 (failed)"),
  reasons: t("미배정 사유", "사유 코드 (reason_codes)"),
  consistency: t("반복 시 같은 결과", "일관성: 같은 레벨을 반복 실행했을 때 결정이 모두 같은 항목의 비율"),
  dimensions: t("분석 조건", "분석 차원 (dimensions)"),
  // 문제 찾기
  finding: t("찾은 문제", "발견 (finding)"),
  evidence: t("근거 데이터", "근거 (인용한 도구 호출)"),
  slice: t("조건", "구간 (slice)"),
  detection: t("찾아낸 비율", "패턴 탐지율 (정답표 채점)"),
  unmatched: t("정답에 없는 문제", "정답과 매칭 안 된 발견"),
  validFinding: t("맞는 문제", "정당한 발견"),
  falsePositive: t("잘못 짚음", "오탐"),
  answerKey: t("정답", "정답표"),
  // 개선 제안
  proposal: t("개선 제안", "개선안"),
  simulate: t("미리 돌려보기", "시뮬레이션"),
  params: t("규칙 설정값", "규칙 파라미터 (params.yaml)"),
  bounds: t("바꿀 수 있는 범위", "허용 범위 (bounds)"),
  overrides: t("특정 조건에만 적용", "구간 조건 (overrides)"),
  history: t("반영 이력", "개선 이력 (회차)"),
} satisfies Record<string, TermDef>;

export type TermKey = keyof typeof TERMS;

/** 마우스 올림 설명: 원래 용어 */
export const tip = (k: TermKey) => `원래 용어: ${TERMS[k].tech}`;
export const label = (k: TermKey) => TERMS[k].label;

// 코어가 내는 미배정 사유 (도메인 사유는 도메인 어댑터의 reasonNames)
export const CORE_REASON_NAMES: Record<string, string> = {
  LLM_NO_DECISION: "AI가 결정을 내지 않음",
  LLM_REFUSAL: "AI가 거절함",
  LLM_MAX_TURNS: "AI 호출 횟수 초과",
  LLM_ERROR: "AI 호출 오류",
  LLM_REPEATED: "AI가 같은 조회를 반복해 멈춤",
  TOOL_FAILURE: "도구가 계속 실패해 멈춤",
  UNSPECIFIED: "사유 없이 미배정",
  BLOCKED_BY_GUARDRAIL: "위험 결정이라 막음",
  NEEDS_APPROVAL: "승인이 필요해 대기",
};

// --- 하네스 레벨 짧은 이름: 설정 파일의 플래그에서 만든다 (레벨 이름에 고정하지 않는다) ---

type Flag = "spec" | "tools" | "validate_loop" | "guardrail" | "trace";
export const FLAG_TERMS: [Flag, TermKey][] = [
  ["spec", "spec"],
  ["tools", "tools"],
  ["validate_loop", "validateLoop"],
  ["guardrail", "guardrail"],
  ["trace", "trace"],
];
export const flagOn = (lv: HarnessLevel, flag: Flag) => (flag === "trace" ? lv.trace === "full" : !!lv[flag]);

/** 바로 앞 레벨보다 새로 켜진 기능으로 이름을 만든다. 예: L3 → "+자동 검사". 첫 레벨은 켜진 기능이 없으면 "기본". */
export function levelShortName(levels: Record<string, HarnessLevel>, name: string): string {
  const names = Object.keys(levels);
  const i = names.indexOf(name);
  const lv = levels[name];
  if (!lv) return "";
  const prev = i > 0 ? levels[names[i - 1]] : null;
  const added = FLAG_TERMS.filter(([f]) => flagOn(lv, f) && !(prev && flagOn(prev, f))).map(([, k]) => TERMS[k].label);
  if (added.length) return added.map((a) => `+${a}`).join(" ");
  return prev ? "" : "기본";
}

// [M21 추가] 공통 화면 문구의 도메인 용어. 화면에 한 도메인만 보이므로 App이 고른 도메인의 용어를 정해 둔다.
// 용어가 없는 도메인(출동)은 문구를 그대로 둔다.
import type { DomainTerms } from "./domains/types";

let activeTerms: DomainTerms | undefined;

export function setDomainTerms(terms: DomainTerms | undefined) {
  activeTerms = terms;
}

export const domainTerms = () => activeTerms;

/** 출동 용어(지시서·배정·미배정)를 지금 도메인의 용어로 바꾼다 */
export function L(text: string): string;
export function L(text: string | undefined): string | undefined;
export function L(text: string | undefined): string | undefined {
  const t = activeTerms;
  if (!t || !text) return text;
  return text
    .replace(/배정 에이전트/g, t.agent)
    .replace(/미배정/g, t.unassigned)
    .replace(/재배정/g, `다시 ${t.decide}`)
    .replace(/지시서/g, t.item)
    .replace(/배정/g, t.decide);
}

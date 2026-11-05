import type { ComponentType } from "react";
import type { DecisionRecord, Dimensions } from "../types";

// 도메인 어댑터: 결과 시각화, 지표 표시, 실행 범위 선택만 도메인별로 바꾼다 (plan A7).
export interface ResultViewProps {
  instance: unknown;
  decisions: DecisionRecord[];
  dimensions: Dimensions;
  reasonLabels: Record<string, string>;   // 사유 코드 → 화면 이름 (짧은 쉬운 말)
  reasonDetails?: Record<string, string>; // [M8 추가] 사유 코드 → 설명 문장 (마우스 올림)
  selected?: string | null;
  onSelect?: (itemId: string) => void;
  highlight?: string[] | null; // 강조할 항목 (나머지는 흐리게)
  runId?: string | null;       // [M21 추가] 실행 ID (도메인 결과 화면 데이터 GET /runs/{id}/view를 쓰는 어댑터용)
}

// 득실 지도 기본값 (M13): 처음 열 때 탐색할 파라미터 축과 가로·세로 지표
export interface TradeoffDefaults {
  axes: [string, string?];
  metrics: [string, string];
}

export interface MetricSpec {
  key: string;
  label: string;
  format: "pct" | "min" | "day" | "manwon";   // [M21 추가] day = 일, manwon = 만원
  headline?: boolean; // 비교표에 넣을 지표
  tech?: string;      // [M8 추가] 원래 용어·계산 방식 (마우스 올림)
  primary?: boolean;  // [M8 추가] 요약에 항상 보일 지표 (나머지는 상세보기). 규칙 위반·건당 비용은 공통 항목이라 따로 보인다
  better?: "up" | "down"; // [M8 추가] 좋은 방향. 개선 제안의 부작용(나빠진 지표) 판정에 쓴다. 없으면 판정에서 뺀다
}

export interface Scope {
  id: string;
  label: string;
  items: string[] | null; // null이면 전체
}

// [M6 추가] 도메인 탭의 데이터 표·지도. 없으면 도메인 탭에 데이터 표를 보여주지 않는다.
export interface DataFocus {
  table: string; // DomainData.tables의 key
  id: string;    // 행 ID
}

export interface DataViewProps {
  instance: unknown;
  focus: DataFocus | null;
}

export interface DomainData {
  // 인스턴스 JSON에서 표로 보여줄 필드: 레코드 배열이거나 {ID: 레코드} 객체. idField는 행 ID 필드 (객체면 키)
  tables: { key: string; label: string; idField: string }[];
  fieldLabels?: Record<string, string>;                               // [M8 추가] 필드 이름 → 화면 이름 (머리글·필터)
  hidden?: string[];                                                   // 표에서 숨길 필드 (예: 긴 좌표 배열)
  format?: (table: string, field: string, value: unknown) => string | undefined; // 표시 형식 (없으면 기본)
  View?: ComponentType<DataViewProps>;                                 // 선택한 행을 보여주는 지도 등
}

// [M21 추가] 공통 화면 문구의 도메인 용어. 없으면 출동 용어(지시서·배정)
export interface DomainTerms {
  item: string;     // 결정 대상 한 건 (지시서 / 발주 항목)
  decide: string;   // 결정하는 일 (배정 / 발주)
  decided: string;  // 결정 결과 (배정 결과 / 발주 결정)
  agent: string;    // 결정 에이전트 이름 (배정 에이전트 / 발주 에이전트)
  unassigned: string; // 결정하지 못한 건 (미배정 / 미발주)
  unit: string;     // 건수 단위
  opinionExample?: string;  // 사람 검토 의견 칸의 예시 문장
}

export interface DomainAdapter {
  ResultView: ComponentType<ResultViewProps>;
  terms?: DomainTerms;
  metrics: MetricSpec[];
  // 실행 범위 후보 (비용 때문에 AI는 일부만 돌린다). itemIds는 처리 순서
  scopes: (instance: unknown, itemIds: string[]) => Scope[];
  data?: DomainData; // [M6 추가]
  reasonNames?: Record<string, string>; // [M8 추가] 도메인 사유 코드 → 짧은 쉬운 이름 (없으면 dimensions.yaml 설명 문장)
  valueNames?: Record<string, string>;  // [M8 추가] 조건 값 → 화면 이름 (예: boundary → 경계 지역). 없으면 값 그대로
  tradeoff?: TradeoffDefaults;          // [M13 추가] 득실 지도 기본 축·지표. 없으면 첫 번째 파라미터와 지표
  decisionText?: (decision: Record<string, unknown>) => string; // [M8 추가] 결정 한 줄 요약 (결정 과정 탭). 없으면 필드 값을 나열
  toolNames?: Record<string, string>;   // 도메인 도구 이름 → 쉬운 말 (에이전트 탭). 없으면 도구 이름 그대로
  argNames?: Record<string, string>;    // 도메인 도구 입력 이름·선택값 → 쉬운 말 (예: order_id → 지시서)
  // 의견 보내기 도움 (사람 검토): 고정 예시와, 추천 재료(설정값 한도)를 쉬운 문장으로. 없으면 일반 문장
  opinionExamples?: string[];
  opinionText?: (hint: import("../types").OpinionHint) => string | null;
  // 문제 찾기 쉽게 읽기: 업무를 모르는 사람도 읽게. 없으면 AI 문장을 그대로 (소수 비율 → %는 공통)
  plainText?: (text: string, instance: unknown) => string;                       // 도메인 코드 → 쉬운 말 (예: "지점 B" → "강남지점")
  sliceText?: (slice: Record<string, string[]>, instance: unknown) => string;    // 구간 → 쉬운 말 (예: "CATV · 16시")
  glossary?: Record<string, string>;   // 업무 용어 → 한 줄 설명 (점선 밑줄, 마우스를 올리면)
  background?: string[];               // 업무 배경 한눈에 (문제 찾기 탭 위)
}

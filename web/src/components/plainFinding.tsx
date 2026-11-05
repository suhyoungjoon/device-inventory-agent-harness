import type { ReactNode } from "react";
import type { DomainAdapter } from "../domains/types";
import type { DecisionRecord, Finding } from "../types";
import { L, TERMS } from "../terms";

// 문제 찾기 쉽게 읽기: AI가 쓴 문장 속 코드·소수 비율을 쉬운 말로, 업무 용어에는 설명을 단다.
// 저장된 리포트는 바꾸지 않고 화면에서만 바꾼다 (지난 리포트에도 그대로 적용, AI 호출 없음).

const UNIT_AFTER = /^\s*(km|분|시간|건|명|배|시)/;

// 단독 소수(0.538) → 53.8%. 뒤에 단위(km·분·건 등)가 붙으면 비율이 아니므로 그대로
export function plainRates(text: string): string {
  return text.replace(/(?<![\d.])0\.\d+(?![\d.])/g, (m, offset: number, all: string) => {
    if (UNIT_AFTER.test(all.slice(offset + m.length))) return m;
    const pct = Number(m) * 100;
    return `${Number.isInteger(Math.round(pct * 10) / 10) ? pct.toFixed(0) : pct.toFixed(1)}%`;
  });
}

// 바꾼 낱말 뒤에 붙은 조사를 받침에 맞게 (CAPACITY로 → 일정이 꽉 참으로)
const PARTICLES: [string, string][] = [["으로", "로"], ["은", "는"], ["이", "가"], ["을", "를"], ["과", "와"], ["이다", "다"]];

function fixParticle(word: string, particle: string): string {
  const c = word.charCodeAt(word.length - 1);
  const batchim = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : -1;
  if (batchim < 0) return particle;                      // 한글로 끝나지 않으면 그대로
  const pair = PARTICLES.find(([a, b]) => particle === a || particle === b);
  if (!pair) return particle;
  if (pair[0] === "으로") return batchim === 0 || batchim === 8 ? "로" : "으로";   // ㄹ 받침은 '로'
  return batchim === 0 ? pair[1] : pair[0];
}

// 영문 코드 낱말(CAPACITY, high_risk, area_zone …) → 화면 이름. 표에 없는 낱말(CATV 등)은 그대로.
// "고위험(high_risk)"처럼 원래 이름을 괄호로 같이 쓴 곳은 한 번만
export function plainWords(text: string, words: Record<string, string>): string {
  return text
    .replace(/([A-Za-z][A-Za-z0-9_]*)(으로|이다|로|은|는|이|가|을|를|과|와|다)?/g, (m, w: string, p?: string) => {
      const name = words[w];
      if (!name) return m;
      return name + (p ? fixParticle(name, p) : "");
    })
    .replace(/([가-힣A-Za-z0-9]+(?: [가-힣]+)*)\s*\(\1\)/g, "$1");
}

export interface Plain {
  text: (s: string) => string;          // 코드·소수를 바꾼 문장
  render: (s: string) => ReactNode;     // 바꾼 문장 + 업무 용어 설명(점선 밑줄)
  glossary: Record<string, string>;
}

export function makePlain(adapter: DomainAdapter, instance: unknown, words: Record<string, string>): Plain {
  const glossary = adapter.glossary ?? {};
  const terms = Object.keys(glossary).sort((a, b) => b.length - a.length);
  const pattern = terms.length ? new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g") : null;
  const text = (s: string) => plainRates(plainWords(adapter.plainText ? adapter.plainText(s, instance) : s, words));
  const render = (s: string): ReactNode => {
    const t = text(s);
    if (!pattern) return t;
    const seen = new Set<string>();     // 같은 용어는 문장에서 처음 한 번만 밑줄
    return t.split(pattern).map((part, i) => {
      if (!glossary[part] || seen.has(part)) return part;
      seen.add(part);
      return <abbr key={i} className="term" title={glossary[part]}>{part}</abbr>;
    });
  };
  return { text, render, glossary };
}

// 이 발견이 가리키는 항목 (구간, 자원 발견이면 그 자원이 맡은 항목, 둘 다면 교집합). 가리키는 곳이 없으면 null
export function findingItems(f: Finding, decisions: DecisionRecord[], idField?: string): DecisionRecord[] | null {
  if (!f.slice && !(f.resources && idField)) return null;
  let rows = decisions;
  if (f.slice) {
    rows = rows.filter((d) => Object.entries(f.slice!).every(([dim, values]) => values.map(String).includes(String(d.dims[dim]))));
  }
  if (f.resources && idField) {
    const ids = new Set(f.resources.ids.map(String));
    rows = rows.filter((d) => ids.has(String(d.decision?.[idField])));
  }
  return rows;
}

// 코드가 만든 한 줄 요약: "CATV · 16시: 10건 중 미배정 5건 (50%, 전체 6.7%) · 주된 이유: 일정이 꽉 참 5건"
export function findingSummary(rows: DecisionRecord[], all: DecisionRecord[], where: string,
                               reasonLabels: Record<string, string>): string | null {
  if (!rows.length || !all.length) return null;
  const bad = rows.filter((d) => d.status !== "success");
  const allBad = all.filter((d) => d.status !== "success").length;
  const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1).replace(/\.0$/, "")}%`;
  const counts = new Map<string, number>();
  bad.forEach((d) => d.reason_code && counts.set(d.reason_code, (counts.get(d.reason_code) ?? 0) + 1));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return `${where ? `${where}: ` : ""}${rows.length}건 중 ${L(TERMS.unassigned.label)} ${bad.length}건 (${pct(bad.length, rows.length)}, 전체 ${pct(allBad, all.length)})`
    + (top ? ` · 주된 이유: ${reasonLabels[top[0]] ?? top[0]} ${top[1]}건` : "");
}

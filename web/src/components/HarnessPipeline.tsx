import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { L, TERMS, levelShortName, tip, type TermKey } from "../terms";
import type { DomainDefinition, HarnessInfo, HarnessLevel } from "../types";

// 하네스 파이프라인 그림 (M7-a). 단계 구조와 설명은 코어 개념이라 도메인과 무관하고,
// 도구 목록·필수조건 수만 도메인 정의 API에서 가져온다.

type StageId = "input" | "llm" | "submit" | "validate" | "guardrail" | "trace";
type Flag = "spec" | "tools" | "validate_loop" | "guardrail" | "trace";

const isOn = (lv: HarnessLevel, flag: Flag) => (flag === "trace" ? lv.trace === "full" : !!lv[flag]);

interface StageDoc {
  what: string;
  config: string;
  shows: string;
}

export default function HarnessPipeline({
  harness,
  domain,
  level,
  onChange,
  disabled,
}: {
  harness: HarnessInfo;
  domain: string;
  level: string;
  onChange: (level: string) => void;
  disabled?: boolean;
}) {
  const [def, setDef] = useState<DomainDefinition | null>(null);
  const [stage, setStage] = useState<StageId>("input");
  useEffect(() => {
    api.definition(domain).then(setDef).catch(() => setDef(null));
  }, [domain]);

  const names = Object.keys(harness.levels);
  const lv = harness.levels[level];
  if (!lv) return null;
  // 플래그가 처음 켜지는 레벨 ("L3부터")
  const since = (flag: Flag) => names.find((n) => isOn(harness.levels[n], flag));
  const off = (flag: Flag) => (isOn(lv, flag) ? "" : " off");
  const offNote = (flag: Flag) => !isOn(lv, flag) && <span className="stage-off">꺼짐 · {since(flag)}부터</span>;
  const term = (k: TermKey) => ({ title: TERMS[k].label, tech: tip(k) });
  const maxCalls = harness.llm.max_llm_calls_per_item;
  const toolCount = def?.tools.length;
  const ruleCount = def ? Object.keys(def.dimensions.violation_rules ?? {}).length : undefined;
  const retries = lv.validate_loop ? lv.max_retries : harness.levels[since("validate_loop") ?? ""]?.max_retries;

  const docs: Record<StageId, StageDoc> = {
    input: {
      what:
        "지시서 하나를 처리할 때 AI에게 보내는 내용. 기본 지시(결정 하나를 정해진 형식으로 제출하라)는 항상 들어간다. " +
        "업무 규칙 문서가 켜지면 문서 전체를 함께 보낸다. 조회 기능이 꺼져 있으면 데이터 전체와 지금까지 정한 결정을 통째로 보내고, " +
        "켜지면 데이터 대신 조회 기능을 주어 AI가 필요한 것만 묻게 한다.",
      config: "configs/harness_levels.yaml의 spec·tools, 명세 내용은 domain-spec.md, 도구는 도메인 팩의 tools()",
      shows: "건당 비용(데이터를 통째로 보내는 L0·L1은 입력이 커서 비싸다), 결정 과정 탭의 조회 기록(과정 기록이 켜진 레벨)",
    },
    llm: {
      what:
        `지시서마다 AI를 호출하고, AI가 조회를 요청하면 결과를 돌려주며 다시 호출한다. 다시 시도한 횟수도 포함해 ` +
        `한 지시서에서 ${maxCalls}회 안에 결정이 나지 않으면 멈춘다.`,
      config: "configs/llm.yaml의 model·effort·max_llm_calls_per_item",
      shows: "횟수를 넘기면 미배정(사유: AI 호출 횟수 초과), 결정 과정 탭의 AI 응답(과정 기록이 켜진 레벨)",
    },
    submit: {
      what:
        "모든 레벨에서 결정은 정해진 제출 형식(submit_decision)으로만 받는다. 배정이면 결정 내용, 미배정이면 사유, " +
        "그리고 판단 근거 한두 문장. 조회 기능을 끄고 켜는 것과 상관없이 제출 형식은 항상 있다.",
      config: "코어(core/harness/runner.py). 결정 형식은 도메인 팩의 decision_schema(), 사유 코드는 dimensions.yaml",
      shows: "결과 화면의 배정·미배정, 미배정 사유, 판단 근거",
    },
    validate: {
      what:
        `제출한 결정이 지켜야 할 규칙을 어기는지 바로 검사한다. 어기면 이유를 AI에게 돌려주고 다시 결정하게 한다` +
        `(지시서당 최대 ${retries ?? "–"}회). 다시 시도를 다 써도 어기면 그대로 다음 단계로 간다.` +
        (ruleCount !== undefined ? ` 이 업무의 지켜야 할 규칙은 ${ruleCount}개.` : ""),
      config: "configs/harness_levels.yaml의 validate_loop·max_retries, 필수조건은 도메인 팩의 validate()",
      shows: "결정 과정 탭의 \"다시 시도한 건\", 비교표의 규칙 위반 감소",
    },
    guardrail: {
      what:
        "규칙을 어긴 채 남은 결정은 막고(차단), 어기지 않았어도 사람 승인이 필요한 조건이면 승인 대기로 둔다. " +
        "나머지는 확정. 승인이 필요한 조건은 업무마다 다르다(규칙·데이터 탭의 규칙 설정값).",
      config: "configs/harness_levels.yaml의 guardrail, 승인 조건은 도메인 팩의 approval_reasons()와 params.yaml",
      shows: "결과 화면의 차단·승인 대기 표시",
    },
    trace: {
      what:
        "최종 결과만이면 지시서마다 결정 하나만 남는다. 모든 단계면 AI 응답·조회·자동 검사·다시 시도·위험 결정 막기를 순서대로 남긴다.",
      config: "configs/harness_levels.yaml의 trace (minimal | full)",
      shows: "결정 과정 탭(모든 단계를 남긴 실행에서만 단계 목록이 보인다)",
    },
  };

  const stageProps = (id: StageId, flag?: Flag) => ({
    id, current: stage === id, dim: flag ? !isOn(lv, flag) : false, onSelect: setStage,
    note: flag ? offNote(flag) : null,
  });

  const doc = docs[stage];
  return (
    <div className="pipeline-panel">
      <div className="pipeline" aria-label={`${level} 하네스 처리 흐름`}>
        {/* 단계 이름은 쉬운 말, 원래 용어는 마우스 올림 (M8-a) */}
        <Stage {...stageProps("input")} num="①" title="입력">
          <span className="stage-row">기본 지시 <em>항상</em></span>
          <span className={`stage-row${off("spec")}`} title={tip("spec")}>
            {TERMS.spec.label} <em>{isOn(lv, "spec") ? "켬" : `${since("spec")}부터`}</em>
          </span>
          <span className="stage-row data-mode">
            <span className={lv.tools ? "mode" : "mode current"} title="원래 용어: 인스턴스 전체 JSON">데이터 통째로</span>
            <span aria-hidden>→</span>
            <span className={lv.tools ? "mode current" : "mode"} title={tip("tools")}>
              {TERMS.tools.label}{toolCount !== undefined ? ` ${toolCount}개` : ""}
            </span>
          </span>
        </Stage>
        <Stage {...stageProps("llm")} num="②" {...term("llm")}>
          <span className="stage-row">{L("지시서")}당 최대 {maxCalls}회</span>
        </Stage>
        <Stage {...stageProps("submit")} num="③" title="결정 제출">
          <span className="stage-row">정해진 형식으로 <em>항상</em></span>
        </Stage>
        <Stage {...stageProps("validate", "validate_loop")} num="④" {...term("validateLoop")}>
          <span className="stage-row">규칙을 어기면 ②로 다시 시도</span>
        </Stage>
        <Stage {...stageProps("guardrail", "guardrail")} num="⑤" {...term("guardrail")}>
          <span className="stage-row">확정 / 차단 / 승인 대기</span>
        </Stage>
        <Stage {...stageProps("trace")} num="⑥" {...term("trace")}>
          <span className="stage-row">{lv.trace === "full" ? "모든 단계" : "최종 결과만"}</span>
          {lv.trace !== "full" && <span className="stage-off">모든 단계는 {since("trace")}부터</span>}
        </Stage>
        <div className={`retry-loop${off("validate_loop")}`} aria-hidden>
          <span>↺ 어긴 이유를 돌려주고 ② 다시 호출 · 최대 {retries ?? "–"}회</span>
        </div>
      </div>

      <div className="posthoc" title={tip("violations")}>
        <strong>마지막 규칙 검사</strong> 모든 레벨: 최종 결정이 규칙을 어겼는지 다시 검사해 센다. 결과는 바꾸지 않고 비교표의 {TERMS.violations.label} 건수가 된다.
        {ruleCount !== undefined && <span className="muted"> {TERMS.violationRules.label} {ruleCount}개</span>}
      </div>

      <div className="stage-detail">
        <dl>
          <dt>하는 일</dt>
          <dd>{L(doc.what)}</dd>
          <dt>설정 위치 (파일)</dt>
          <dd>{doc.config}</dd>
          <dt>결과에서 보이는 곳</dt>
          <dd>{L(doc.shows)}</dd>
        </dl>
        {stage === "input" && def && def.tools.length > 0 && (
          <div className="tool-list">
            <span className="muted small">{TERMS.tools.label} (켜진 레벨에서 AI에게 제공)</span>
            <ul>
              {def.tools.map((t) => (
                <li key={t.name}><code>{t.name}</code> {t.description}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <table className="level-matrix">
        <caption className="muted small">레벨별 단계 (행을 누르면 레벨 전환)</caption>
        <thead>
          <tr>
            <th scope="col">레벨</th>
            <th scope="col" title={tip("spec")}>{TERMS.spec.label}</th>
            <th scope="col">데이터</th>
            <th scope="col" title={tip("validateLoop")}>{TERMS.validateLoop.label}</th>
            <th scope="col" title={tip("guardrail")}>{TERMS.guardrail.label}</th>
            <th scope="col" title={tip("trace")}>{TERMS.trace.label}</th>
          </tr>
        </thead>
        <tbody>
          {names.map((n) => {
            const l = harness.levels[n];
            const dot = (on: boolean) => <span className={on ? "dot on" : "dot"}>{on ? "●" : "○"}</span>;
            return (
              <tr key={n} className={n === level ? "current" : undefined}
                onClick={() => !disabled && onChange(n)}>
                <th scope="row">
                  <button type="button" disabled={disabled} aria-pressed={n === level}
                    onClick={(e) => { e.stopPropagation(); onChange(n); }}>
                    {n}
                  </button>
                  <span className="muted small"> {levelShortName(harness.levels, n)}</span>
                </th>
                <td>{dot(l.spec)}</td>
                <td>{l.tools ? TERMS.tools.label : "통째로"}</td>
                <td>{dot(l.validate_loop)}{l.validate_loop && <span className="muted small"> {l.max_retries}회</span>}</td>
                <td>{dot(l.guardrail)}</td>
                <td>{l.trace === "full" ? "모든 단계" : "최종만"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Stage({ id, num, title, tech, current, dim, note, onSelect, children }: {
  id: StageId; num: string; title: string; tech?: string; current: boolean; dim: boolean; note: ReactNode;
  onSelect: (id: StageId) => void; children?: ReactNode;
}) {
  return (
    <button type="button" className={`stage${dim ? " off" : ""}${current ? " current" : ""}`}
      aria-pressed={current} onClick={() => onSelect(id)} title={tech}>
      <span className="stage-title">{num} {title}</span>
      {note}
      {children}
    </button>
  );
}

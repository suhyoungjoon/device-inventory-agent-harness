// 시연 장면 녹화 (발표용 사전 녹화 백업, plan.md 13장 · 시연 동영상 지시서 `시연동영상_녹화_전달.md`).
//
// 서버를 띄운 뒤:
//   node scripts/record_demo.mjs [--url http://127.0.0.1:8000] [--out runs/recordings] [--scenes 1,2,3]
//                                [--seed 42] [--faults P1,P2,P3,P4] [--scope D01-10] [--from L0] [--to L3]
//                                [--trace-level L5] [--opinion "관할 밖 4km 넘으면 출동 불가"]
//                                [--width 1920] [--height 1080] [--take <이름>]
//                                [--pace 1] [--headed] [--allow-live] [--stills]
//
// 장면 1~3: 시연 모드 서버(저장된 결과 재생)용 짧은 장면 (발표 백업).
// 장면 v1~v6: 시연 동영상 한 편 (실제 회사 AI 호출, --allow-live). 문제 → 규칙 대 AI → 자가 개선 흐름 → Supervisor →
//   승인 전 고객 기준 → 마무리. 장면마다 webm 하나, AI를 기다린 구간은 scene-<id>.marks.json (후처리가 그 구간만 배속),
//   화면에서 읽은 핵심 수치·비용·시간은 takes.json에 테이크 단위로 쌓는다 (자막 문구 확정용).
// 시연 모드가 아니면(실제 LLM 호출·비용 발생) --allow-live 없이는 멈춘다. 키는 화면·로그·파일에 남기지 않는다
// (녹화는 앱 화면만, 터미널·설정 화면은 찍지 않는다).
// playwright는 web/의 devDependency를 쓴다 (cd web && npm ci). 브라우저가 없으면 npx playwright install chromium.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(ROOT, "web", "package.json"))("playwright");

const DEFAULTS = {
  url: "http://127.0.0.1:8000", out: join(ROOT, "runs", "recordings"), scenes: "1,2,3", seed: "42",
  faults: "P1,P2,P3,P4", scope: "D01-10", from: "L0", to: "L3", "trace-level": "L5", pace: "1", width: "1600", height: "900",
  opinion: "관할 밖 4km 넘으면 출동 불가", take: "", "v2-to": "L5",   // v2 두 번째 레벨: L3 장치 + 과정 기록(결정 과정에서 다시 시도 단계를 펼침)
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS, headed: false, allowLive: false, stills: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (key === "headed") opts.headed = true;
    else if (key === "allow-live") opts.allowLive = true;
    else if (key === "stills") opts.stills = true;
    else if (key in DEFAULTS) opts[key] = argv[++i];
    else throw new Error(`알 수 없는 옵션: ${argv[i]}`);
  }
  if (!opts.take) opts.take = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const pause = (page, ms) => page.waitForTimeout(ms * Number(opts.pace));
const TIMEOUT = 120_000;
const AI_TIMEOUT = 20 * 60_000;      // 실제 AI 단계 하나 (분석 gpt-5 관점 3개 등)

let still = { scene: "", n: 0 };
let scene = { id: "", started: 0, marks: [], facts: {} };   // 지금 녹화 중인 장면: AI 대기 구간, 화면에서 읽은 수치

async function saveStill(page) {
  if (!opts.stills || !still.scene) return;
  still.n += 1;
  await page.screenshot({ path: join(opts.out, `scene-${still.scene}-${String(still.n).padStart(2, "0")}.png`) });
}

// 로그 태그 (제목 카드 범례와 같은 색): 정지 화면 하나만 봐도 무엇을 보여 주는지 알게
export const TAGS = { planning: ["Planning", "#2a78d6"], tool: ["Tool Call", "#0ca30c"], fix: ["Self-Correction", "#d9730d"] };

// 화면 하단 자막 (녹화에만 보인다). tag를 주면 앞에 색 칩. 1080p로 키워도 읽히게 글자를 키운다
async function caption(page, text, tag = null, still = true) {
  if (still && await page.locator("#rec-caption").count()) await saveStill(page);
  const size = Math.round(19 * Number(opts.height) / 900);
  const chip = tag ? TAGS[tag] : null;
  await page.evaluate(([t, px, c]) => {
    let el = document.getElementById("rec-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "rec-caption";
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;"
        + "max-width:86%;padding:12px 22px;border-radius:10px;background:rgba(20,20,19,.92);color:#fff;"
        + `font:600 ${px}px/1.45 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none`;
      document.body.appendChild(el);
    }
    el.textContent = "";
    if (c) {
      const b = document.createElement("span");
      b.textContent = `[${c[0]}]`;
      b.style.cssText = `background:${c[1]};color:#fff;border-radius:6px;padding:2px 8px;margin-right:10px`;
      el.appendChild(b);
    }
    el.appendChild(document.createTextNode(t));
  }, [text, size, chip]);
}

// 자막을 띄우고 읽을 시간만큼 멈춘다: max(4초, 글자 수 ÷ 10초) × pace
async function say(page, text, tag = null, still = true) {
  await caption(page, text, tag, still);
  await page.waitForTimeout(Math.max(4000, (text.length / 10) * 1000) * Number(opts.pace));
}

// 로그 한 줄 강조: 화면 가운데로 스크롤 → 테두리·배경 → 자막과 함께 최소 4초 (1배속). 못 찾으면 건너뛰고 기록만 남긴다
async function spot(page, loc, { key, tag, say: words }) {
  const el = loc.first();
  const found = (await loc.count()) > 0 && await el.isVisible().catch(() => false);
  const record = { key, tag: tag ? TAGS[tag][0] : null, found };
  if (found) {
    await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
    // 칸(span)마다 띄워서 읽히게 ("1번째 Supervisor → 분석 에이전트 run_analysis() 전체 분석")
    record.text = (await el.evaluate((n) => {
      const parts = [];
      const walk = (x) => { if (x.nodeType === 3) parts.push(x.textContent); else if (x.nodeType === 1) { x.childNodes.forEach(walk); if (getComputedStyle(x).display !== "inline" || x.tagName === "SPAN" || x.tagName === "CODE") parts.push(" "); } };
      walk(n);
      return parts.join("").replace(/\s+/g, " ").trim();
    })).slice(0, 200);
    const color = tag ? TAGS[tag][1] : "#2a78d6";
    await el.evaluate((n, c) => { n.dataset.recOld = n.style.cssText; n.style.outline = `4px solid ${c}`; n.style.outlineOffset = "2px";
      n.style.background = `${c}22`; n.style.borderRadius = "4px"; }, color);
    await say(page, typeof words === "function" ? words(record.text) : words, tag, false);
    await saveStill(page);   // 이 줄을 강조한 화면 (자막과 함께)
    await el.evaluate((n) => { n.style.cssText = n.dataset.recOld ?? ""; });
  }
  (scene.facts.highlights ??= []).push(found ? record : { ...record, note: "못 찾음" });
  return found ? record.text : null;
}

// AI를 기다리는 구간 표시: 시작·끝(장면 시작부터 초)을 남긴다. 후처리가 이 구간만 배속한다
async function waiting(label, fn) {
  const start = (Date.now() - scene.started) / 1000;
  try {
    return await fn();
  } finally {
    scene.marks.push({ label, start: Number(start.toFixed(2)), end: Number(((Date.now() - scene.started) / 1000).toFixed(2)) });
  }
}

const fact = (key, value) => { scene.facts[key] = value; };
// 자막에 넣는 로그 인용은 짧게 (줄 자체는 화면에서 강조되어 보인다. 길면 자막 시간이 늘어 5분을 넘긴다)
const cut = (t, n = 45) => { const x = String(t ?? "").trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
const text = async (loc) => ((await loc.count()) ? (await loc.first().innerText()).replace(/\s+/g, " ").trim() : null);

async function openApp(page) {
  await page.goto(opts.url);
  await page.getByRole("tab", { name: "비교" }).waitFor({ timeout: TIMEOUT });
  // 시연 배너는 서버 설정(/harness/levels)을 받은 뒤에 그려진다. 같은 응답으로 그려지는 레벨 버튼을 기다린 뒤 확인한다
  await page.getByRole("radiogroup", { name: "하네스 레벨" }).waitFor({ timeout: TIMEOUT });
  const demo = await page.locator(".demo-banner").count();
  if (!demo && !opts.allowLive) {
    throw new Error("시연 모드 서버가 아님: 실제 LLM을 호출해 비용이 든다. 의도했다면 --allow-live");
  }
  return !demo;
}

// 비교 탭 (레이아웃 B): 왼쪽 칸에 데이터 번호·심어둔 문제·처리할 건수, 오른쪽 위에 데이터 생성
async function generate(page, scope = opts.scope) {
  const side = page.locator(".side-slot");
  await side.locator("label:has-text('데이터 번호') input").fill(opts.seed);
  const wanted = new Set(opts.faults.split(",").filter(Boolean));
  for (const box of await side.locator("fieldset label").all()) {
    const id = (await box.innerText()).trim().split(/\s+/)[0];
    await box.locator("input").setChecked(wanted.has(id));
  }
  await page.getByRole("button", { name: "데이터 생성" }).click();
  const select = side.locator("label:has-text('처리할 건수') select");
  await select.waitFor({ timeout: TIMEOUT });
  await select.selectOption(scope);
}

async function runAi(page, level) {
  // 레벨 버튼 이름은 "L3 +자동 검사"처럼 짧은 설명이 붙는다
  await page.getByRole("radiogroup", { name: "하네스 레벨" }).getByRole("radio", { name: new RegExp(`^${level}( |$)`) }).click();
  await page.getByRole("button", { name: /AI 방식 실행/ }).click();
  const error = page.locator(".compare .status-line .critical-text");
  const done = page.locator(".progress-list");
  // 진행 표시가 나타났다가 사라지고 AI 방식 지도가 그려질 때까지가 AI 대기 (진행 표시가 늦게 나타나도 대기로 잡는다)
  await waiting(`AI 배정 ${level}`, async () => {
    await done.waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
    if (await error.count()) throw new Error(`${level} 실행 실패: ${await error.innerText()}`);
    await done.waitFor({ state: "detached", timeout: AI_TIMEOUT });
    await page.getByText("AI 방식", { exact: true }).locator("xpath=ancestor::article").locator("svg").first()
      .waitFor({ timeout: TIMEOUT });
  });
}

// 비교표 한 줄 → {열 이름: 값}
async function compareRows(page) {
  return page.locator(".compare-table table").first().evaluate((t) => {
    const head = [...t.querySelectorAll("thead th")].map((th) => th.textContent.trim());
    return [...t.querySelectorAll("tbody tr")].map((tr) =>
      Object.fromEntries([...tr.querySelectorAll("th,td")].map((c, i) => [head[i] ?? i, c.textContent.trim()])));
  });
}

// --- LangGraph agents 탭 ------------------------------------------------------
async function agentsSetup(page, { live, mode, perspectives }) {
  await page.getByRole("tab", { name: "LangGraph agents" }).click();
  const side = page.locator(".side-slot");
  await side.locator("label:has-text('데이터 번호') input").waitFor({ timeout: TIMEOUT });
  await side.locator("label:has-text('데이터 번호') input").fill(opts.seed);
  const wanted = new Set(opts.faults.split(",").filter(Boolean));
  for (const box of await side.locator("fieldset label").all()) {
    const id = (await box.innerText()).trim().split(/\s+/)[0];
    await box.locator("input").setChecked(wanted.has(id));
  }
  await side.locator("label:has-text('처리할 건수') input").fill("10");
  await side.locator("label:has-text('하네스 레벨') select").selectOption(opts.to);
  const ai = side.locator("label:has-text('AI') select").first();
  if (live && await ai.isEnabled()) await ai.selectOption("claude");
  await side.locator("label:has-text('관점별 분석') input").setChecked(perspectives);
  await side.locator("label:has-text('저장된 제약 불러오기') input").setChecked(false);   // 테이크마다 같은 출발점
  await side.locator("label:has-text('Supervisor 지휘') input").setChecked(mode === "supervisor");
  await side.locator("label:has-text('종료 판정') select").selectOption("fixed");
  await side.locator("label:has-text('속도') select").selectOption("0.2");
  await page.getByRole("button", { name: /^(에이전트 준비|처음부터 다시)$/ }).click();
  await page.getByRole("button", { name: /다음 실행/ }).waitFor({ timeout: TIMEOUT });
}

// 단계 진행: 사람 단계는 review(page, n)로 넘기고, stop이 참이면 그 자리에서 멈춘다
// afterStep(page, 끝난 단계 이름): 단계가 끝날 때마다 (로그 다시 보기). stopAfter: 이 단계가 끝나면 멈춘다
async function agentsDrive(page, { review, stopAtReview = false, maxSteps = 60, afterStep = null, stopAfter = null }) {
  const bar = page.locator(".wf-bar");
  let reviews = 0;
  for (let i = 0; i < maxSteps; i++) {
    const status = (await bar.innerText()).trim();
    if (status.startsWith("✓ 끝")) return reviews;
    if (await page.getByRole("button", { name: "확정", exact: true }).count()) {      // 제약 확인 (사람)
      await page.locator(".wf-bar, .agent-confirm, .ag-confirm").first().scrollIntoViewIfNeeded().catch(() => undefined);
      await say(page, "제약 확인(사람): 정리된 제약을 확인하고 확정");
      await page.getByRole("button", { name: "확정", exact: true }).click();
    } else if (await page.getByRole("button", { name: "승인", exact: true }).count()) {   // 사람 검토
      if (stopAtReview) return reviews;
      await review(page, reviews++);
    } else {
      const next = page.getByRole("button", { name: /다음 실행/ });
      const label = status.replace(/^다음 단계:\s*/, "").split(/\n/)[0];
      const before = await page.locator(".agt-row:not(.agt-running)").count();
      await next.click();
      // 단계 하나가 끝나면 타임라인에 줄이 하나 늘고 "실행 중"이 사라진다
      await waiting(label, () => page.waitForFunction((n) => document.querySelectorAll(".agt-row:not(.agt-running)").length > n
        && !/실행 중/.test(document.querySelector(".wf-bar")?.textContent ?? ""), before, { timeout: AI_TIMEOUT }));
      const done = (await page.locator(".agt-row:not(.agt-running) .agt-name").last().innerText()).trim();
      if (afterStep) await afterStep(page, done);
      if (stopAfter && done === stopAfter) return reviews;
    }
    await page.waitForTimeout(600);
    const err = await text(page.locator(".wf-bar .critical-text, .run-bar .critical-text"));
    if (err) throw new Error(`단계 실패: ${err}`);
  }
  throw new Error("단계가 너무 많다 (흐름이 끝나지 않음)");
}

// 타임라인 줄 → [{time, kind, name, text, meta}]
async function timelineRows(page) {
  return page.locator(".agt-row").evaluateAll((rows) => rows.map((r) => ({
    kind: r.querySelector(".agt-kind")?.textContent.trim(), name: r.querySelector(".agt-name")?.textContent.trim(),
    text: r.querySelector(".agt-text")?.textContent.trim(), meta: r.querySelector(".agt-meta")?.textContent.trim() })));
}

const costOf = (rows) => {
  const vals = rows.map((r) => /\$([\d.]+)/.exec(r.meta ?? "")?.[1]).filter(Boolean).map(Number);
  return vals.length ? Number(vals.reduce((a, b) => a + b, 0).toFixed(4)) : null;
};

const scenes = {
  // 장면 1: 하네스 토글. 같은 지시서를 L0와 L3로 실행해 지도·비교표의 위반이 사라지는 모습
  async 1(page) {
    await openApp(page);
    await page.getByRole("tab", { name: "비교" }).click();
    await caption(page, `장면 1 · 하네스 레벨 ${opts.from} → ${opts.to}`);
    await generate(page);
    await pause(page, 1500);
    await caption(page, `${opts.from}: 업무 규칙 문서·조회 기능·자동 검사 없이 AI 방식 실행`);
    await runAi(page, opts.from);
    await page.locator(".compare .split").scrollIntoViewIfNeeded();
    await pause(page, 4000);
    await caption(page, `${opts.to}: 업무 규칙 문서 + 조회 기능 + 자동 검사 (규칙을 어기면 이유를 돌려주고 다시 시도)`);
    await runAi(page, opts.to);
    await pause(page, 4000);
    await caption(page, "레벨별 비교: 규칙 위반과 배정 성공률, 건당 비용");
    await page.locator(".compare-table").scrollIntoViewIfNeeded();
    await pause(page, 5000);
  },

  // 장면 2: 결정 과정(트레이스). 다시 시도한 지시서 하나의 AI 판단 과정과 규칙 방식 판단 비교
  // (단계 기록은 트레이스를 켠 레벨에만 있다: harness_levels.yaml의 trace)
  async 2(page) {
    await openApp(page);
    await caption(page, "장면 2 · 지시서 하나를 AI가 결정한 과정");
    await generate(page);
    await runAi(page, opts["trace-level"]);
    await page.getByRole("tab", { name: "결정 과정" }).click();
    const filters = page.getByRole("radiogroup", { name: "항목 필터" });
    await filters.waitFor({ timeout: TIMEOUT });
    const retried = filters.getByRole("radio", { name: /다시 시도한 건/ });
    if (!(await retried.innerText()).includes("(0)")) await retried.click();
    await pause(page, 1000);
    await page.getByRole("list", { name: "항목" }).getByRole("button").first().click();
    await page.locator(".trace .verdict").waitFor({ timeout: TIMEOUT });
    await caption(page, "결론 카드: AI 결정이 규칙 방식과 같은지, 몇 번 다시 시도했는지. 아래는 단계 흐름 한 줄");
    await pause(page, 3500);
    await page.locator(".trace details.more > summary").first().click();
    await caption(page, "상세보기: AI 응답 → 조회 → 자동 검사 → 다시 시도 단계별 기록");
    await pause(page, 3000);
    await page.locator(".trace").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.mouse.wheel(0, 500);
    await pause(page, 3000);
    await caption(page, "같은 지시서의 규칙 방식 판단과 나란히 비교");
    await page.getByText("규칙 방식", { exact: true }).first().scrollIntoViewIfNeeded();
    await pause(page, 4000);
  },

  // 장면 3: AI 분석이 심어둔 문제를 찾고, 개선 제안을 미리 돌려봐 배정 성공률이 오르는 모습
  async 3(page) {
    await openApp(page);
    await caption(page, "장면 3 · AI 분석과 개선 제안");
    await generate(page);
    await page.getByRole("tab", { name: "문제 찾기" }).click();
    await page.getByRole("button", { name: "규칙 방식 전체 실행" }).click();
    await page.locator(".side-slot select option").filter({ hasText: "전체" }).first().waitFor({ state: "attached", timeout: TIMEOUT });
    await page.getByRole("button", { name: "AI 분석 실행" }).click();
    await waiting("AI 분석", () => page.locator(".analysis .verdict").waitFor({ timeout: AI_TIMEOUT }));
    await caption(page, "결론 한 줄: 심어둔 문제를 몇 개 찾았는지 정답과 대조. 찾은 문제는 제목과 조건만 먼저 보인다");
    await pause(page, 3500);
    const first = page.locator(".finding-title").first();
    await first.click();
    await caption(page, "찾은 문제를 누르면 해당 조건의 지시서가 지도에 강조된다");
    await pause(page, 4000);

    await page.getByRole("tab", { name: "개선 제안" }).click();
    await page.getByRole("button", { name: "개선 제안 만들기" }).click();
    await waiting("개선 제안", () => page.locator(".proposal").first().waitFor({ timeout: AI_TIMEOUT }));
    const proposal = page.locator(".proposal-proposed").filter({ hasText: "규칙 설정값" }).first();
    if (!(await proposal.count())) {
      throw new Error("결정 전 규칙 설정값 개선 제안이 없음. 이미 승인했다면 시연 서버를 다시 시작하세요 (임시 사본 초기화)");
    }
    await caption(page, "개선 제안: 규칙 설정값 또는 업무 규칙 문서 수정 (바꿀 수 있는 범위 검사 포함)");
    await pause(page, 3000);
    await proposal.getByRole("button", { name: "미리 돌려보기", exact: true }).click();
    const simulated = page.locator(".proposal-simulated").first();
    await simulated.locator("p.gist:not(.muted)").waitFor({ timeout: TIMEOUT });
    await simulated.scrollIntoViewIfNeeded();
    await caption(page, "미리 돌려보기: 요약 한 줄로 핵심 지표 변화와 나빠진 지표를 먼저 보여준다");
    await pause(page, 3500);
    await simulated.locator("details.more > summary").first().click();
    await simulated.locator(".sim-table").waitFor({ timeout: TIMEOUT });
    await caption(page, "상세보기를 펼치면 근거, 바꿀 내용, 전·후 전체 지표");
    await pause(page, 4500);
    await simulated.getByRole("button", { name: "승인", exact: true }).click();
    await page.locator(".history").waitFor({ timeout: TIMEOUT });
    await page.locator(".history").scrollIntoViewIfNeeded();
    await caption(page, "승인하면 규칙 설정값 버전이 오르고 반영 이력에 남는다 (git 커밋은 사람이)");
    await pause(page, 5000);
  },

  // --- 시연 동영상 (v1~v6, 최종 제출용: 추론 로그 중심 · 5분 이내) -----------------
  // 로그(진행 기록)는 AI 대기 구간이 아닌 곳에서 1배속으로 짚는다(spot). 대기 구간만 후처리가 배속한다

  // v1 문제: 규칙 엔진이 전체를 배정한 결과
  async v1(page) {
    await openApp(page);
    await page.getByRole("tab", { name: "비교" }).click();
    await generate(page, "all");
    await page.getByRole("button", { name: /규칙 방식 실행/ }).click();
    const rule = page.getByText("규칙 방식", { exact: true }).locator("xpath=ancestor::article");
    await rule.locator("svg").first().waitFor({ timeout: TIMEOUT });
    const rate = (await rule.locator(".tile").filter({ hasText: "배정 성공률" }).locator(".tile-value").first().innerText()).trim();
    fact("rule_assignment_rate", rate);
    await say(page, `출동 배정(지점 3곳 · 작업자 30명 · 지시서 1,500건)은 규칙 엔진이 한다. 배정 성공 ${rate}`);
    await say(page, "실패 원인은 사람이 매번 찾는다 → AI 에이전트가 분석·개선을 맡고, 하네스가 그 출력을 검사한다");
  },

  // v2 배정에서의 하네스 (최소): 10건을 L5(규칙 문서·조회 도구·규칙 위반 검사·다시 시도·과정 기록)로 배정하고,
  // 결정 과정에서 한 건의 단계 흐름(AI 응답 → 조회 → 검사 → 다시 시도)만 짚는다
  async v2(page) {
    await openApp(page);
    await page.getByRole("tab", { name: "비교" }).click();
    await generate(page);
    await page.getByRole("button", { name: /규칙 방식 실행/ }).click();
    const to = opts["v2-to"];
    await caption(page, `같은 10건을 AI가 배정 (${to}): 규칙 문서 + 조회 도구 + 규칙 위반 검사·다시 시도. 도구 없는 AI(L0)는 규칙을 어긴다`);
    await runAi(page, to);
    fact("compare", await compareRows(page));
    await page.getByRole("tab", { name: "결정 과정" }).click();
    const filters = page.getByRole("radiogroup", { name: "항목 필터" });
    await filters.waitFor({ timeout: TIMEOUT });
    const retried = filters.getByRole("radio", { name: /다시 시도한 건/ });
    const count = Number(/\((\d+)\)/.exec(await retried.innerText())?.[1] ?? 0);
    fact("v2_retried_items", count);
    if (count > 0) await retried.click();
    await page.getByRole("list", { name: "항목" }).getByRole("button").first().click();
    await page.locator(".trace .verdict").waitFor({ timeout: TIMEOUT });
    await spot(page, page.locator(".trace .step-flow"), { key: "v2 단계 흐름", tag: count > 0 ? "fix" : "tool",
      say: count > 0 ? "규칙 위반 검사 탈락 → 사유를 받고 다시 결정 → 다시 검사 통과"
        : "AI 응답 → 조회 도구(get_order 등) → 규칙 위반 검사 통과 (이번 실행은 다시 시도 0건)" });
  },

  // v3 자가 개선 흐름 (고정 흐름, 1회차): 단계가 끝날 때마다 그 에이전트의 진행 기록을 1배속으로 짚는다
  async v3(page) {
    const live = await openApp(page);
    await agentsSetup(page, { live, mode: "fixed", perspectives: true });
    await caption(page, "LangGraph agents · 고정 흐름: AI는 판단·제안, 코드가 검사·계산, 사람이 승인 (단계가 끝날 때마다 로그를 다시 본다)");
    const log = page.locator(".event-log li");
    const replayed = new Set();   // 같은 에이전트는 처음 한 번만 짚는다 (다시 제안 때는 건너뜀)
    const replay = async (p, name) => {
      if (replayed.has(name)) return;
      // 타임라인 줄을 눌러 아래 진행 기록을 그 에이전트로 (이미 골라져 있으면 누르지 않는다: 누르면 선택이 풀림)
      const pick = async () => {
        replayed.add(name);
        const row = p.locator(".agt-row:not(.agt-running)", { hasText: name }).last();
        if (!(await row.evaluate((r) => r.classList.contains("agt-picked")))) await row.click();
        await p.waitForFunction((n) => [...document.querySelectorAll(".panel h2")].some((h) => h.textContent.startsWith("진행 기록")
          && h.textContent.includes(n)), name.replace(" 에이전트", ""), { timeout: 5000 }).catch(() => undefined);
        await p.waitForTimeout(400);
      };
      if (name === "분석 에이전트") {
        await pick();
        await spot(p, log.filter({ hasText: /도구 · .*→/ }), { key: "v3 분석 도구 호출", tag: "tool",
          say: (t) => `분석 에이전트(관점 3개 병렬)가 집계 도구 호출: ${cut(t.replace(/^.*도구 · /, ""))}` });
        const fail = await spot(p, log.filter({ hasText: "근거 검사 · ✕" }), { key: "v3 분석 근거 검사 탈락", tag: "fix",
          say: (t) => `근거 검사 탈락 → 고쳐서 다시 제출: ${cut(t.replace(/^.*근거 검사 · ✕ /, ""))}` });
        if (!fail) {
          await spot(p, log.filter({ hasText: /검사 · ✓|✓ 통과/ }), { key: "v3 분석 검사 통과", tag: "fix",
            say: "이번 실행은 첫 제출이 근거 검사를 통과" });
        }
      } else if (name === "개선 제안 에이전트") {
        await pick();
        const search = log.filter({ hasText: "search_knowledge" });
        await spot(p, (await search.count()) ? search : log.filter({ hasText: /시험 계산|simulate_params/ }), { key: "v3 개선 도구 호출", tag: "tool",
          say: (t) => (t.includes("search_knowledge") ? "개선 에이전트가 규정·과거 사례를 검색(search_knowledge)해 근거로 인용"
            : `설정값을 바꿔 미리 계산: ${cut(t)}`) });
        await spot(p, log.filter({ hasText: /바꿀 수 있는 범위 검사|✓ 통과/ }), { key: "v3 개선 범위 검사", tag: "fix",
          say: "코드가 개선안을 검사(바꿀 수 있는 범위·제약)한 뒤에만 사람에게 올린다" });
      } else if (name === "의견 정리 에이전트") {
        await pick();
        await spot(p, log.filter({ hasText: /✓ 통과|✕/ }), { key: "v3 의견 정리 검사", tag: "fix",
          say: "의견 정리 에이전트: 한 줄 의견 → 제약 형식 → 코드가 형식 검사" });
      }
    };
    await agentsDrive(page, {
      afterStep: replay, stopAfter: "종료 판정",
      review: async (p, n) => {
        await p.locator(".wf-bar").scrollIntoViewIfNeeded();
        if (n === 0) {
          await p.getByRole("textbox", { name: "메모 또는 의견" }).fill(opts.opinion);
          await say(p, `사람 검토(interrupt로 멈춤): 현장 의견 "${opts.opinion}" → 제약으로 정리한다`);
          await p.locator("button", { hasText: "의견 보내기" }).click();
        } else {
          await say(p, "제약을 지킨 새 제안을 사람이 승인 → 반영 → 재평가");
          await p.getByRole("button", { name: "승인", exact: true }).click();
        }
      },
    });
    const rows = await timelineRows(page);
    fact("timeline", rows);
    fact("cost_usd", costOf(rows));
    const re = rows.filter((r) => r.name === "재배정·재평가").map((r) => r.text);
    fact("reevaluate", re);
    await page.locator(".ag-timeline").scrollIntoViewIfNeeded();
    await say(page, `1회차 재평가 (이번 실행): ${cut((re[0] ?? "-").replace(/^.*\): /, ""), 40)} · 2회차는 같은 흐름(생략)`);
    await page.getByRole("button", { name: "기록 저장" }).click();
    await page.locator(".run-bar .good-text").waitFor({ timeout: TIMEOUT });
    fact("record", await text(page.locator(".run-bar .good-text")));
  },

  // v4 Supervisor (에이전트 탭): 다음 행동을 스스로 정하고(Planning), 에이전트·계산 도구를 부르고(Tool Call), 판단 보고서
  async v4(page) {
    await openApp(page);
    await page.getByRole("tab", { name: "에이전트", exact: true }).click();
    await page.locator(".agent-pick", { hasText: "Supervisor" }).first().click();
    const select = page.locator(".side-slot select").first();
    await select.waitFor({ timeout: TIMEOUT });
    await select.locator("option", { hasText: /P1·P2·P3·P4.*전체/ }).first().waitFor({ state: "attached", timeout: TIMEOUT })
      .catch(() => undefined);
    const want = await select.locator("option").evaluateAll((os) =>
      os.find((o) => /P1·P2·P3·P4/.test(o.textContent) && /전체/.test(o.textContent))?.value ?? null);
    if (!want) throw new Error("심어둔 문제 P1~P4 전체 규칙 실행이 없음 (v1을 먼저 녹화)");
    await select.selectOption(want);
    await page.locator(".side-slot label", { hasText: "저장된 제약 사용" }).locator("input").setChecked(false);
    await caption(page, "Supervisor: 분석·개선 에이전트와 계산 도구를 도구로 부르며 다음 행동을 스스로 정한다 (규칙은 바꾸지 않음)");
    await page.locator(".agent-run-bar button.primary", { hasText: "실행" }).click();
    const confirm = page.locator(".agent-confirm button.primary", { hasText: "실행" });
    if (await confirm.count()) await confirm.click();
    await waiting("Supervisor", () => page.locator(".judgment-card").waitFor({ timeout: 40 * 60_000 }));
    fact("summary", await text(page.locator(".agent-tab-main .panel").first()));
    // 로그 다시 보기 (1배속)
    const asks = page.locator(".agent-timeline .tl-msg.tl-ask");
    fact("asks", await asks.evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim())));
    await spot(page, asks.nth(0), { key: "v4 첫 계획", tag: "planning", say: (t) => `다음 행동을 스스로 정한다: ${cut(t.replace(/^\d+번째 /, ""))}` });
    const reply = page.locator(".agent-timeline .tl-msg.tl-reply");
    await spot(page, reply.filter({ hasText: "규칙 엔진" }).first(), { key: "v4 미리 돌려보기 보고", tag: "tool",
      say: (t) => `계산 도구(규칙 엔진)가 진단 신호로 보고: ${cut(t.replace(/^.*Supervisor /, ""), 50)}` });
    const re = asks.filter({ hasText: "분석 에이전트" }).nth(1);
    await spot(page, re, { key: "v4 재분석", tag: "planning",
      say: (t) => `결과를 보고 방향을 바꿔 다시 분석: ${cut(t.replace(/^.*run_analysis\(…\) /, ""), 50)}` });
    const card = page.locator(".judgment-card");
    await card.locator("details").first().evaluate((d) => { d.open = true; }).catch(() => undefined);
    await spot(page, card.locator("ol li").last(), { key: "v4 시도 기록(왜)", tag: "planning",
      say: (t) => `판단 보고서 · 무엇을 왜 했나: ${cut(t, 50)}` });
    await spot(page, card.locator(".judgment-ask"), { key: "v4 사람에게 묻는 것", tag: "planning",
      say: "득실이 큰 결정은 직접 고르지 않고 사람에게 묻는다 (반영은 사람 승인 뒤에만)" });
    fact("judgment", await text(card));
  },

  // v5 승인 전 고객 기준: 개선안 카드의 계획 vs 가상 실적 (규칙 엔진·실적 계산만, AI 호출 없음)
  async v5(page) {
    await openApp(page);
    await page.getByRole("tab", { name: "에이전트", exact: true }).click();
    await page.locator(".agent-pick", { hasText: "개선" }).first().click();
    const box = page.locator(".agent-history-box");
    await box.locator("summary").click();
    // 에이전트를 바꾼 직후에는 목록이 이전 에이전트 기록이다: 개선안 묶음(bat-…)으로 바뀐 뒤, 끝난 것 중 맨 위를 연다
    const done = box.locator(".agent-history li").filter({ has: page.locator("button", { hasText: /^bat-/ }) })
      .filter({ hasNotText: /(running|error|failed) · / });
    await done.first().waitFor({ timeout: TIMEOUT });
    await done.first().locator("button").click();
    await page.getByRole("button", { name: /개선 제안 탭에서 보기/ }).click({ timeout: TIMEOUT });
    await page.locator(".improvement .run-bar .status-line .muted").first().waitFor({ timeout: TIMEOUT });
    const folded = page.locator(".improvement details > summary", { hasText: "참고 (접음)" });
    if (!(await page.locator(".proposal:visible").count()) && await folded.count()) await folded.first().click();
    const first = page.locator(".proposal:visible").filter({ hasText: "규칙 설정값" }).first();
    await first.waitFor({ timeout: TIMEOUT });
    // 카드를 id로 붙잡는다: 미리 돌려보면 순위가 다시 매겨져 "참고 (접음)"으로 옮겨 갈 수 있다 → 그러면 펼쳐서 보인다
    const card = page.locator(`#${await first.getAttribute("id")}`);
    const sim = card.getByRole("button", { name: "미리 돌려보기", exact: true });
    if (await sim.count()) {
      await waiting("미리 돌려보기", async () => {
        await sim.click();
        // 결과가 나오거나(같은 자리), 순위가 바뀌어 카드가 사라진다(접힌 참고로 옮겨 감)
        await page.waitForFunction((sel) => !document.querySelector(sel) || document.querySelector(`${sel} .outcome-box table`),
          `#${await card.getAttribute("id")}`, { timeout: TIMEOUT });
      });
    }
    if (!(await card.count())) {
      const fold = page.locator(".improvement details > summary", { hasText: "참고 (접음)" });
      if (await fold.count()) await fold.first().click();
      await card.waitFor({ timeout: TIMEOUT });
    }
    const outcome = card.locator(".outcome-box");
    await outcome.locator("table").waitFor({ timeout: TIMEOUT });
    await outcome.scrollIntoViewIfNeeded();
    const rows = await outcome.locator("table tr").evaluateAll((trs) => trs.map((tr) => [...tr.children].map((c) => c.textContent.trim())));
    fact("outcome", rows);
    const row = (k) => rows.find((r) => r[0]?.includes(k));
    const change = ["계획 · 배정", "계획 · 정시 배정", "약속 준수", "불만율"].map(row).filter(Boolean)
      .map((r) => `${r[0].replace(/^(계획|실적) · /, "")} ${r[1]}→${r[2]}`).join(", ");
    await say(page, change ? `승인 전 고객 기준: ${change}. 가상 실적은 사람만 참고, AI에는 숨김`
      : "계획 대비 가상 실적: 사람만 참고하고 AI에는 숨긴다");
  },

  // v6 마무리: v3에서 저장한 기록을 다시 열어 결과 (AI 호출 없음)
  async v6(page) {
    await openApp(page);
    await page.getByRole("tab", { name: "LangGraph agents" }).click();
    await page.getByRole("button", { name: "기록 열기" }).click();
    const pick = page.getByRole("combobox", { name: "저장한 실행 기록" });
    await pick.waitFor({ timeout: TIMEOUT });
    // 가장 최근 기록 중 재고 도메인이 아닌 것 (이 레포에는 v7용 재고 기록이 같은 폴더에 있다)
    const ids = await pick.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    let value = null;
    for (const id of ids) {
      const domain = await page.evaluate(async (rid) => (await (await fetch(`/agents/records/${rid}`)).json()).inputs?.domain, id);
      if (domain !== "inventory") { value = id; break; }
    }
    if (!value) throw new Error("저장한 기록이 없음 (v3를 먼저 녹화)");
    await pick.selectOption(value);
    await page.getByRole("button", { name: "끝으로" }).click();
    await page.locator(".loop-panel").scrollIntoViewIfNeeded().catch(() => undefined);
    fact("record", value);
    const line = await text(page.locator(".loop-panel table tbody tr").first());
    fact("loop", line);
    const rate = /(\d+\.\d%\s*→\s*\d+\.\d%)/.exec(line ?? "")?.[1] ?? "-";
    await say(page, `이번 실행 1회차 ${rate} · 반영은 사람 승인 뒤에만`);
  },

  // v7 도메인 팩 확장 (M21, 이 레포): 같은 하네스에 두 번째 업무(단말 재고·구매)를 붙여 한 번 돌린 결과.
  // 규칙 실행(비용 없음) → 저장한 실제 AI 실행 기록 다시 열기(AI 호출 없음). 기록은 먼저 실제 AI로 한 번 돌려 저장해 둔다
  async v7(page) {
    await openApp(page);
    await page.locator("header select").first().selectOption("inventory");
    await page.getByRole("tab", { name: "비교" }).click();
    await say(page, "확장: 같은 하네스에 두 번째 업무 '단말 재고·구매'를 도메인 팩으로 추가");
    await generate(page, "W1");   // 1주차 전 지점: 표에 세 지점이 다 보인다 (지표는 그 지점×모델의 8주 전체)
    await page.getByRole("button", { name: /규칙 방식 실행/ }).click();
    const grid = page.locator(".inv-grid").first();
    await grid.waitFor({ timeout: TIMEOUT });
    const rate = (await page.locator(".tile").filter({ hasText: "결품률" }).locator(".tile-value").first().innerText()).trim();
    fact("rule_stockout_rate", rate);
    await spot(page, grid.locator("td.inv-cell").filter({ hasText: "18.5%" }), { key: "hot cell",
      say: `결과 화면만 도메인 전용(지점×모델 결품률 표) · 규칙 엔진 결품률 ${rate} · 빨간 칸 = 숨겨 둔 문제` });
    // 칸을 누르면 주차별 흐름 (수요·발주·결품·재고)
    await grid.locator("td.inv-cell").filter({ hasText: "18.5%" }).first().click();
    const chart = page.locator(".inv-chart").first();
    await chart.waitFor({ timeout: TIMEOUT });
    await chart.evaluate((n) => n.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(800);   // 막대 그리기 애니메이션
    await say(page, "주차별 흐름: 신규 모델 초반 수요 급증을 예측이 늦게 따라가 결품");
    await pause(page, 2000);   // 차트를 볼 시간
    // 발주 권고표: 사람이 최종 결정하는 도구
    const plan = page.locator(".inv-plan").first();
    await plan.locator("summary").click();
    await page.waitForTimeout(300);
    await spot(page, plan.locator("tr.constrained"), { key: "plan row",
      say: "발주 권고표(CSV): 부족물량·권고 발주량·걸린 제약 · 최종 발주는 사람이 결정" });
    await pause(page, 2000);   // 표를 볼 시간

    await page.getByRole("tab", { name: "LangGraph agents" }).click();
    await page.getByRole("button", { name: "기록 열기" }).click();
    const pick = page.getByRole("combobox", { name: "저장한 실행 기록" });
    await pick.waitFor({ timeout: TIMEOUT });
    // 저장한 기록 중 재고 도메인 것 (같은 테이크의 출동 기록 v3과 섞여 있다)
    const ids = await pick.locator("option").evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    let value = null;
    for (const id of ids) {
      const domain = await page.evaluate(async (rid) => (await (await fetch(`/agents/records/${rid}`)).json()).inputs?.domain, id);
      if (domain === "inventory") { value = id; break; }
    }
    if (!value) throw new Error("저장한 재고 도메인 기록이 없음 (재고 도메인 실제 AI 실행을 먼저 저장)");
    await pick.selectOption(value);
    await page.getByRole("button", { name: "끝으로" }).click();
    fact("record", value);
    const found = await spot(page, page.locator(".agt-row").filter({ hasText: "심어둔 문제" }),
      { key: "analysis", tag: "tool",
        say: (t) => `실제 AI 실행 기록 · 분석 에이전트: ${/심어둔 문제 \d+개 중 \d+개 찾음/.exec(t ?? "")?.[0] ?? cut(t, 30)}` });
    fact("analysis", found);
    await spot(page, page.locator(".agt-row").filter({ hasText: "승인" }), { key: "approved", tag: "planning",
      say: (t) => `사람이 승인한 개선안: ${cut(t.replace(/^.*승인\s*·?\s*/, "").replace(/\s*사람 대기\s*$/, ""), 40)}` });
    await page.locator(".loop-panel").scrollIntoViewIfNeeded().catch(() => undefined);
    const line = await text(page.locator(".loop-panel table tbody tr").first());
    fact("loop", line);
    const change = /(\d+\.\d%\s*→\s*\d+\.\d%)/.exec(line ?? "")?.[1] ?? "-";
    await say(page, `승인한 규칙 설정값으로 240건 다시 발주: 결품률 ${change} · 규칙 위반 0건`);
    await say(page, "업무 지식은 도메인 팩(domains/inventory)과 화면 어댑터에만 추가");
    await say(page, "공통 하네스는 몇 줄만 보탬 · 기존 출동 업무는 그대로 동작");
    await pause(page, 1500);   // 마지막 자막이 바로 끊기지 않게
  },
};

async function record(browser, id) {
  const dir = join(opts.out, `.tmp-${id}`);
  const size = { width: Number(opts.width), height: Number(opts.height) };
  scene = { id, started: Date.now(), marks: [], facts: {} };   // 영상은 컨텍스트를 만들 때 시작한다: 대기 구간 시각의 기준
  const context = await browser.newContext({ viewport: size, recordVideo: { dir, size } });
  const page = await context.newPage();
  still = { scene: id, n: 0 };
  let error = null;
  try {
    await scenes[id](page);
    await saveStill(page);
  } catch (e) {
    error = String(e?.message ?? e);
    await page.screenshot({ path: join(opts.out, `scene-${id}-error.png`) }).catch(() => undefined);
  } finally {
    await context.close();                    // 여기서 영상이 기록된다
  }
  const target = join(opts.out, `scene-${id}.webm`);
  renameSync(await page.video().path(), target);
  rmSync(dir, { recursive: true, force: true });
  const seconds = Number(((Date.now() - scene.started) / 1000).toFixed(1));
  writeFileSync(join(opts.out, `scene-${id}.marks.json`), JSON.stringify({ scene: id, seconds, marks: scene.marks }, null, 1));
  console.log(`장면 ${id}: ${target} (${seconds}초, AI 대기 구간 ${scene.marks.length}개)${error ? ` ✕ ${error}` : ""}`);
  return { id, seconds, waits: scene.marks.length, wait_seconds: Number(scene.marks.reduce((a, m) => a + m.end - m.start, 0).toFixed(1)),
    facts: scene.facts, error };
}

// 테이크 기록: 장면마다 화면에서 읽은 핵심 수치·비용·시간 (자막 문구 확정용). 같은 테이크 이름이면 장면을 덮어쓴다
function saveTake(results) {
  const path = join(opts.out, "takes.json");
  const takes = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : [];
  let take = takes.find((t) => t.take === opts.take);
  if (!take) takes.push(take = { take: opts.take, url: opts.url, live: opts.allowLive, started: new Date().toISOString(), scenes: {} });
  for (const r of results) take.scenes[r.id] = r;
  const costs = Object.values(take.scenes).map((s) => s.facts?.cost_usd).filter((c) => typeof c === "number");
  take.cost_usd = costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(4)) : null;
  writeFileSync(path, JSON.stringify(takes, null, 1));
  console.log(`테이크 ${opts.take}: ${path}${take.cost_usd != null ? ` · AI 비용(타임라인 합, 추정) $${take.cost_usd}` : ""}`);
}

// 시연 장면은 상태를 바꾸지 않는 장면부터 녹화한다: v3이 승인(규칙 버전↑)·제약 저장을 하므로 v5(개선안 카드)를 먼저,
// v6(v3의 기록 열기)은 v3 뒤에. 영상은 후처리가 v1~v6 순서로 잇는다
const SAFE_ORDER = ["v1", "v2", "v5", "v4", "v3", "v6", "v7"];
const asked = opts.scenes.split(",").filter(Boolean);
const ids = [...asked.filter((id) => !SAFE_ORDER.includes(id)), ...SAFE_ORDER.filter((id) => asked.includes(id))];
for (const id of ids) if (!scenes[id]) throw new Error(`없는 장면: ${id} (1, 2, 3, v1~v7)`);
mkdirSync(opts.out, { recursive: true });
const browser = await chromium.launch({ headless: !opts.headed });
const results = [];
try {
  for (const id of ids) results.push(await record(browser, id));
} finally {
  await browser.close();
  if (ids.some((id) => id.startsWith("v"))) saveTake(results);
}
if (results.some((r) => r.error)) process.exitCode = 1;

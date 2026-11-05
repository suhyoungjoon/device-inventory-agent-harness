# device-inventory-agent-harness

> [optimization-agent-harness](https://github.com/suhyoungjoon/optimization-agent-harness)에서 갈라져 **단말 재고부족·구매예측 도메인**(`domains/inventory/`)을 추가한 레포다. 같은 하네스에 출동(`dispatch`)과 단말 재고(`inventory`) 두 도메인이 함께 돈다(M21). 하네스 쪽 변경은 `docs/m21-core-changes.md`에 기록한다.

같은 최적화 문제를 **규칙 기반 agent**(기준선)와 **LLM agent**로 나란히 풀고, LLM agent를 하네스 레벨(L0~L5)별로 쌓아 비교한다.
그 결과를 **분석 agent**가 읽어 실패 패턴을 찾고, **개선 루프**가 파라미터·명세 개선안을 제안하면 시뮬레이션으로 확인한 뒤 사람이 승인한다.

- 핵심 메시지: "AI가 규칙보다 낫다"가 아니라 "같은 모델도 하네스 설계에 따라 결과가 이만큼 달라진다".
- 역할 분담: 규칙이 명확한 반복 실행은 규칙 엔진이 싸고 빠르다. AI는 규칙을 분석·개선하는 시행착오에서 유리하다 ([AI 적용 경계](docs/ai-application-boundary.md)).
- 첫 도메인은 출동 스케줄링(`dispatch`)이며 가상 데이터만 쓴다. 지역은 서울 강남3구(서초·강남·송파 지점)로, 실제 구 경계 안에 지시서와 작업자를 만든다. 데이터에 문제 패턴(P1~P4)을 심어 두고, 분석 agent의 탐지율을 정답표로 채점한다.

전체 기획은 [docs/plan.md](docs/plan.md), 화면 사용법은 [docs/ui-guide.md](docs/ui-guide.md), 새 도메인 추가는 [docs/domain-pack-guide.md](docs/domain-pack-guide.md).
분석·개선 루프가 도는 방식은 [docs/improvement-loop.md](docs/improvement-loop.md) (쉬운 설명: [docs/improvement-loop-easy.md](docs/improvement-loop-easy.md)).
실제 API로 하네스 레벨별 배정을 비교하고 분석·개선 루프를 돌린 결과와 시사점은 [docs/experiment-real-api-2026-10.md](docs/experiment-real-api-2026-10.md).
다른 레포에서 코어를 패키지로 설치해 재사용하려면 [docs/handoff.md](docs/handoff.md)와 [examples/reuse_quickstart.py](examples/reuse_quickstart.py).

## 화면

자세한 사용법과 캡처는 [화면 매뉴얼](docs/ui-guide.md). 화면은 쉬운 말을 쓰고 원래 용어는 마우스를 올리면 보인다(대응표: [화면 매뉴얼 11. 용어표](docs/ui-guide.md#11-용어표)). 모든 탭은 요약(예: 비교 탭은 규칙 위반·배정 성공률·건당 비용, 문제 찾기는 찾은 개수, 결정 과정은 결론 카드)을 먼저 보여주고 나머지는 **상세보기**로 펼친다(오른쪽 위 **모두 펼치기**로 한 번에).

| 탭 (원래 이름) | 내용 |
|---|---|
| 규칙·데이터 (도메인) | 규칙 방식이 쓰는 규칙과 데이터 조회 (읽기 전용): 규칙 설정값(값·바꿀 수 있는 범위·설명), 지켜야 할 규칙·미배정 사유·분석 조건, 업무 규칙 문서, 데이터 표와 지도, 심어둔 문제(정답 가림) |
| 비교 | 데이터 생성(데이터 번호, 심어둔 문제) → 규칙 방식과 AI 방식(하네스 레벨 선택, 반복) 실행 → 지도(강남3구, 인터넷이 되면 OpenStreetMap 배경)·지표·레벨별 비교표 |
| 결정 과정 (트레이스) | AI 방식이 지시서 하나를 결정한 과정(AI 응답, 조회, 자동 검사, 다시 시도, 위험 결정 막기)과 같은 지시서의 규칙 방식 판단 |
| 문제 찾기 (분석) | AI 분석 결과: 찾은 문제마다 근거 데이터, 정답 대조로 찾아낸 비율, 정답에 없는 문제의 사람 확인(맞는 문제/잘못 짚음) |
| 개선 제안 (개선) | 규칙 설정값 안에는 **실적 (가상 고객 반응)** 표: 계획 대 실적(약속 준수·불만·취소·미처리·이월)을 현재 대비로, 계획과 달라진 이유 3가지 (M17, 참고용·AI에게 숨김). 개선 제안(규칙 설정값 변경, 특정 조건에만 적용, 업무 규칙 문서 수정) → 미리 돌려보기로 전후 비교 → 승인·반려, 반영 이력 |
| 에이전트 | 배정·분석·개선·의견 정리 에이전트를 **하나씩** 실행(실행 전 제공사·모델·호출 상한 확인)하고, 요약(입력 → 출력, 모델, 호출·토큰·시간)·내부 그래프·**턴별 타임라인**(AI 응답 → 도구 → 하네스 검사)을 한 화면에서. 실행 중에 한 줄씩 쌓이고, 끝난 실행은 목록에서 다시 본다 (M16) |
| Agent workflow (Langgraph version) | 위 단계를 LangGraph 그래프 하나로 묶어 한 단계(에이전트)씩 실행. 단계마다 멈추고 사람이 [다음 실행]·[승인]으로 진행. 노드 추가로 확장 ([docs/workflow.md](docs/workflow.md), 선택 설치 `.[workflow]`) |
| LangGraph agents | 배정·분석·개선 제안 에이전트의 **내부까지** LangGraph 하위 그래프로. 하네스 레벨이 배정 에이전트 그래프 모양을 정하고, 에이전트 내부 진행(AI 응답·조회·자동 검사·다시 시도)이 실시간으로 보인다. 가짜 AI 또는 Claude API ([docs/langgraph-agents.md](docs/langgraph-agents.md)) |

## 하네스 레벨

`configs/harness_levels.yaml`의 플래그로만 정한다.

| 레벨 | 명세 | 도구 | 검증 루프 | 가드레일 | 트레이스 |
|---|---|---|---|---|---|
| L0 | – | – | – | – | 최종 결과 |
| L1 | ✓ | – | – | – | 최종 결과 |
| L2 | ✓ | ✓ | – | – | 최종 결과 |
| L3 | ✓ | ✓ | ✓ | – | 최종 결과 |
| L4 | ✓ | ✓ | ✓ | ✓ | 최종 결과 |
| L5 | ✓ | ✓ | ✓ | ✓ | 모든 단계 |

필수조건 위반은 레벨과 관계없이 도메인의 `validate()` 하나로 사후 채점한다.
레벨별 처리 흐름(입력 → LLM 호출 → 결정 제출 → 검증·재시도 → 가드레일 → 기록)은 비교 탭 하네스 줄의 **하네스 설명**에서 그림으로 볼 수 있다.

## 시작하기

Python 3.11+, Node 20+, Git. 레포가 비공개라 클론하려면 GitHub 인증(`gh auth login` 또는 SSH 키)이 필요하다.

macOS / Linux:

```bash
git clone https://github.com/suhyoungjoon/optimization-agent-harness.git
cd optimization-agent-harness
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev,workflow]"   # workflow: Agent workflow 탭 (LangGraph, 선택)
pytest                                  # 테스트 (LLM 호출 없음)
(cd web && npm ci && npm run build)     # 프런트엔드 빌드 → web/dist
python -m api.main                      # http://127.0.0.1:8000 (API + 화면)
```

Windows (PowerShell):

```powershell
winget install Python.Python.3.11 OpenJS.NodeJS.LTS Git.Git GitHub.cli   # 없는 것만. 설치 후 새 터미널
gh auth login                                          # 비공개 레포 접근
git clone https://github.com/suhyoungjoon/optimization-agent-harness.git
cd optimization-agent-harness
py -3.11 -m venv .venv
.venv\Scripts\Activate.ps1                              # 막히면: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -e ".[dev,workflow]"
pytest
cd web; npm ci; npm run build; cd ..
python -m api.main                                     # http://127.0.0.1:8000
```

환경변수는 PowerShell에서 `$env:LLM_CACHE="0"`, `$env:PORT="8080"`처럼 설정한다. 서버는 `Ctrl+C`로 끈다. 이후 명령은 macOS와 같다(`python -m ...`). `(cd web && ...)` 형태만 PowerShell에서는 `cd web; ...; cd ..`로 바꾼다.

프런트엔드를 고치는 중이면 `python -m api.main`을 띄운 채 `(cd web && npm run dev)` 후 http://localhost:5173 (API 요청은 :8000으로 프록시).

API 키가 없으면 비교 탭의 데이터 생성·규칙 방식까지만 동작한다(AI 방식·문제 찾기·개선 제안은 LLM이 필요).

### API 키 없이 전체 흐름 보기 (리허설 번들)

가짜 LLM으로 결과를 미리 만든 시연 번들을 시연 모드로 연다. 비교(L0·L3·L5), 트레이스, 분석, 개선까지 화면 전체를 네트워크 없이 돌려 볼 수 있다. 수치는 AI 성능과 무관하다(흐름·화면 확인용).

```bash
python -m scripts.rehearsal_bundle            # → demo/rehearsal
python -m api.main --demo demo/rehearsal      # http://127.0.0.1:8000
```

화면에서 심어둔 문제 P1~P4를 모두 켜고 데이터 번호 42로 데이터를 생성한 뒤, 처리할 건수를 **1일차 앞 10건(시범)**으로 두고 AI 방식을 L0·L3·L5로 실행한다. 문제 찾기 탭은 **규칙 방식 전체 실행** 후 **AI 분석 실행**. 승인은 작업 복사본에만 반영되므로 서버를 다시 시작하면 처음 상태로 돌아간다.

### AI agent 실행

**기본 제공사는 회사 Azure OpenAI 호환 게이트웨이(`azure_openai`)다** (2026-10-18). `.env.example`을 `.env`로 복사하고 `MY_PROJECT_AZURE_API_KEY`를 채운다(`.env`는 커밋하지 않는다). 에이전트는 Anthropic 형식 메시지를 만들고, `core/llm/azure_openai.py`가 OpenAI 형식으로 바꾼다.

```bash
pip install -e ".[dev,workflow]"     # openai 패키지는 기본 의존성
# .env에 MY_PROJECT_AZURE_API_KEY (endpoint·api-version은 configs/llm.yaml, 환경변수로 덮을 수 있음)
python -m api.main
```

- 모델·역할별 모델(배정 gpt-4.1-mini, 분석 gpt-5, 개선안 gpt-5.4)·deployment 대응표·모델별 옵션(`reasoning_effort` 지원 값)은 `configs/llm.yaml`의 `azure` 섹션에 있다.
- 단가는 **OpenAI 공개 정가 추정치**다(회사 단가 아님, gpt-5.4는 gpt-5와 같다고 가정). 화면의 금액 뒤에 "(추정)"이 붙고, 표에 없는 모델은 비용이 "미확인"으로 나온다. 실행 기록의 사용량(`usage`)에 `provider`, `deployment`, `cost_estimated`가 남는다.
- 같은 입력은 캐시에서 재사용하므로 반복 개발 비용이 줄어든다. 최종 측정 때는 `LLM_CACHE=0`으로 끈다.

#### Claude(Anthropic)로 실행

```bash
pip install -e ".[dev,workflow,anthropic]"       # anthropic은 선택 설치
# .env에 ANTHROPIC_API_KEY (또는 OAH_ANTHROPIC_API_KEY)와 LLM_PROVIDER=anthropic
python -m api.main
```

Claude 설정은 `configs/llm.yaml` 최상위 값이다(배정 `claude-haiku-4-5`, 분석·개선안은 `roles`). Haiku 4.5는 adaptive thinking과 effort를 지원하지 않아 `thinking: "off"`, `effort: null`로 둔다.

개선 루프 기준은 설정 파일에 있다 (M15): 개선안 제시 기준(본안 최대 개수, 발견당 개수, 최소 효과)은 `configs/proposals.yaml`, LangGraph agents 탭의 회차 순환(최대 회차, 다시 제안 횟수, 종료 판정 `fixed | supervisor`)은 `configs/workflow.yaml`, 핵심 지표·방향·목표는 도메인 `dimensions.yaml`의 `metrics`. 문서 검색(가상 규정·과거 사례·현장 의견)은 임베딩이 있으면 벡터 + 키워드, 없으면 키워드만 쓴다. 임베딩은 `configs/llm.yaml`의 `embedding`(기본 auto: Azure 제공사면 `text-embedding-3-small`)이고 `EMBEDDING_PROVIDER`(auto | azure_openai | none), `EMBEDDING_MODEL`로 덮어쓴다. 색인은 `runs/retrieval.sqlite` ([docs/knowledge-retrieval.md](docs/knowledge-retrieval.md)).

M15 기능을 실제 API로 확인하는 실험은 스크립트 하나로 돌린다. 결과는 `runs/m15_eval/<시각>/summary.md`(표)와 `results.json`이다. 작업 폴더를 따로 써서 레포의 `params.yaml`은 바뀌지 않는다.

```bash
LLM_PROVIDER=azure_openai LLM_CACHE=0 python -m scripts.m15_eval all --repeats 3 --max-usd 3
python -m scripts.m15_eval all --fake      # 키 없이 흐름만 (가짜 AI)
```

M18 분석·개선 Supervisor(LangGraph agents 탭 **Supervisor 지휘**, 에이전트 탭 **Supervisor**)는 고정 흐름과 같은 데이터로 비교한다. 시나리오 S1 정상, S2 분석이 놓침(첫 분석만 gpt-4.1-mini), S3 득실 충돌(정시 배정 감소 한도 1%p). 사람 승인 없이 각 방식이 첫 번째로 내미는 안을 규칙 엔진으로 미리 돌려 비교하고, 규칙 파일은 바꾸지 않는다. 결과는 `runs/m18_eval/<시각>/summary.md`.

```bash
LLM_CACHE=0 python -m scripts.m18_eval all --repeats 3 --max-usd 15
python -m scripts.m18_eval all --fake      # 키 없이 흐름만 (가짜 AI, 비용 0)
```

비용 때문에 AI는 실행 범위를 **1일차 앞 10건(시범)**부터 돌려 건당 비용을 확인한 뒤 넓힌다. 규칙 agent는 비용이 없으니 전체로 돌린다.

실행 결과는 `runs/harness.db`(SQLite)에 쌓인다. `runs/`는 커밋하지 않는다.

## 시연 모드 (네트워크 없이)

발표용이다. 저장된 실행 결과를 번들로 묶고, LLM을 부르지 않고 같은 흐름을 재생한다.

```bash
# 1. 실제 실험을 마친 DB에서 번들 만들기
#    params.yaml·domain-spec.md는 커밋된 버전(git HEAD)을 넣는다. 개선안 승인·사람 판정은 결정 전 상태로 되돌린다.
python -m scripts.snapshot export --out demo/bundle --note "1일차 L0·L3·L5"

# 2. 시연 모드로 열기
python -m api.main --demo demo/bundle
```

- AI 실행, 분석, 개선안 생성, 명세 시뮬레이션은 같은 조건(데이터셋, 레벨, 실행 범위)의 저장 결과를 진행률과 함께 재생한다. 저장되지 않은 조건이면 안내 메시지를 띄운다. 재생 가능한 조건은 화면 상단 배너에 나온다.
- 규칙 agent와 params 시뮬레이션은 실제로 계산한다.
- 승인은 `runs/demo-<시각>/` 작업 복사본에만 반영된다. 서버를 다시 시작하면 처음 상태로 돌아간다.
- 시연 모드가 아니어도 API 요청에 `"cached": true`를 주면 저장 결과를 재생한다.

### 시연 녹화 (사전 녹화 백업)

시연 모드 서버를 띄운 상태에서 plan.md 13장의 장면 세 개를 Playwright로 녹화한다.

```bash
(cd web && npm ci && npx playwright install chromium)   # 처음 한 번
node scripts/record_demo.mjs --out runs/recordings --stills
```

| 장면 | 내용 | 번들에 필요한 실행 |
|---|---|---|
| 1 | 하네스 토글 L0 → L3: 지도·비교표에서 위반이 사라짐 | `--from`, `--to` 레벨의 AI 실행 (`--scope` 범위) |
| 2 | 재시도가 있었던 항목 하나의 트레이스와 규칙 agent 판단 비교 | `--trace-level`(기본 L5) AI 실행 |
| 3 | 분석 agent 탐지 → 개선안 시뮬레이션 → 승인, 개선 이력 | 규칙 agent 전체 실행의 분석 리포트, 개선안 |

장면마다 `scene-N.webm`이 생긴다(`--stills`면 단계별 png도). 기본값은 `--seed 42 --faults P1,P2,P3,P4 --scope D01-10`이며, 번들을 만든 실험 조건과 맞춰야 한다. 장면 3은 개선안을 승인하므로, 다시 녹화하려면 시연 서버를 재시작한다. 시연 모드가 아닌 서버에는 `--allow-live` 없이 녹화하지 않는다(실제 LLM 비용이 든다).

## 구조

```
core/            도메인을 모르는 공통 코어
  interfaces.py    DomainPack 계약, 표준 레코드
  harness/         L0~L5 러너, 검증 루프, 가드레일, 트레이서
  llm/             LLM 클라이언트 (Anthropic·Azure, 입력 해시 캐시, 사용량·비용 집계), 임베딩 클라이언트
  retrieval/       문서 검색 (BM25 + 벡터 혼합, 인용 검사)
  evaluation/      규칙·AI 실행, 레벨별 비교, 정답표 채점
  analysis/        분석 agent, 범용 집계 도구, 근거 검사
  improvement/     개선안 제안·순위, 시뮬레이션, 승인(params.yaml·domain-spec.md 반영), 회차 종료 판정·결과 보고
  storage/         SQLite 저장소
domains/dispatch/ 출동 스케줄링 도메인 팩 (생성기, 규칙 엔진, 도구, 명세, 파라미터, 정답표, 가상 규정 knowledge/)
configs/         하네스 레벨, LLM·임베딩 설정, 개선안 제시 기준, 개선 루프
api/             FastAPI (시연 재생 포함)
workflow/        LangGraph 워크플로우 (화면 단계를 그래프 하나로, 선택 설치)
  agents/          모든 에이전트를 LangGraph 하위 그래프로 (LangGraph agents 탭)
web/             React + Vite 프런트엔드 (도메인별 결과 화면은 web/src/domains/)
scripts/         데이터 생성, 시연 번들, 시연 녹화
examples/        코어 재사용 예제 (설치된 패키지로 실행)
tests/           계약 테스트, 코어·도메인 테스트 (가짜 LLM)
docs/            기획서, AI 적용 경계, 도메인 팩 가이드
```

## 원칙

- 코어는 도메인을 모른다. 새 도메인은 `domains/` 아래 폴더 하나와 프런트엔드 어댑터 하나로 붙는다.
- 규칙과 수치는 코드가 아니라 파일(`params.yaml`, `domain-spec.md`)에 있고, 개선 루프는 허용 범위 안에서만 파일을 바꾼다.
- 제약 위반 판정은 `validate()` 한 곳에서만 한다.
- 모든 실행은 seed·파라미터 버전·레벨·모델이 기록되어 재현할 수 있다.
- 승인된 변경은 앱이 파일에만 반영하고, git 커밋은 사람이 한다.

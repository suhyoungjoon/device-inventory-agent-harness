# device-inventory-agent-harness (optimization-agent-harness에서 갈라짐)

규칙 기반 최적화 agent를 기준선으로 두고, 같은 문제를 푸는 LLM agent를 하네스 엔지니어링 레벨(L0~L5)별로 구현·비교한 뒤,
결과 분석 agent와 개선 루프(제안 → 시뮬레이션 → 사람 승인)까지 수행하는 범용 프레임워크.
첫 도메인은 출동 스케줄링(dispatch), 두 번째 도메인은 단말 재고부족·구매예측(inventory, M21: 지점×모델×주차 발주 결정, 수요 예측은 규칙 계산이고 AI는 예측·발주 규칙 파라미터를 분석·개선)이며, 가상 데이터만 사용한다. 코어 변경은 `docs/m21-core-changes.md`에 이유·줄 수를 남긴다. 전체 기획은 `docs/plan.md` 참고.

## 핵심 원칙 (반드시 지킬 것)

1. **코어는 도메인을 모른다.** `core/` 안에 작업자, 지시서, 지점 같은 dispatch 용어가 나오면 안 된다. 도메인 접근은 `core/interfaces.py`의 `DomainPack`을 통해서만 한다.
2. **규칙·파라미터·프롬프트는 파일로 분리한다.** 가중치, 매칭 범위, 기준값을 코드에 하드코딩하지 말고 `params.yaml`, `domain-spec.md`에서 읽는다.
3. **필수조건 판정은 항상 `DomainPack.validate()`가 한다.** LLM의 자체 판단으로 위반 여부를 결정하지 않는다.
4. **모든 실행은 재현 가능해야 한다.** seed, 데이터셋 ID, 하네스 레벨, 모델명, params 버전을 run 메타데이터로 저장한다. 분석·개선 에이전트가 이전 회차의 기억(사람의 판단)을 읽으면 쓴 기억(항목과 해시)도 리포트·개선안 묶음에 저장한다.
5. **하네스 레벨은 코드 분기가 아니라 `configs/harness_levels.yaml` 플래그로 제어한다.**
6. **처음부터 과하게 범용화하지 않는다.** 현재 마일스톤에 필요한 것만 만든다. 두 번째 도메인이 요구할 때 인터페이스를 넓힌다.

## 인터페이스 변경 규칙

`core/interfaces.py`는 두 개발자가 병렬 작업하기 위한 계약이다.
- 필드 **추가**는 가능하되, 변경 사실을 작업 요약에 명시한다.
- 필드 **이름 변경·삭제·타입 변경**은 하지 말고, 필요하면 먼저 제안하고 확인을 받는다.

## 디렉터리 구조

```
core/            공통 코어 (interfaces, harness, llm, evaluation, analysis, improvement, storage)
domains/dispatch 출동 스케줄링 도메인 팩 (generator, rule_engine, tools, metrics, *.yaml, domain-spec.md)
domains/inventory 단말 재고·구매 도메인 팩 (M21)
configs/         harness_levels.yaml, llm.yaml, sweep.yaml, proposals.yaml, workflow.yaml
api/             FastAPI
web/             React + Vite 프런트엔드
scripts/         데이터 생성, 일괄 실행 CLI
tests/           pytest
docs/            plan.md(기획서), ai-application-boundary.md(AI 적용 경계), domain-pack-guide.md
runs/            실행 결과 (git 제외)
```

## 하네스 레벨

| 레벨 | 추가 계층 | 동작 |
|---|---|---|
| L0 | 없음 | 인스턴스 데이터를 통째로 프롬프트에 넣고 결정 요청 |
| L1 | 컨텍스트 | domain-spec.md를 시스템 프롬프트에 주입 |
| L2 | 도구 | 데이터는 도구로만 조회 |
| L3 | 검증 루프 | validate() 위반 시 사유를 돌려주고 재시도 (max_retries) |
| L4 | 가드레일 | 위반 차단, 승인 조건은 pending_approval |
| L5 | 관측성 | 모든 LLM·도구·검증 단계를 TraceRecord로 기록 |

L0~L4에서도 최종 결정에 대한 validate()는 사후 채점용으로 항상 실행하되, 결과에는 반영하지 않는다.

## 기술 스택

Python 3.11+, FastAPI, Pydantic, SQLite, PyYAML, pytest / React + Vite + TypeScript, Recharts / LLM은 상용 API tool use (`core/llm/client.py`에서만 호출).

## 개발 규칙

- API 키는 `.env`에서 읽는다. `.env`, `runs/`는 커밋하지 않는다.
- LLM 호출은 `core/llm/client.py`만 사용한다. 개발 중에는 입력 해시 기반 캐시를 켠다.
- LLM이 없는 부분(generator, rule_engine, validate, 집계, 채점)은 테스트를 먼저 작성한다.
- LLM이 들어가는 부분은 mock 응답으로 흐름(재시도, 차단, 승인 대기)을 테스트한다.
- 새 도메인 팩은 `tests/test_domain_contract.py`의 계약 테스트를 통과해야 한다.
- 커밋은 작은 단위로, 메시지는 `[M1] core: add DecisionRecord` 형식.

## 명령어

```bash
pip install -e ".[dev]"          # 설치
pytest                           # 테스트
python -m scripts.generate --domain dispatch --seed 42 --faults P1,P2   # 데이터 생성
python -m scripts.generate --domain inventory --seed 42   # 단말 재고 데이터 생성 (M21, 240건)
(cd web && npm ci && npm run build)   # 프런트엔드 빌드 (web/dist)
python -m api.main               # API + 빌드된 프런트엔드 서빙 (http://127.0.0.1:8000)
(cd web && npm run dev)          # 프런트엔드 개발 서버 (API는 :8000으로 프록시)
python -m scripts.snapshot export --out demo/bundle --note "..."   # 시연 번들 (runs/harness.db + 커밋된 도메인 파일, --agents-flows runs/agents_flows면 LangGraph agents 실행 기록도)
python -m api.main --demo demo/bundle   # 시연 모드: 저장된 AI 결과만 재생, LLM·네트워크 없음
python -m scripts.rehearsal_bundle      # API 키 없이 쓰는 리허설 번들 (가짜 LLM) → demo/rehearsal
node scripts/record_demo.mjs --stills   # 시연 장면 녹화 (시연 모드 서버에 대해, runs/recordings)
python -m scripts.demo_take check|reset  # 시연 동영상 테이크 점검·초기화 (규칙 파일 되돌리기 + 녹화용 DB runs/recordings/rec 새로 복사, 녹화 서버 명령 출력)
node scripts/record_demo.mjs --url http://127.0.0.1:8010 --allow-live --scenes v1,v2,v3,v4,v5,v6 --take t1   # 시연 동영상 장면 (실제 AI, 비용)
python -m scripts.make_demo_video --take t1 --out 사번_성명_시연영상.mp4   # 후처리: AI 대기 구간만 배속(짧은 대기 --speed, 1분 넘으면 --long-speed 범위) + 제목 카드·태그 범례 → runs/recordings/, 제출 기준(5분·500MB·1080p) 점검 (ffmpeg)
node scripts/record_demo.mjs --url http://127.0.0.1:8004 --allow-live --scenes v7 --take inv3 --stills   # M21 장면 v7 단말 재고 확장 (규칙 실행 + 저장한 실제 AI 기록 재생, AI 호출 없음. 기록은 LangGraph agents 탭에서 실제 AI로 한 번 돌려 저장)
python -m scripts.make_demo_video --dir ../optimization-agent-harness/runs/recordings --take final2 --speed 4 --long-speed 6-12 --long-target 25 --scenes v1,v2,v3,v4,v6,v7 --scene-dir v7=runs/recordings --scene-long-speed v2=12-12 --scene-long-speed v4=25-25 --scene-caption "v6=이번 실행 1회차 69.3% → 70.5% · 반영은 사람 승인 뒤에만" --work runs/recordings/combined --title "출동 배정 최적화 · 하네스 기반 AI 에이전트 시연 (+ 단말 재고 확장)" --out 04272_서영준_시연영상_재고확장.mp4   # 기존 영상(v5 빼고, v2 12배속·v4 25배속, v6 자막에서 v5 실적 언급 지움) + v7, 기존 레포 녹화 폴더는 읽기만
python -m scripts.make_demo_video --dir runs/recordings --take new1 --speed 4 --long-speed 6-12 --long-target 25 --scenes v1,v2,v3,v4,v6,v7 --scene-long-speed v2=12-12 --scene-long-speed v3=16-16 --scene-long-speed v4=36-36 --work runs/recordings/combined --title "출동 배정 최적화 · 하네스 기반 AI 에이전트 시연 (+ 단말 재고 확장)" --out 04272_서영준_시연영상_재고확장_v2.mp4   # 2026-11-10 새 화면 전체 재녹화본 (이 레포 녹화 서버 8010에서 v1~v4·v6·v7. AI가 느리면 녹화 동안만 workflow.yaml budget.max_seconds와 record_demo.mjs AI_TIMEOUT을 늘린다)
python -m scripts.m15_eval all --max-usd 3   # M15 로컬 확인 실험: 임베딩·RAG 있이/없이·고정 규칙 vs Supervisor (실제 API, runs/m15_eval)
python -m scripts.m18_eval all --repeats 3 --max-usd 15   # M18 평가: 고정 흐름 vs 분석·개선 Supervisor, S1~S3 (실제 API, runs/m18_eval, --fake면 비용 0)
python -m scripts.m22_eval --repeats 5   # M22 평가: LangGraph 루프 과거 사례 검색 끔/켬 (준비 실행에서 1순위 반려·다음 안 승인 → 새 실행 각 5회, 실제 API·LLM_CACHE=0, runs/m22_eval, --note-mode specific면 반려 파라미터를 이름으로 막는 사유, --mode 2x2면 같은 실행 안 기억×사례, --fake면 비용 0)
```
AI agent 실행에는 API 키가 필요하다: 기본 제공사 azure_openai는 `.env`의 `MY_PROJECT_AZURE_API_KEY`, anthropic은 `OAH_ANTHROPIC_API_KEY`(우선) 또는 `ANTHROPIC_API_KEY`. 모델·effort·캐시는 `configs/llm.yaml`(배정은 기본값, 분석·개선안은 `roles`의 역할별 모델), 최종 측정 때는 `LLM_CACHE=0`으로 입력 해시 캐시를 끈다. 실험할 때만 모델을 바꾸려면 `LLM_MODEL`, `LLM_THINKING`(adaptive | off), `LLM_EFFORT`(low~max | none)로 덮어쓴다 (쓴 모델은 사용량 기록 `usage.model`에 남는다).
제공사는 `configs/llm.yaml`의 `provider`(기본 azure_openai | anthropic)로 고르고 `LLM_PROVIDER`(환경변수 또는 `.env`)로 덮어쓴다. anthropic은 선택 설치 `pip install -e ".[anthropic]"`. Azure 단가는 정가 추정치(`pricing_estimated`, 화면 "(추정)"), 모델·deployment 대응·모델별 옵션은 `llm.yaml`의 `azure` 섹션 (`core/llm/azure_openai.py`가 Anthropic 형식 ↔ OpenAI 형식 변환, 에이전트 코드는 그대로).
분석·개선 Supervisor(M18)는 `core/improvement/supervisor.py`(LangGraph agents 탭 `mode=supervisor`, 에이전트 탭 Supervisor), 모델은 `llm.yaml` 역할 `supervisor`, 실행 예산은 `configs/workflow.yaml`의 `budget`, 공통 실행 제어(반복·도구 실패·예산·실패 상태)는 `core/llm/control.py`. 개선안 제시 기준은 `configs/proposals.yaml`, LangGraph agents 탭의 회차 순환·종료 판정(`fixed | supervisor`)은 `configs/workflow.yaml`, 핵심 지표·방향·목표는 도메인 `dimensions.yaml`의 `metrics`. LangGraph agents 탭 회차 루프는 과거 사례(`case`)도 검색하고 사람의 승인·반려·의견을 `loop_cases`에 사례로 남긴다(M22, 요청 `use_cases`·`use_memory`, 사례 조각은 `core/improvement/cases.py`). 문서 검색 임베딩은 `configs/llm.yaml`의 `embedding`(`EMBEDDING_PROVIDER` auto | azure_openai | none, 없으면 키워드 검색만), 색인은 `runs/retrieval.sqlite`, 가상 규정은 `domains/dispatch/knowledge/`.
(명령어가 바뀌면 이 섹션을 갱신한다.)

## 작업 방식

- 한 번에 하나의 마일스톤(`docs/plan.md` 부록 A10)만 진행한다. 다음 마일스톤 기능을 미리 만들지 않는다.
- 작업 시작 전 계획을 제시하고, 끝나면 만든 파일·테스트 결과·남은 이슈를 요약한다.
- 기획서와 다르게 구현해야 할 이유가 생기면 임의로 바꾸지 말고 먼저 알린다.

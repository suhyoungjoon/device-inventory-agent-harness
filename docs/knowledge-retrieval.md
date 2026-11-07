# 운영 지식 RAG와 온톨로지 (M15-C, M22)

이름: 처음에는 "규정 RAG"라고 불렀지만 검색하는 것이 세 가지(규정·과거 사례·현장 의견)라서 **운영 지식 RAG**로 부른다.

숫자는 지금처럼 **집계 도구**가 맡는다 (근거 검사 그대로). 검색은 **문장으로 된 지식**(규정·과거 사례·현장 의견)을 맡고,
에이전트가 필요할 때 부르는 **도구**(`search_knowledge`)로 붙인다. 문맥에 미리 넣지 않는다.

## 1. 구성

| 위치 | 하는 일 |
|---|---|
| `core/retrieval/index.py` | SQLite 한 파일에 조각(문장)과 벡터. 키워드(BM25) + 벡터(코사인) 순위를 RRF(`1/(60+순위)` 합)로 합친다. 메타데이터 필터(종류, 파라미터 경로, 차원 구간) |
| `core/retrieval/text.py` | 토큰화(한글은 두 글자 조각도), BM25 |
| `core/retrieval/documents.py` | 도메인 문서(`knowledge/*.md`) → 조항 하나 = 조각 하나. 선언 밖 필드·분야, 가상 표시 없음은 오류 |
| `core/retrieval/records.py` | 기록 → 조각: 과거 회차 사례(결정된 개선안), 현장 의견 |
| `core/retrieval/tool.py` | 도구 정의(`search_knowledge`), 인용 검사(`citation_errors`), 재현 메타데이터(`retrieval_meta`), 단계별 검색 요약(`retrieval_summary`, M22 화면) |
| `core/improvement/cases.py` | 과거 사례 조각을 모으는 공용 함수 (M22): 개선 탭 결정(DB 개선안) + 회차 루프 결정(`loop_cases`). 개선 탭과 루프가 같이 쓴다 |
| `core/retrieval/session.py` | 실행 하나의 준비: 문서·기록을 색인에 맞추고(해시가 같으면 다시 쓰지 않음) 도구 묶음을 만든다 |
| `core/llm/embeddings.py` | 임베딩 클라이언트. `configs/llm.yaml`의 `embedding` (auto: LLM 제공사가 azure_openai면 Azure `text-embedding-3-small`, 아니면 none) |
| `domains/dispatch/knowledge/` | 가상 운영 규정 4분야(출동 반경·관할, 자격·인증, 근무시간·가능시간, 안전) × 5조항 + 선언(`index.yaml`: 종류·필드·분야) |

임베딩 제공사가 없으면(Anthropic 제공사의 기본값, 리허설의 가짜 AI) **키워드 검색만** 쓴다. 결과의 `mode`가 `keyword`로 남는다.
임베딩 클라이언트를 못 만들면(키 없음 등) 실패하지 않고 키워드로 내려간다.

색인 파일은 DB 옆 `retrieval.sqlite` (기본 `runs/retrieval.sqlite`, 시연 모드는 작업 복사본 폴더). git에 넣지 않는다.

## 2. 검색 대상과 쓰는 에이전트

| 종류 (`kind`) | 만드는 곳 | 쓰는 에이전트 |
|---|---|---|
| `regulation` 가상 운영 규정 | `domains/dispatch/knowledge/*.md` (커밋된 문서) | 개선 제안(개선 탭·agents 탭), 의견 정리(agents 탭) |
| `case` 과거 회차 사례 | 사람이 결정한 개선안 (발견 → 개선안 → 미리 돌려보기 → 결정·사유). 개선 탭의 승인·반려(DB 개선안)와 **LangGraph 회차 루프의 승인·반려·의견**(`loop_cases`, M22). 요청·실행마다 두 곳을 함께 다시 맞춘다 | 분석(개선 탭, 사례가 있을 때만), 개선 제안(개선 탭, **agents 탭 회차 루프 고정 흐름·Supervisor**, M22) |
| `opinion` 현장 의견 | agents 탭에서 의견 정리 에이전트가 제약으로 정리한 의견 (원문 + 제약) | 개선 제안·의견 정리(agents 탭, 다음 실행부터) |

분석 에이전트에는 사례가 하나도 없으면 도구를 붙이지 않는다 (입력·캐시 키가 이전과 같다). 관점별 분석에는 아직 붙이지 않는다.

### 2.1 LangGraph 회차 루프의 과거 사례 (M22)

- **검색:** 데이터 준비 단계가 규정·의견에 더해 `case`도 색인에 맞추고, 개선 제안 에이전트(고정 흐름)와 Supervisor가 부르는 개선 에이전트·Supervisor 자신의 `search_knowledge`에 사례 종류가 붙는다. 사례를 검색할 수 있을 때만 개선 에이전트 입력에 한 줄이 더 붙는다: 반려된 안과 그 사유를 먼저 찾고 같은 변경(같은 파라미터·같은 방향·같은 구간 조건)을 다시 내지 말 것 (`core/improvement/proposer.py`의 `CASE_NOTE`).
- **기록:** 사람 검토에서 승인·반려·의견을 받으면 그 개선안을 `loop_cases`에 남기고(시연 모드 제외), 사례를 검색하는 실행이면 색인에도 바로 넣는다 (같은 실행의 다음 회차도 찾을 수 있다). 사례 id는 `case-<개선안 id 끝 8자>`. 남기는 것은 개선안 본문(바꾼 파라미터), 미리 돌려본 **핵심 지표 전·후만**, 결정·사유, 대상 발견 요약(id·제목·구간)과 규칙 버전이다. 정답표·가상 실적은 넣지 않는다.
- **저장 방식:** DB 개선안(`proposals`)을 재사용하지 않고 별도 테이블 `loop_cases`를 두었다. 개선안 행은 실행 → 리포트 → 개선안 묶음 행이 있어야 하는데 루프는 그것을 만들지 않고, 억지로 넣으면 개선 탭 이력·규칙 변경 이력·기억(`collect_memory`)에 루프 결정이 섞이기 때문이다. 대신 사례 조각을 만드는 함수(`core/improvement/cases.py`)가 두 곳을 늘 함께 모은다 (한쪽만 맞추면 색인 동기화가 다른 쪽 사례를 지운다).
- **켜고 끄기:** `POST /agents/runs`의 `use_cases`(기본 true, `use_knowledge`가 false면 함께 꺼짐), `use_memory`(기본 true: 같은 실행 안의 반려·의견을 개선 입력에 넣는 기억. 꺼도 화면의 반려 기록은 남는다).
- **화면:** agents 탭 타임라인의 개선 단계(개선 제안 에이전트·Supervisor 지휘) 밑에 "검색: 규정 n · 사례 n · 의견 n · 인용 n건" 줄과 받은 사례 펼쳐 보기(인용한 사례 ✓).
- **효과 (2026-11-07, 회사 Azure, 각 5회):** 이전 실행에서 반려한 안과 같은 변경의 재제안 끔 1/5 → 켬 0/5, 켬은 5/5 실행이 사례를 인용. 승인 사례가 기준점이 되어 1순위 개선폭은 작아졌다 (+5.43 → +2.61%p). 반려 사유를 구체적으로(파라미터 이름으로) 주면 같은 파라미터·구간을 다시 건드린 실행이 끔 5/5 → 켬 0/5 (1순위 개선폭 +5.01 → +1.36%p). 같은 실행 안에서는 기억만으로 충분하고(기억·사례 모두 끔 3/3 → 기억만 0/3, 사례만 1/3), 사례 검색은 실행 사이를 잇는다. 자세히는 `docs/experiment-real-api-2026-10.md` 6.17, 6.17.1, 6.17.2.

## 3. 인용과 검사

- 검색 결과마다 `ref`가 있다. 조각 id 그대로다 (규정은 조항 id `DIST-01`, 사례는 `case-<개선안 id 끝 8자>`, 의견은 `op-<해시 8자>`). 도구 호출의 `call_ref`처럼 짧아서 모델이 옮겨 적기 쉽다.
- 개선안·의견 정리 제출에 `cited_docs` 칸이 생긴다 (검색 도구가 있을 때만, 없으면 도구 정의가 이전과 같다).
- **검색 결과로 받지 않은 ref를 인용하면** 개선안은 적용 불가(`검색 결과에 없는 문서 조각 인용`), 의견 정리는 형식 검사 실패(사람에게 다시 묻기)다.
- 인용하지 않은 조각은 근거가 아니다. 숫자 근거는 여전히 집계 도구 호출(`cited_calls`)만 인정한다.

## 4. 재현

| 남는 곳 | 내용 |
|---|---|
| 개선안 묶음 `meta.retrieval` | `mode`(keyword·hybrid), `embedding_model`, 돌려준 조각 `[{id, hash}]`, 인용한 id |
| 분석 리포트 `body.retrieval` | 같은 형식 (사례 검색을 붙였을 때만) |
| agents 탭 `loop.retrieval` | 같은 형식 (실행 하나 동안 누적). M22: `loop.retrieval_options`(검색한 종류, 기억 사용 여부), `loop.cases_written`(이 실행이 남긴 사례 id), 단계 기록의 `retrieval`(그 단계에서 받은 종류별 조각 수·인용·사례) |

조각 해시는 종류·제목·본문·메타데이터로 만든다. 문서를 고치면 해시가 바뀌어 그 조각만 다시 임베딩한다.
비교 실험(RAG 있이/없이)은 `use_knowledge: false` (`POST /analysis`, `POST /proposals`, `POST /agents/runs`). 사례 검색만 끄는 실험은 `use_cases: false` (`POST /agents/runs`, `scripts/m22_eval.py`).

## 5. 가상 규정 문서 쓰는 법

```
---
area: distance          # index.yaml의 areas
fictional: true         # 가상 문서 표시 (없으면 오류)
---
# 가상 운영 규정 — 출동 거리 (가상 문서, 실제 규정 아님)

## DIST-01 관할 밖 출동 거리 상한
<!-- meta: {"params": ["matching.area_extension_km"], "dims": {"area_zone": ["boundary", "core"]}} -->
본문 …
```

- 수치는 `params.yaml`의 허용 범위·분류와 모순되지 않게 쓴다 (테스트가 검사: DIST-01 4km ≤ bounds 5km, HOUR-03 90분 ≤ 120분, 규정이 가리키는 파라미터는 실제로 있다).
- 추정값·고정값·통제 설정을 다룬 조항(SAFE-01~03)은 그 값을 개선안으로 바꾸지 않는다는 분류(M13)와 같은 말을 한다.

## 6. 온톨로지 (도메인 팩 스키마)

새 인프라(그래프 DB) 없이, 도메인 팩이 이미 선언한 스키마를 개념과 관계로 정리한다. 그래프 검색은 이번 범위 밖(후속)이다.

```
지시서(항목) ──dims──▶ 차원 값 (지점·시간대·작업유형·매체·건물유형·난이도·관할 경계)     dimensions.yaml dimensions
   │                                                                                     
   ├─결정──▶ DecisionRecord(status, reason_code) ──reason_code──▶ 사유 코드               dimensions.yaml reason_codes
   │                       └─위반──▶ Violation(rule) ──▶ 필수조건 규칙                    dimensions.yaml violation_rules
   └─자원──▶ 작업자 (traits: 가능시간·기술·자격·지점)                                       dimensions.yaml resources
결함 패턴(P1~P4) ──심는 곳──▶ 차원 구간 + 사유 코드 ──고치는 곳──▶ 파라미터 (param_hint)     faults.yaml
파라미터 ──분류──▶ policy | estimate | fixed | governance                                  params.yaml kinds (M13)
         ──허용 범위──▶ bounds,  ──구간 조건──▶ overrides(when: 차원 값)
지표 ──핵심 여부·방향·목표──▶ primary, better, target                                      dimensions.yaml metrics (M15)
규정 조항 ──분야──▶ 출동 반경·관할 · 자격·인증 · 근무시간·가능시간 · 안전                                   knowledge/index.yaml areas
          ──관련──▶ 파라미터 경로(params), 차원 구간(dims)                                  조항 meta
발견 ──구간──▶ 차원 구간,  ──사유──▶ 사유 코드,  ──자원──▶ 작업자                            분석 리포트
개선안 ──해소──▶ 발견(target_findings),  ──바꿈──▶ 파라미터,  ──근거──▶ 규정·사례·의견(cited_docs)
사례 = 개선안 + 미리 돌려보기 + 결정·사유;  현장 의견 ──정리──▶ 제약(param·metric 한도)
```

| 개념 | 정의 위치 | 다른 개념과의 관계 |
|---|---|---|
| 차원 | `dimensions.yaml` `dimensions` | 결정·발견·결함·구간 조건·규정 조항이 같은 값으로 가리킨다 |
| 사유 코드 | `dimensions.yaml` `reason_codes` | 결정(미배정 이유), 발견, 결함 패턴 |
| 필수조건 규칙 | `dimensions.yaml` `violation_rules` | `validate()`만 판정 (원칙 3) |
| 자원 | `dimensions.yaml` `resources` | 발견의 resources 칸 (M12-d) |
| 지표 | `dimensions.yaml` `metrics` | 개선안 순위(primary·better), 개선 루프 목표(target) |
| 파라미터 분류 | `params.yaml` `kinds` | 개선안이 바꿀 수 있는가 (policy만), 규정 조항의 params |
| 결함 패턴 | `faults.yaml` | 정답표 (채점에만), 규정 분야와 대응 (P4 경계 지역 ↔ DIST) |
| 규정 분야·조항 | `knowledge/index.yaml`, `*.md` | 제약·개선안 근거 (인용) |
| 문서 종류·필드 | `knowledge/index.yaml` `kinds`, `fields` | 검색 필터 |

## 7. 평가 설계 (실행은 로컬, 실제 API 필요)

실행: `python -m scripts.m15_eval rag --repeats 3 --max-usd 3` (`all`이면 임베딩 확인과 고정 규칙 vs Supervisor까지). 같은 리포트로 개선안 묶음을 RAG 있이/없이 번갈아 만든다. 첫 묶음(준비)의 1순위 안은 반려해 기억과 사례를 만든다. 규정 위반은 `domains/dispatch/knowledge/limits.yaml`(조항 본문과 같은 숫자, 테스트로 검사)로 코드가 센다. 결과 표는 `runs/m15_eval/<시각>/summary.md`.

| 항목 | 방법 |
|---|---|
| 비교 | 같은 리포트로 RAG 있이 / 없이 (`use_knowledge` true·false) × 개선안 3회씩. 같은 모델·effort, `LLM_CACHE=0` |
| 제약 위반 수 | 개선안 묶음의 미리 돌려보기에서 `constraint_violations` 건수 (현장 의견 제약을 준 경우와 안 준 경우 둘 다) |
| 규정 위반 안 | 규정 한도(DIST-01 4km, HOUR-03 90분, QUAL-04 70점)를 넘는 안의 수 (코드로 셀 수 있다: 값 비교) |
| 반려된 안 재제안 수 | 이전 회차에 반려한 안과 같은 변경을 다시 낸 수 (사례 검색이 기억(M12-c)보다 나은지) |
| 규정 인용 정확도 | 인용한 조항이 안이 바꾸는 파라미터(`params` 메타)와 맞는 비율, 인용 검사 실패 수 |
| 임베딩 비교 | `EMBEDDING_MODEL=text-embedding-3-small` / `-large`, 키워드만(`EMBEDDING_PROVIDER=none`). 지표: 질의 20개(규정 분야별 5)의 상위 3 안 정답 조항 비율 |
| 비용 | 검색 호출 수, 입력 토큰 증가분 (도구 결과 길이) |

질의·정답 조항 목록은 평가할 때 `domains/dispatch/knowledge/`의 조항 id로 만든다 (예: "관할 밖 몇 km까지" → DIST-01).

# M21 코어 변경 기록

두 번째 도메인(`inventory`, 단말 재고·구매)을 붙이면서 코어(`core/`, `workflow/`, `api/`, 공통 화면)를 바꾼 내역이다.
원칙: 도메인 지식은 `domains/inventory/`와 `web/src/domains/inventory/`에만 넣고, 코어는 필드 **추가**만 한다. 출동 동작은 그대로다.

## 요약

| 단계 | 코어 변경 파일 | 줄 수(+/−) | 이유 |
|---|---|---|---|
| M21-a | 없음 | 0 / 0 | 도메인 팩 인터페이스(`DomainPack`)와 계약 테스트만으로 붙었다 |
| M21-b | 없음 | 0 / 0 | 결품·재고일수·공급 사용률은 도메인 `analysis_tools`로 제공. 코어 채점(fault_scorer)·근거 검사를 그대로 썼다 |

## 단계별 메모

### M21-a (레포 복사, 파일 4종, 생성기, 규칙 엔진·validate·metrics)

- 코어 변경 0건.
- 코어를 바꾸지 않고 도메인 안에서 푼 것:
  - **미래 수요 숨기기:** 계획 기간의 실제 수요는 인스턴스 dataclass 필드가 아닌 숨김 속성에 둔다. 코어의 `to_jsonable`(L0 프롬프트, API 응답)은 dataclass 필드만 직렬화하므로 AI와 화면 응답에 실리지 않는다 (`tests/test_inventory_generator.py::test_l0_prompt_has_no_future_demand`).
  - **부분 실행:** 재고가 주차를 넘어 이어지므로, 시범 10건처럼 일부만 결정해도 범위 밖 항목은 규칙으로 채워 같은 기간 재고 흐름을 끝까지 계산한다. 지표는 범위에 든 지점×모델만 센다 (`rule_engine.simulate`).
  - **실패의 뜻:** 코어 집계는 `status != success`를 실패로 센다. 재고 도메인은 "한도 때문에 하나도 못 산 발주"만 실패(사유 코드)로 두고, 결품은 지표·분석 도구로 본다. 결품 구간을 분석 agent가 찾게 하는 도구는 M21-b에서 도메인 `analysis_tools`로 더한다.
- 지시서와 다르게 정한 것:
  - 필수조건에 `INVALID_DECISION`(없는 항목, 제조사 불일치, 형식 오류, 중복)을 더했다. 출동의 `invalid_decision`과 같은 역할이다.
  - 공급 한도·창고 용량은 결함(P2)으로 바꾸는 "현실 데이터"라 `params.yaml`이 아니라 생성 설정(`dataset.yaml`)과 인스턴스에 둔다. 주간 예산은 지시서대로 `params.yaml`의 `budget.weekly_cap`(governance)이다.
  - 평가 기준 `evaluation.excess_weeks`(과잉재고로 셀 주 수, fixed)를 더했다.

### M21-b (결함 주입, 드러남 테스트, 분석 도구, 이상적 분석가)

- 코어 변경 0건.
- 결품은 "발주 실패"가 아니라 코어 집계(`aggregate`)에 안 잡힌다. 도메인 분석 도구 `stockout_by`(차원별 결품률·재고일수)가 같은 차원 이름으로 집계해, 코어 채점의 구간형 정답(`answer.dims`)과 그대로 맞물린다.
- 분석 도구 5개: `stockout_by`, `branch_stock_stats`(P3), `supply_usage`(P2), `forecast_error`, `demand_volatility`(P4).
- 숫자 보정 (결함이 드러나고 P4가 bounds 안에서 고쳐지게): 초기 재고 1.5~2.5주 → 2.5~3.5주(1·2주차 결품은 어떤 파라미터로도 못 고쳐 P4 개선이 묻혔다), 주간 예산 90,000 → 110,000만원(P4 개선안이 예산에 막혔다), 공급 한도 MA 450 → 500·MB 360 → 420(P3의 서초 과잉 발주가 다른 지점 신규 모델 공급을 막아 P1 구간과 섞였다), P4 변동계수 0.45 → 0.6.

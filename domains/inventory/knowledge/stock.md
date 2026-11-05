---
area: stock
fictional: true
---
# 가상 구매 규정 — 재고 수준·안전재고·예측 보정 (가상 문서, 실제 규정 아님)

## STK-01 평균 재고일수 상한
<!-- meta: {"params": ["safety.weeks", "review.cycle_weeks"]} -->
지점 평균 재고일수는 21일을 넘지 않게 운영한다. 재고일수를 늘리는 변경은 결품 감소 효과와 함께 검토한다.

## STK-02 안전재고 상한
<!-- meta: {"params": ["safety.weeks"], "dims": {"family": ["flagship", "mid", "kids_senior"]}} -->
안전재고는 어떤 모델군이든 예측 수요 3주 치를 넘지 않는다. 수요 변동이 큰 모델군만 골라 안전재고를 늘리는 것은 허용한다.

## STK-03 신제품 예측 보정 상한
<!-- meta: {"params": ["forecast.new_model_boost"], "dims": {"phase": ["new"]}} -->
신규 출시 모델의 예측 보정 배수는 2.0배를 넘지 않는다. 출시 초반 수요 급증은 보정만으로 다 따라가지 않아도 된다.

## STK-04 예측 기간
<!-- meta: {"params": ["forecast.window_weeks"]} -->
예측 이동평균 기간은 2주 이상으로 둔다. 기간을 줄이면 최근 변화는 빨리 따라가지만 들쭉날쭉해진다.

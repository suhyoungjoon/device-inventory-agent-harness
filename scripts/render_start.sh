#!/bin/sh
# Render 시작 명령 (render.yaml). 환경변수 하나로 모드를 고른다.
#   DEMO_BUNDLE 있음 → 시연 모드: 저장된 AI 결과만 재생 (AI 호출·키·비용 없음, 승인은 임시 사본에만)
#   DEMO_BUNDLE 없음 → 실제 모드: .env 대신 Render 환경변수의 MY_PROJECT_AZURE_API_KEY로 AI를 부른다
#                     (공개 주소면 접근 제한을 먼저 건다. docs/deploy.md)
set -e
export HOST="${HOST:-0.0.0.0}"
if [ -n "$DEMO_BUNDLE" ]; then
  exec python -m api.main --demo "$DEMO_BUNDLE"
else
  exec python -m api.main
fi

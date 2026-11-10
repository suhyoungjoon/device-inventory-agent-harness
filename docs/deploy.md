# 호스팅: Render(백엔드) + Vercel(화면)

```
브라우저 ── Vercel (web/, 정적 화면) ──rewrites──▶ Render (FastAPI, api/)
                                   /domains, /runs, /agents … 15개 경로
```

- 화면은 API를 상대 경로(`/runs` 등)로 부른다. Vercel이 그 경로를 Render로 넘기므로(`web/vercel.json`의 `rewrites`) 화면 코드를 바꾸지 않고 CORS 설정도 없다.
- 백엔드 모드는 Render 환경변수 하나로 고른다(`scripts/render_start.sh`).
  - `DEMO_BUNDLE=demo/bundle`(처음 설정): **시연 모드**. 저장된 실제 AI 결과만 재생하고 AI를 부르지 않는다. 키·비용이 없고, 승인해도 임시 사본만 바뀐다.
  - `DEMO_BUNDLE` 없음: **실제 모드**. 회사 Azure OpenAI를 부른다(아래 "실제 AI로 바꾸기").

## 시연 번들 (`demo/bundle`)

`python -m scripts.snapshot export --db runs/harness.db --out demo/bundle --agents-flows runs/agents_flows --note "..."`로 만든다. 2026-11-08 번들에 든 것:

- 비교 탭: 단말 재고 시범 10건(1주차 서초) 실제 AI L0·L3·L5 (seed 42, P1~P4), 결함 없는 데이터 L3. 데이터·범위·레벨을 같게 고르면 저장된 결과를 재생한다.
- LangGraph agents 탭 "기록 열기": 실제 AI 고정 흐름 1회 (분석 → 개선 → 사람 승인 → 결품률 5.1% → 3.8%).
- 규칙 방식 실행은 AI가 아니라서 어떤 데이터로도 바로 돈다(출동 포함).
- 분석·개선 탭의 저장 결과는 아직 없다. 실제 AI로 돌린 뒤 번들을 다시 만들면 들어간다.

번들은 키를 담지 않는다(DB·기록에 키 값 없음을 확인).

## 처음 배포

1. **Render (백엔드)**
   1. Render 대시보드 → New → **Blueprint** → GitHub `suhyoungjoon/device-inventory-agent-harness` 연결 → `render.yaml`을 읽어 `inventory-harness-api` 서비스를 만든다.
   2. `MY_PROJECT_AZURE_API_KEY`는 시연 모드에서는 비워 둔다.
   3. 배포가 끝나면 주소를 확인한다(보통 `https://inventory-harness-api.onrender.com`). `/domains`가 `["dispatch","inventory"]`를 돌려주면 된다.
   4. 무료 플랜은 15분 동안 요청이 없으면 잠들고, 첫 요청에 30초~1분 깨어난다. 디스크는 재시작 때 초기화된다(시연 모드는 번들에서 다시 시작하므로 문제없다).
2. **Vercel (화면)**
   1. Render 주소가 위 기본값과 다르면 `web/vercel.json`의 `destination` 주소를 바꾼다.
   2. `vercel login` → `cd web && vercel` (처음: 프로젝트 연결, Root는 `web`) → 확인 뒤 `vercel --prod`. 또는 Vercel 대시보드에서 GitHub 레포를 가져오고 Root Directory를 `web`으로 둔다.
   3. 화면 주소에서 도메인 "inventory"를 고르고, 비교 탭에서 데이터 번호 42 · 심어둔 문제 P1~P4 · "1주차 서초 10건 (시범)" · L3 → AI 방식 실행이 저장 결과를 재생하는지 본다.

API 경로 접두어를 추가하면(`web/vite.config.ts`의 `API_PREFIXES`) `web/vercel.json`의 `rewrites`에도 같은 경로를 넣는다.

## 실제 AI로 바꾸기

1. **먼저 접근을 막는다.** 실제 모드는 주소를 아는 누구나 회사 AI 비용을 쓸 수 있다. Render 주소(`*.onrender.com`)도 Vercel을 거치지 않고 바로 열린다는 점에 주의한다.
   - 화면: Vercel 프로젝트 Settings → Deployment Protection (팀원 로그인 또는 비밀번호).
   - API: Render 주소를 직접 막는 장치가 필요하다(예: 공유 토큰을 확인하는 미들웨어, 또는 사내망에서만 열기). 이 레포에는 아직 없다. 실제 모드로 바꾸기 전에 따로 넣는다.
2. Render 대시보드 → Environment에서 `DEMO_BUNDLE`을 지우고 `MY_PROJECT_AZURE_API_KEY`에 회사 키를 비밀값으로 넣는다. 저장하면 다시 배포된다.
3. 실제 모드에서 승인하면 컨테이너 안의 `params.yaml`이 바뀐다. 재시작하면 레포 값으로 돌아간다. 실행 기록·DB도 재시작 때 사라지므로, 남기려면 Render 유료 디스크를 붙이거나 결과를 번들로 내려받아 커밋한다.
4. 다시 시연 모드로: `DEMO_BUNDLE=demo/bundle`을 다시 넣는다.

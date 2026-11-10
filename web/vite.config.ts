import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 개발 중에는 API(python -m api.main, :8000)로 프록시한다. api/의 경로 접두어를 추가하면 여기에도 넣고, 배포용 web/vercel.json의 rewrites도 다시 만든다 (docs/deploy.md).
const api = "http://127.0.0.1:8000";
const API_PREFIXES = ["/domains", "/runs", "/harness", "/compare", "/analysis", "/proposals", "/history", "/memory", "/constraints", "/params", "/demo", "/workflow", "/agents", "/agent-tab", "/llm"];

export default defineConfig({
  plugins: [react()],
  server: { proxy: Object.fromEntries(API_PREFIXES.map((p) => [p, api])) },
  build: { chunkSizeWarningLimit: 800 }, // recharts 포함, 로컬 도구라 분할하지 않음
});

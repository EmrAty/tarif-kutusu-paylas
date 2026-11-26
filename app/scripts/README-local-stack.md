# Local stack

Runs the real web client (`dist/`) and the real `api/*.js` handlers on a single
local port, backed by an in-memory Upstash-compatible Redis. It never talks to
Production or Preview data.

```
cd app
npm run build
npm run local-stack -- --port 4173 --db ../local-db.json
# or: node scripts/local-stack.mjs [--port 4173] [--host 127.0.0.1] [--dist dist] [--db file.json]
```

- Redis REST endpoint listens on an ephemeral `127.0.0.1` port with a random
  bearer token; `KV_REST_API_URL` / `KV_REST_API_TOKEN` are set before any
  handler is imported. `--db` loads/saves the data (debounced 300 ms, atomic
  rename, and on SIGINT/SIGTERM).
- Firebase ID tokens are still verified against Google's real JWKS (needs
  internet and a real Firebase sign-in). There is no auth bypass.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are not set: extraction, translation,
  suggestions and transcription endpoints fail by design.
- Static files follow `vercel.json` rewrites and headers; there is no SPA
  fallback (unknown paths are 404), like the real deployment.

Limitations: the Redis engine is the test helper (`test/helpers/memoryRedis.mjs`)
and supports only the commands it implements (no real TTL expiry; `EXPIRE` is a
no-op); `waitUntil` / `getDeadline` from `@vercel/functions` have no Vercel
runtime here, so background work runs without a deadline; function
`maxDuration`, cron jobs and the `/api` trailing-path routing of Vercel are not
emulated; no hot reload (restart after changing `api/`).

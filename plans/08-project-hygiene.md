# Plan 8 — Project hygiene: tests, CI, Docker

## Goal

Give the repo a safety net (unit tests + CI) and a deployment story (Docker
for home servers/NAS). Zero new runtime dependencies; tests use `node:test`
(built-in since Node 18).

## Part A — Test harness

### What's testable without a browser

The client is a single browser-global script — don't try to jsdom it.
Instead, the testing strategy is:

1. **Server modules get real unit tests.** Plans 3/4/7 already extract
   `lib/store.js`, `lib/rss.js`, `lib/ics.js` as ES modules partly *for this
   reason*. Additionally extract from `server.js`:
   - `lib/env.js` — the .env parser (server.js:22–30) as
     `parseEnv(text) → Record<string,string>`.
   - `lib/prefs.js` (after Plan 2) — pref validation/sanitization + the
     instructions-block builder (pure string-in/string-out).
2. **Shared pure logic moves to `public/lib/` as browser-and-node modules.**
   Candidates already in app.js: `describeWeatherCode` (app.js:840), the
   weekday/label matching logic from Plan 1, routine-step validation from
   Plan 4. Pattern: plain ESM files under `public/lib/`, imported by tests
   directly; `app.js` gains `<script type="module">` — **hold on**: app.js
   is a classic script. Converting is easy (`index.html`:
   `<script type="module" src="app.js">`) and has no other consequences at
   this size; do it as the first commit of this plan.
3. **One HTTP smoke test** boots the real server on an ephemeral port with a
   temp data dir and fake `OPENAI_API_KEY`, then asserts:
   - `GET /` → 200 text/html
   - `GET /../server.js` (traversal) → 403/404, **including the
     `path.join` traversal variant** `GET /..%2f..%2fserver.js`
   - `POST /api/session` with no key configured → 500 with the friendly error
   - Plan 3 endpoints: full PUT/GET/409 cycle against the temp store.
   To make this possible, `server.js` needs the standard testability split:
   move listening behind `if (import.meta.url === pathToFileURL(process.argv[1]).href)`
   and export `createNovaServer({ env, dataDir })`.

### Layout & scripts

```
test/
  env.test.js  store.test.js  rss.test.js  ics.test.js  prefs.test.js
  server.test.js
  fixtures/   (sample RSS xml, sample ICS incl. TZID + weekly RRULE + folded lines)
```

```json
// package.json
"scripts": {
  "start": "node server.js",
  "test": "node --test test/"
}
```

### Priority tests (the ones that catch real bugs)

- `parseEnv`: quotes, CRLF (Windows!), comments, `existing process.env` wins.
- `store`: 409/rev bump, atomic write leaves no `.tmp` residue, corrupt-file
  → `.bad` rename, concurrent `update()` calls serialize.
- `ics`: the `zonedTimeToEpoch` helper across DST boundaries (America/
  New_York event at 2:30 EST vs EDT), folded lines, all-day events, weekly
  RRULE with BYDAY+UNTIL.
- `rss`: CDATA titles, numeric entities, malformed feed → empty array not
  throw.

## Part B — CI (GitHub Actions)

`.github/workflows/ci.yml`:

```yaml
name: CI
on: { push: { branches: [main] }, pull_request: {} }
jobs:
  test:
    strategy:
      matrix:
        node: [18, 20, 22]
        os: [ubuntu-latest, windows-latest]   # windows matters: dev box is Windows
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "${{ matrix.node }}" }
      - run: npm test
```

No install step needed (zero deps) — CI stays under a minute. Add a
`node --check server.js public/app.js lib/*.js` step as a cheap syntax gate
for files tests don't import.

## Part C — Docker

`Dockerfile`:

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
VOLUME /app/data
USER node
CMD ["node", "server.js"]
```

- No `npm install`, no lockfile, no build stage — copy and run.
- `VOLUME /app/data` persists the Plan 3 store; document
  `docker run -d -p 3000:3000 --env-file .env -v nova-data:/app/data nova`.
- `.dockerignore`: `.git`, `.env`, `data/`, `plans/`, `test/`, `.claude/`.
- **data dir must be writable by `node` user** — `server.js`'s
  `mkdirSync` runs as node; with a named volume Docker chowns on first
  mount, but bind mounts won't. README note: bind-mount users may need
  `--user` or a chown. (This is the classic gotcha; one sentence saves an
  issue report.)
- HTTPS (Plan 6) in Docker: document mounting the certs dir and setting the
  env vars; most NAS users will instead front it with their reverse proxy
  (Caddy/Traefik terminate TLS) — mention both, recommend the proxy.
- Optional compose file `compose.yaml` (server + named volume + env_file) —
  small, include it.

## Files touched

| File | Change |
|------|--------|
| `lib/env.js` (+ later `lib/prefs.js`) | extracted from server.js |
| `server.js` | import lib/env, export createNovaServer, main-module guard |
| `public/app.js` → partial `public/lib/*.js` | extract pure helpers, switch to module script |
| `test/**` | new |
| `package.json` | test script |
| `.github/workflows/ci.yml`, `Dockerfile`, `.dockerignore`, `compose.yaml` | new |
| `README.md` | Testing + Docker sections |

## Ordering note

Land Part A's *harness* (env test + server smoke test + CI) **early** — it
can precede Plans 1–7 and protects them. The store/rss/ics test files land
inside their respective feature plans' PRs once those modules exist; this
plan owns the harness, conventions, CI, and Docker.

## Verification

1. `npm test` green on Windows dev box and in all 6 CI matrix cells.
2. Temporarily break the .env parser quote-stripping → test fails.
3. `docker build -t nova . && docker run -p 3000:3000 --env-file .env nova`
   → working assistant; `docker restart` → lists persist (named volume).
4. `curl http://localhost:3000/..%2fserver.js` → not the source code.

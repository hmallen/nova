# Nova — Implementation Plans

Eight plans covering the agreed feature roadmap. Each plan is an independently
shippable unit of work with its own verification steps. Dependencies between
plans are listed below; within a tier, plans can be built in any order or in
parallel.

| # | Plan | Depends on | Size |
|---|------|-----------|------|
| 1 | [Reminders, recurring alarms & snooze](01-reminders-and-alarms.md) | — | M |
| 2 | [Preferences & memory](02-preferences-and-memory.md) | — | M |
| 3 | [Server-side persistence for lists](03-server-side-persistence.md) | — | M |
| 4 | [Routines & news briefing](04-routines-and-news.md) | 1, 2 (soft) | M |
| 5 | [Session robustness & text input](05-session-robustness.md) | — | S |
| 6 | [PWA & mobile support](06-pwa-and-mobile.md) | — | S |
| 7 | [Real integrations: Home Assistant, calendar, radio](07-real-integrations.md) | 3 (patterns) | L |
| 8 | [Project hygiene: tests, CI, Docker](08-project-hygiene.md) | best last-ish | S |

## Suggested order

1. **Tier 1 (foundation):** Plans 1, 2, 3 — they extend the existing skill
   pattern and add the server-side store other plans reuse. All three touch
   `public/app.js` in different regions (alarm engine, prefs, list handlers),
   so they can be developed in parallel but should merge sequentially.
2. **Tier 2 (compounding features):** Plans 4 and 5. Routines get materially
   better once reminders and preferences exist (a "good morning" routine wants
   the user's home city). Plan 5 is independent.
3. **Tier 3 (reach):** Plans 6 and 7.
4. **Plan 8 (hygiene)** can start any time — the test harness and CI are more
   valuable the earlier they land, but the Docker piece should wait until the
   `data/` directory from Plan 3 exists so the volume mount is right.

## Shared conventions (apply to every plan)

- **Zero npm dependencies stays.** All server code uses `node:` built-ins;
  all client code is vanilla browser JS. Any parsing (RSS, ICS) is done with
  small hand-rolled parsers, scoped to the subset of the format we emit/need.
- **Secrets never reach the browser.** Any third-party credential (Home
  Assistant token, etc.) lives in `.env` and is used only inside `server.js`
  proxy endpoints, same pattern as `OPENAI_API_KEY`.
- **New skills follow the existing tool pattern:** a JSON-schema entry in
  `TOOLS`, an async handler in `toolHandlers` returning a plain object
  (`{ ok: true, ... }` or `{ error: "..." }`), a render function if there's a
  UI card, and — when the model needs behavioral guidance — a sentence added
  to `INSTRUCTIONS` in `server.js`.
- **Tool results are for the model's ears.** Keep result objects small and
  speakable; the model reads them aloud. Don't return raw API payloads.
- **`.env.example` documents every new env var** with a comment, and README's
  feature list / "Try:" section is updated in the same PR as the feature.
- **Windows-friendly:** repo runs on Windows (primary dev box); use
  `path.join`, never hardcode `/`, and keep npm scripts shell-agnostic.

# Nova — Implementation Plans

Ten plans covering the agreed feature roadmap. Each plan is an independently
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
| 9 | [Persistent memory: profile facts & session rollover](09-persistent-memory.md) | 2, 3, 5 | L |
| 10 | [Memory archive & learned habits](10-memory-archive-and-habits.md) | 9, 3, 4 (soft) | L |

Plans 9 and 10 are shipped. Two of plan 10's "Before you start" questions can
only be answered by a household that has been running it for a while, so the
code reports them instead of assuming: the boot log prints the archive's size
per month, a recall over a month file past ~50k rows warns that the substring
scan has outgrown itself, and every `recall_memory` call is logged with its
arguments so the "does it fire on ordinary turns?" question has data behind it.

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
5. **Plans 9 and 10 (memory)** come last of the feature work, and are two
   halves of one four-tier design — Plan 9 covers what Nova always knows
   (facts in the prompt, conversation carried across reconnects), Plan 10
   covers what it can look up or notice (an on-demand archive, learned
   habits). Plan 9 extends Plan 2's About-the-user block and Plan 3's file
   store, and its rollover layer needs Plan 5's reconnect path. Plan 10 builds
   on Plan 9's store and provenance conventions and should not start until
   Plan 9 has landed. All four tiers ship separately, in order.

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

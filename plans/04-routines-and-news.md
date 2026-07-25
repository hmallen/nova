# Plan 4 — Routines & news briefing

## Goal

- "Good morning" runs a routine: weather + today's schedule (timers/alarms/
  reminders) + a short news briefing, delivered as one flowing spoken update.
- "What's in the news?" works standalone via a keyless RSS-backed `get_news`
  tool (server-proxied — browsers can't fetch cross-origin RSS).

Depends softly on Plan 1 (reminders make the morning summary useful) and
Plan 2 (home city makes weather zero-friction). Works without them.

## Design

### 1. News: server proxy + parser

**`lib/rss.js`** (new, hand-rolled, testable):

```js
// parseRss(xml) → [{ title, source?, published? }]
// Regex-based extraction of <item> blocks and their <title>/<source>/<pubDate>.
// Handles CDATA (<![CDATA[...]]>) and decodes the five XML entities
// (&amp; &lt; &gt; &quot; &apos;) + numeric entities. That subset is enough
// for Google News / BBC / NPR feeds; document the limitation in the file.
```

**`server.js`**: `GET /api/news?topic=<optional>`:

- Feed selection:
  - No topic → `NEWS_FEEDS` env var (comma-separated URLs), default
    `https://news.google.com/rss` (top stories, no key).
  - With topic → `https://news.google.com/rss/search?q=<topic>` (keyless
    topic search) — meaning "news about the Blazers" works with zero config.
- Fetch with a 5 s `AbortSignal.timeout`, parse, dedupe near-identical
  titles, return `200 { headlines: [{title, source}] }` capped at 8.
  On fetch/parse failure → `502 { error }`.
- Cache the no-topic result in memory for 10 minutes (a household asking
  twice at breakfast shouldn't refetch).

**Client tool `get_news`**:

```js
{
  name: "get_news",
  description: "Get current news headlines, optionally about a topic. Read 3-5 of them " +
    "as a brief spoken news update, paraphrasing naturally — do not read URLs or bylines.",
  parameters: { type: "object", properties: {
    topic: { type: "string", description: "Optional topic, e.g. 'technology', 'Portland'" } },
    required: [] },
}
```

Handler fetches `/api/news`, returns `{ headlines }` or `{ error }`. No UI
card in v1 (headlines are ephemeral; the transcript already shows what was
said).

### 2. Routines

**Storage**: `localStorage["nova.routines"]`, seeded with two defaults on
first load:

```js
{
  "good morning": ["get_weather", "daily_summary", "get_news"],
  "good night":   ["daily_summary", { tool: "play_ambient_sound", args: { sound: "rain" } }],
}
```

Steps are either a tool-name string (no args) or `{ tool, args }`. Only
no-interaction tools are legal in routines — maintain an allowlist
(`get_weather`, `get_news`, `daily_summary`, `play_ambient_sound`,
`control_device`, `manage_list` with `action:"read"`), so a routine can never
sit waiting on geolocation prompts or set surprise alarms.

**New internal helper tool `daily_summary`** (also independently useful for
"what's my day look like?"): returns
`{ timers, alarms, reminders }` filtered to today — pending timers with
remaining minutes, today's alarms, reminders due today (from Plan 1's
`state.reminders`; if Plan 1 hasn't landed, ship without reminders and add a
one-line follow-up).

**New tool `run_routine`**:

```js
{
  name: "run_routine",
  description: "Run a named routine (a saved sequence of skills). Available routines are " +
    "in the result of manage_routine get. When the user says 'good morning' or 'good night', " +
    "run the matching routine and weave the results into ONE natural spoken update.",
  parameters: { type: "object", properties: {
    name: { type: "string" } }, required: ["name"] },
}
```

Handler: look up by case-insensitive name; run steps **sequentially** with
`await toolHandlers[tool](args)`, collecting
`results: [{ step, result }]`; a failing step records `{ step, error }` and
continues. Return the whole array — the model synthesizes the single spoken
update (that's the point: no canned TTS templates).

**New tool `manage_routine`** (voice-editable routines):

```js
{ name: "manage_routine",
  parameters: { properties: {
    action: { enum: ["get", "add_step", "remove_step", "create", "delete"] },
    name: { type: "string" },
    step_tool: { type: "string" }, // validated against the allowlist
  }, required: ["action"] } }
```

Keep it deliberately coarse (append/remove by tool name, no arg editing by
voice v1) — routine arg editing via a settings UI is a later enhancement.

### 3. Instructions (`server.js`)

> When the user greets you with "good morning" or "good night", call
> run_routine with that name if it exists. Present routine results as one
> connected update, not a list of tool outputs: weather first, then today's
> schedule, then a few headlines. Keep the whole update under about 30
> seconds of speech.

### 4. Ordering inside `runTool`

`run_routine` executes handlers directly (not via new function_call rounds),
so the existing `runTool` (app.js:498) flow is untouched: one
`function_call_output` carries the composite result. This keeps latency to
one model round-trip — important for the morning use case.

## Files touched

| File | Change |
|------|--------|
| `lib/rss.js` | new (~60 lines) |
| `server.js` | `/api/news` endpoint + cache + INSTRUCTIONS (~+55 lines) |
| `public/app.js` | `get_news`, `daily_summary`, `run_routine`, `manage_routine` + storage (~+150 lines) |
| `.env.example` | `# NEWS_FEEDS=https://...` comment |
| `README.md` | Try lines ("Good morning", "What's in the news?"), routines section |

## Edge cases

- News feed unreachable → routine continues; model mentions "I couldn't get
  the news right now" because the step result carries `{ error }`.
- `get_weather` inside a routine with no home city and no geolocation grant →
  returns its existing error; acceptable (model says it needs a city). With
  Plan 2 landed this path disappears for configured users.
- Routine names collide with real speech ("good night" mid-conversation as a
  sign-off): the model decides; instructions say to run it — that matches
  Alexa behavior and is what users expect.
- 30 s speech cap: enforced by instruction only; capping `headlines` at 8 and
  summary lists at 5 items keeps the raw material short anyway.

## Verification

1. `curl "localhost:3000/api/news"` → JSON headlines; repeat within 10 min →
   near-instant (cache).
2. "What's in the news about space?" → topical headlines spoken, no URLs.
3. Set a reminder + timer, then "Good morning" → one connected update:
   weather, schedule, headlines.
4. "Add the news to my good night routine" → `manage_routine` fires; "Good
   night" now includes headlines and ends with rain sounds playing.
5. Kill network, "Good morning" → weather+news steps report errors, schedule
   still delivered, no crash.

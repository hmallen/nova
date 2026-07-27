# Plan 10 — Memory archive & learned habits

## Goal

Nova can answer questions about the past ("what was on my shopping list last
week?", "when did I last change the thermostat?") and notices repeated
behavior well enough to offer a preference rather than wait to be told one.

Two layers, built in order, each independently shippable:

- **Tier C — the archive.** An append-only log of structured events and
  overflow conversation, read *only* when the model explicitly asks for it via
  a `recall_memory` tool. It never enters the prompt, so it costs nothing on a
  normal turn no matter how large it grows.
- **Tier D — habits.** A periodic aggregation pass over Tier C's event rows
  that counts patterns and *proposes* facts for Tier A. No LLM involved.

## Context for a fresh session

This plan is the second half of a four-tier memory design; Plan 9 built the
first half. If you're picking this up cold, that's all you need to read first —
this plan assumes its storage conventions and extends them.

| Tier | What it is | Cost per turn | Plan |
|------|-----------|---------------|------|
| A | Curated facts, appended to the system prompt | Always paid | 9 |
| B | Tail of the previous session, replayed on reconnect | Always paid | 9 |
| **C** | **Full history, read on demand via tool call** | **Zero unless called** | **10** |
| **D** | **Offline pattern counting that proposes Tier A facts** | **Zero — runs off-session** | **10** |

The design rests on findings from a research pass, three of which drive
decisions here and are worth stating so they aren't re-litigated:

1. **Frequently-read memory is expensive; rarely-read memory is nearly free.**
   The Realtime API resends the entire conversation on every response, so
   anything in the prompt is paid for on every turn. Tier C's whole reason for
   existing is to be *out* of the prompt.
2. **Models retrieving verbatim history answer when they should decline** —
   measured at 46.7% correct abstention versus 70.0% for a more conservative
   pipeline. A recall tool that returns nothing must say so loudly, or Nova
   will confabulate a plausible answer. See §4.
3. **Aggressive automatic memory writes are measurably more exploitable** —
   roughly double the attack success rate versus conservative designs. This is
   why Tier D proposes and never commits (§7).

## Prerequisites

- **Plan 9** — Tier C reuses `lib/memory.js`, the `source` provenance
  convention, and the `data/` store layout. Tier D's output target is Tier A's
  fact list.
- **Plan 3** — the `data/` directory and its Docker volume.
- **Plan 4** — routines, for routine-run events (soft; Tier C works without
  them, it just records fewer event kinds).

## Before you start

Three unknowns. The first two are measurements you can only take after Tier C
has run for a few days; the third is a product decision.

### A. Will Nova call `recall_memory` when it shouldn't?

**Blocks §4 tuning.** The entire cost argument for Tier C depends on the tool
being called rarely. If the model reaches for it on ordinary questions, every
turn gains an extra model round-trip and the design's main advantage
evaporates.

Instruction tuning alone may not be enough. After wiring the tool, run twenty
ordinary turns — timers, weather, lists, chat — and count `recall_memory`
invocations. Target zero. If it fires on ordinary questions, narrow the tool
description before broadening the query surface; a tool that is hard to
describe narrowly is usually one that should be split.

Log every invocation with its arguments from day one — you cannot tune this
without knowing what triggered it.

### B. How many events per day does this household actually generate?

**Sizes §3.** The v1 read path is a linear scan of month-partitioned JSONL,
which is fine at low thousands of rows per month and not fine at high tens of
thousands. Nobody knows which this is until it runs.

Ship Tier C's write path first, let it run for a week, then measure file size
and row count before building the query path in §4. If a month file exceeds
roughly 50k rows, skip straight to the FTS5 escalation in "Deferred" rather
than building a scan you'll immediately replace.

### C. How should a habit suggestion reach the user?

**Product decision, affects §8.** Tier D produces things like *"you've asked
for the weather around 7am on 9 of the last 14 days."* Options:

- **Silent card in the UI** — a "Nova noticed" card with accept/dismiss.
  Zero interruption, but likely ignored on a device nobody looks at.
- **Nova asks, once** — folded into an existing routine ("…by the way, want me
  to just include the weather when you say good morning?"). Much higher
  response rate, but it makes Nova occasionally initiate, which she never does
  today. That's a real change in character.
- **Both** — ask once, and leave the card as the fallback record.

Pick before building §8. The aggregation and storage work is identical either
way; only the surface differs.

## Design

### 1. Why the archive is not another `createStore`

`createStore` (lib/store.js) rewrites the entire file atomically on every
update. That is exactly right for small mutable state like lists and Tier A
facts, and exactly wrong for a log that only grows: rewriting a year of history
to append one row is O(file) per event, and a multi-megabyte rewrite on every
tool call will eventually collide with the voice path.

Tier C uses `fs.appendFile` instead — O(1) per write, no read-modify-write, no
lost-update window. That's the whole reason it's a separate mechanism rather
than a third key in `memory.json`.

### 2. Storage layout

```
data/archive/
  2026-07.jsonl        # one file per month
  2026-08.jsonl
```

Monthly partitioning does three jobs: it bounds any single scan, it makes
retention a file deletion rather than a rewrite, and it gives "last week"
queries an obvious place to stop reading.

One JSON object per line:

```jsonc
{ "at": "2026-07-26T14:03:11Z",
  "kind": "tool",              // tool | turn | list | device
  "name": "get_weather",       // tool name, or list name, or entity id
  "args": { "location": "Portland" },   // trimmed, see §3
  "ok": true,
  "summary": "72°F, partly cloudy",     // short, human-readable
  "source": "speech",          // speech | routine | derived | external
  "subject": "household" }
```

`source` and `subject` carry the same meaning as Plan 9's facts. `source:
"external"` marks anything containing third-party content — news items in
particular — and is the filter that keeps fetched text from ever being
promoted into a prompt.

### 3. Tier C — capture

One choke point covers nearly everything. `runTool` (app.js:1407) already
wraps every function call the model makes:

```js
async function runTool(name, callId, argsJson) {
  // …existing dispatch…
  archive({ kind: "tool", name, args: redactArgs(name, args), ok: !output?.error,
            summary: summarizeResult(name, output) });
}
```

Two gaps to close deliberately:

- **Routine steps bypass it.** `run_routine` calls handlers directly
  (app.js:778) so the whole routine costs one model round-trip. Record the
  routine as a single event with its step list, not one event per step —
  otherwise every "good morning" writes six near-identical rows and skews
  every count in Tier D.
- **Server-side changes never touch the client.** List edits arriving at
  `PUT /api/lists` from another device, and Home Assistant calls through
  `/api/ha/call`, are written server-side at those handlers.

`archive()` batches into a short queue and flushes on a ~5 s timer and on
`teardown()`, posting to `POST /api/memory/archive`. Fire-and-forget: a failed
flush is dropped, never retried into the voice path, never surfaced.

**Trim before writing, not after.** `redactArgs` keeps only the fields worth
querying later and drops free text. This is not only a size concern — retrieval
quality degrades sharply when a stored record mixes topics. In the research
behind this plan, a focused 340-character record scored 0.57 similarity against
its target query while a 1.5 KB multi-topic record containing the same fact
scored 0.25. One event, one subject.

**Conversation overflow.** Plan 9's `turnBuffer` keeps the last 8 turns for
Tier B and drops the rest. Change that flush to send *all* turns to the
archive as `kind: "turn"` while Tier B continues to hold only the tail. Turns
tagged `source: "external"` (news) are archived but excluded from recall
results by default.

### 4. Tier C — recall

```js
{
  type: "function",
  name: "recall_memory",
  description: "Look up something that happened in the past — what was on a list " +
    "on an earlier date, when a device was last changed, what was discussed days ago. " +
    "Only use this when the user asks about the PAST and you don't already know the " +
    "answer. Never use it for current state — use the normal skill for that.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },     // free text, substring-matched
      kind: { type: "string", enum: ["tool", "turn", "list", "device"] },
      since: { type: "string" },     // ISO date
      until: { type: "string" },
    },
    required: ["query"],
  },
}
```

Server-side: resolve the date range to month files, stream each with a line
reader, filter by `kind`/`source`, case-insensitive substring match on `name` +
`summary` + serialized `args`, return the **most recent 10 matches** with
timestamps. Newest-first, because "last week" questions almost always want the
most recent match.

**The abstention hazard.** When nothing matches, return `{ found: false }`
explicitly — never an empty array, which reads as success. Add to
`INSTRUCTIONS`:

> If `recall_memory` returns `found: false`, say plainly that you don't have a
> record of it. Never guess at what happened, and never infer a past event from
> what's true now.

This matters more than it looks. Models retrieving verbatim history
substantially under-decline on unanswerable questions, and "when did I last
water the plants?" has a confident, wrong, and entirely fabricated answer
available at all times.

**Latency.** A recall costs an extra full model round-trip — the model decides
to call, the call runs, the result returns, the model speaks. Expect 1–2
seconds regardless of how fast the scan is. That's acceptable because it is
rare, and it is the reason §Before-you-start-A is a blocker rather than a
nicety.

### 5. Tier C — retention

Two different clocks, because the two content types carry different risk and
different value:

- **Structured events** (`tool`, `list`, `device`) — keep indefinitely by
  default. They're small, and they are the entire point of "what was on my list
  last week". A year is on the order of a few megabytes.
- **Conversation turns** — keep `ARCHIVE_TURN_RETENTION_DAYS` (default **90**).
  Bulkier, lower query value, and the higher-sensitivity content in an
  always-listening device.

A monthly sweep drops expired turn rows by rewriting affected month files;
whole expired months are deleted outright. Expose `forget everything before
<date>` through the existing `remember` tool's `forget` action rather than
adding a new one.

### 6. Tier D — what counts as a habit

Pure functions over archive rows. No model call, anywhere in this tier.

| Pattern | Rule | Example output |
|---------|------|----------------|
| Time-of-day habit | tool `X` called within a ±30 min window on ≥ 8 of the last 21 distinct days | "usually asks for the weather around 7am" |
| Repeated argument | same argument value for tool `X` in ≥ 6 calls, ≥ 70% of that tool's calls | "usually plays jazz" |
| Recurring purchase | list item added in ≥ 3 distinct weeks of the last 6 | "buys oat milk most weeks" |
| Device habit | same entity set to same state within a ±45 min window on ≥ 6 of 21 days | "turns the porch light on around sunset" |

Every rule requires **distinct days or weeks**, never raw counts — otherwise
one long Saturday of fiddling with lights manufactures a lifelong habit. Every
rule carries its support (`8/21`) so §7 can show its work and §9 can expire it.

These thresholds are guesses. Store them in one exported constants object so
they can be tuned from real data without hunting through logic.

### 7. Tier D — propose, never commit

**The central decision in this plan.** Tier D writes to a `suggestions` array
in `memory.json`, *never* to `facts`:

```jsonc
{ "id": "s_9x2",
  "text": "You usually ask for the weather around 7am",
  "rule": "time_of_day", "support": "8/21",
  "proposedAt": "2026-07-26T03:00:00Z",
  "status": "pending" }        // pending | accepted | dismissed
```

Only an explicit human accept promotes it into a Tier A fact, and that fact is
written with `source: "derived"` so it stays distinguishable from something the
user actually said, forever.

The reasoning is not squeamishness. Tier A facts land in the system prompt, so
a component that writes there automatically is precisely the aggressive-write
pattern that measures roughly twice the memory-poisoning exposure of a
conservative one. Tier D reads from an archive partly populated by external
content; a direct write path from there into the system prompt is the exact
shape of the documented attack. The confirmation step is the mitigation.

Dismissed suggestions are remembered as dismissed, so the same pattern doesn't
resurface every week.

### 8. Tier D — scheduling

A `setInterval` in `server.js` at boot, every `HABIT_SCAN_INTERVAL_H` (default
**6**), with `lastScanAt` persisted so a container restart doesn't trigger an
immediate rescan. No cron, no new container, no new dependency.

Skip the scan entirely if a session is currently live — the pass reads month
files and there is no reason to do that while someone is talking.

### 9. Tier D — decay

Habits end. On each scan, re-evaluate the rule behind every accepted derived
fact against the current window. If support has fallen below half the original
threshold, mark the fact `stale: true` and drop it from the prompt block. Don't
delete it and don't announce it — a habit resuming should simply restore it.

This is also the honest answer to a limitation worth naming: recency-based
supersession handles facts that *changed*, but not facts that quietly stopped
being true. Derived facts are the ones most prone to that, which is why they're
the ones carrying an expiry rule.

## Files touched

| File | Change |
|------|--------|
| `lib/archive.js` | **new** — append, month resolution, line-streaming scan, filter/match, retention sweep (~160 lines) |
| `lib/habits.js` | **new** — pure pattern detectors, thresholds constant, support calculation, decay check (~140 lines) |
| `lib/memory.js` | `suggestions` array; accept/dismiss; `source: "derived"` and `stale` on facts (~+50 lines) |
| `server.js` | `POST /api/memory/archive`, `recall_memory` query endpoint, suggestion accept/dismiss, scan interval, archive writes at the lists PUT and HA call handlers (~+120 lines) |
| `public/app.js` | `archive()` queue + flush, `runTool` instrumentation, routine-level event, `recall_memory` tool + handler, suggestion card (~+150 lines) |
| `public/style.css` | suggestion card |
| `test/archive.test.js` | **new** — append/read round-trip, month boundaries, retention sweep, `found: false` |
| `test/habits.test.js` | **new** — each detector at threshold and one below, distinct-day logic, decay |
| `README.md` | "Try:" recall lines; archive + habits in the architecture list; retention in Notes & limits |
| `.env.example` | `ARCHIVE_TURN_RETENTION_DAYS`, `HABIT_SCAN_INTERVAL_H` |
| `plans/README.md` | plan 10 row |

## Edge cases & decisions

- **Ship Tier C's write path before its read path.** The scan design depends on
  volume nobody can estimate yet (§Before-you-start-B). Capture is useful
  immediately and independently.
- **The archive is append-only and unvalidated on read.** A malformed line is
  skipped, not fatal. A log that can wedge startup is worse than a log with a
  hole in it.
- **No `rev` counter.** Append-only writes have no lost-update problem, so the
  concurrency machinery `createStore` needs doesn't apply.
- **Recall excludes `source: "external"` by default.** News content is archived
  for completeness but is not something Nova should recite back as household
  history.
- **Timers, alarms, and reminders stay per-device** (README, Notes & limits),
  so their events are archived per-device with no attempt to merge. Don't
  quietly turn this into cross-device state.
- **Habit detection is deterministic and unit-testable.** That is the point.
  An LLM asked to spot these patterns would be slower, costlier, non-reproducible,
  and worse at counting.
- **`subject` stays `"household"` throughout.** Per-person habits are a filter
  on the same rows once speaker identity exists.

## Deferred

| Deferred | Build it when |
|----------|---------------|
| FTS5 keyword search over the archive | Substring scan gets slow (§B) or misses obvious matches. Costs one native dependency — `node:sqlite` does not compile FTS5, so this means `better-sqlite3`. |
| Embeddings / `sqlite-vec` | Keyword search fails on paraphrase — "how much did I spend on coffee" against rows saying "espresso". Fuse keyword and vector results by rank (RRF, k=60), not by score. |
| Summarizing old archive spans | Only if retention pressure becomes real. Compressing history loses the verbatim text that makes recall work. |
| Cross-referencing habits with calendar | After habits prove useful on their own. |

## Verification

1. **Capture.** Set a timer, ask the weather, add to a list → three rows in
   `data/archive/<month>.jsonl` with correct `kind`, `at`, and `summary`.
2. **Routine granularity.** Run "good morning" → **one** row, not one per step.
3. **Server-side capture.** Edit a list from a second device → a row appears
   with no client involvement on the first device.
4. **Month boundary.** Hand-write rows into the previous month's file, query
   across the boundary → both months' matches return, newest first.
5. **Recall.** "What was on my shopping list last week?" → `recall_memory`
   fires, answer comes from archived rows.
6. **Abstention.** Ask about something that never happened → `found: false`,
   and Nova says she has no record rather than inventing one. **This is the
   test most likely to fail; treat a confident wrong answer as a blocker.**
7. **Off the default path.** Twenty ordinary turns → zero `recall_memory`
   calls (§Before-you-start-A).
8. **External filter.** Run a routine with news, then ask about "the news last
   week" → conversational rows return, news content does not.
9. **Habit detection.** Seed a month file with a synthetic 7am weather pattern
   on 9 of 21 days → scan produces one pending suggestion with support `9/21`.
   Seed 5 of 21 → no suggestion.
10. **Propose, don't commit.** A pending suggestion appears in `memory.json`
    with `status: "pending"` and **does not** appear in the session's prompt
    block. Accept it → it becomes a fact with `source: "derived"` and appears.
11. **Decay.** Accept a derived fact, seed the following weeks with no matching
    events, rescan → fact marked `stale` and dropped from the block, not
    deleted from the file.
12. **Retention.** Set `ARCHIVE_TURN_RETENTION_DAYS=1`, seed old turn rows,
    trigger the sweep → turn rows gone, structured events untouched.
13. **Degradation.** Delete `data/archive/` mid-run → recall returns
    `found: false`, capture recreates the directory, voice never breaks.

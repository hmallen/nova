# Plan 9 — Persistent memory: profile facts & session rollover

## Goal

Nova remembers open-ended facts about the household ("I'm allergic to
shellfish", "my daughter is Mia") and picks up where it left off after a
dropped connection, a page reload, or the Realtime API's hourly session cap —
instead of starting cold every time.

Two layers, built in order, each independently shippable:

- **Tier A — profile facts.** A curated set of remembered facts, stored
  server-side, appended to the system prompt at session mint alongside today's
  preferences.
- **Tier B — session rollover.** The tail of the previous conversation,
  replayed as text into a brand-new session so "what did I just ask you?"
  works across the gap.

Not in this plan: LLM-driven fact extraction, embeddings, vector search,
summarization, per-person attribution. See "Deliberately deferred" — the
research behind this plan argues most of those are net-negative at household
scale, and the schema here keeps them additive.

## Background: two API facts that shape the design

1. **Sessions end hourly no matter what.** The Realtime API caps a session at
   60 minutes. Rehydration is not a failure handler — it is a routine path that
   runs several times a day even on a perfect LAN.
2. **Everything injected is paid for on every subsequent turn.** The full
   conversation is resent to the model on each response, so a fat rollover
   costs tokens for the rest of the session, not once. Audio costs roughly 10×
   the tokens of the same text, and assistant audio cannot be loaded back at
   all — so rollover is **text only**, and small.

Combined budget target: **≤ 1,500 tokens for Tier A, ≤ 800 for Tier B.**

## Before you start

Three things to settle first. Two are ten-minute checks that change code in
this plan; the third is a product decision only you can make.

### A. Does `role: "system"` work on `conversation.item.create`?

**Blocks §7.** The rollover is injected as a single system-role item because
replaying prior turns as **assistant**-role items makes the model adopt that
message's modality — a documented failure that OpenAI's own compaction cookbook
avoids the same way. But this codebase has never sent a system-role item: the
missed-reminders injection (app.js:1236) uses `role: "user"` with a
`[system event]` text prefix.

Check it directly — start a session, send one item by hand, and see whether the
server accepts it and the model honors it:

```js
sendEvent({
  type: "conversation.item.create",
  item: { type: "message", role: "system",
          content: [{ type: "input_text", text: "The user's cat is named Widget." }] },
});
// then ask "what's my cat called?"
```

Watch for a `conversation.item.created` echo versus an `error` event. If the
API rejects system-role items, rejects `input_text` in that position, or the
model ignores the content, fall back to the proven `role: "user"` +
`[system event]` form used elsewhere in the file. The rollover text is
identical either way; only the envelope changes.

### B. Is there still a cap on `instructions` + tools?

**Sizes §4.** OpenAI's Realtime GA post documents a combined 16,384-token limit
on session instructions plus tool definitions. That figure is scoped to the
superseded `gpt-realtime` model — exactly half its 32,768-token window — and no
current restatement was found for `gpt-realtime-2.1`, which the model page
lists at 128,000 context / 32,000 max output. Nova's tool schemas are already
substantial, so if a 16,384 cap still applies, memory facts compete with tool
definitions for the same budget and the ~1,500-token Tier A target is far
tighter than it looks.

Verify before setting the cap in §4: check the current model reference, then
confirm empirically by minting a session with a deliberately oversized About
block and watching for a rejection at `POST /v1/realtime/client_secrets`. Size
the fact cap against whatever headroom is actually left after `buildTools()`,
not against the context window.

### C. Should text sessions carry forward?

**Product decision, affects §6.** The README currently promises:

> Tap the ring to switch to talking out loud — that starts a fresh voice
> session, so Nova won't remember the typed exchange, the same as after a
> reconnect.

Tier B breaks that promise within the staleness window: type a question, tap
the ring, and Nova now remembers. That is probably what you want — it is the
same continuity the plan exists to provide, and the current behavior is a
limitation being described rather than a feature. But it is a deliberate
change to documented behavior, and there is a reasonable argument the other
way: the typed box is the quiet, private input, and some households may expect
it to leave no trace.

Pick one before building §6:

- **Carry forward** (assumed by this plan) — no code change; rewrite the README
  paragraph in the same PR.
- **Keep text sessions ephemeral** — tag buffered turns with their
  `sessionMode` and exclude `text` turns from rollover, alongside the
  provenance filter. Roughly five extra lines, and the README stands as written.

## Design

### 1. Storage: generalize the existing store

`createStore` (lib/store.js:14) is hardcoded to `{ lists, rev }`. Generalize it
to take a defaults object, keeping the atomic tmp-file+rename write, the
promise-chain serialization, and the monotonic `rev` exactly as they are:

```js
export function createStore(filePath, defaults = { lists: {} }) {
  // load(): shallow-merge parsed keys over `defaults`, keep `rev` handling as-is.
  // update(mutator) → mutator receives current data, returns the new data
  //   object (or null to abort). rev++ per write, unchanged.
}
```

Lists keep their call site (`createStore(path.join(dataDir, "state.json"))`
still defaults to the lists shape). Memory gets a second instance and a second
file — separate blast radius, separate backup, and a corrupt memory file can
never take shopping lists down with it:

```js
const memory = createStore(path.join(dataDir, "memory.json"), { facts: [], rollover: null });
```

Existing `test/` coverage for `store.js` is updated in the same change.

### 2. Data model

```js
// data/memory.json
{
  rev: 7,
  facts: [
    {
      id: "f_k3n8p2",
      text: "Allergic to shellfish",
      subject: "household",          // per-person scoping, later
      source: "speech",              // provenance — see §6
      createdAt: "2026-07-26T14:03:11Z",
      supersededBy: null,            // set instead of deleting
      pinned: false,
    },
  ],
  rollover: {
    endedAt: "2026-07-26T14:31:02Z",
    turns: [ { role: "user" | "assistant", text: "…", tools: ["get_weather"] } ],
  },
}
```

Three fields exist purely to keep later work additive, and all three are
one column now versus a migration later:

- **`subject`** — always `"household"` in this plan. Per-person memory becomes
  a filter, not a rewrite.
- **`source`** — where the fact came from. This is a security control, not
  bookkeeping (§6).
- **`supersededBy`** — contradiction handling. "I moved to Seattle" does not
  delete "I live in Portland"; it points the old fact at the new one. The old
  row stays for history and for "no wait, go back".

### 3. Tier A — writing facts

Facts are written **only by explicit tool call**, mirroring how
`manage_preferences` works today. New tool in `buildTools()`:

```js
{
  type: "function",
  name: "remember",
  description: "Save, list, or forget an open-ended fact about the household — " +
    "allergies, family members, habits, preferences that don't fit a set field. " +
    "Use when the user says 'remember that…', 'don't forget…', 'forget that…'. " +
    "For name, home city, units, or voice use manage_preferences instead.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "list", "forget"] },
      text: { type: "string" },          // add: the fact, in Nova's own words
      replaces: { type: "string" },      // add: id of a fact this supersedes
      id: { type: "string" },            // forget: which fact
    },
    required: ["action"],
  },
}
```

Handler behavior:

- **`add`** — `PUT /api/memory/facts`. Server assigns `id`/`createdAt`, sets
  `source: "speech"`. If `replaces` is given, set `supersededBy` on the old
  fact. Return the saved fact so Nova can confirm in its own words.
- **`list`** — returns active facts; backs "what do you know about me?", which
  should now report facts *and* prefs.
- **`forget`** — soft-delete (`supersededBy: "forgotten"`), so "forget that"
  is recoverable from the file if it misfires.

Deliberate omission: nothing writes facts automatically. Conservative-write
designs measure roughly half the memory-poisoning exposure of aggressive ones,
and an auto-extraction pipeline is the single most attackable component in this
whole design.

### 4. Tier A — reading facts into the prompt

`buildAboutBlock(prefs)` (lib/prefs.js:24) grows a second argument. Prefs and
facts render as one labeled block so the untrusted-input framing that's already
there covers both:

```js
export function buildAboutBlock(prefs = {}, facts = []) {
  // existing prefs lines, then:
  //   Things they've asked you to remember:
  //   - Allergic to shellfish
  //   - Their daughter is Mia
}
```

`sessionConfig(prefs)` (server.js:277) becomes `sessionConfig(prefs, facts)`
and the `POST /api/session` handler (server.js:309) reads active facts from the
memory store before minting. Facts stay server-side — unlike prefs, they are
never posted from the browser, which removes a whole class of injection at the
same time as making them shared across devices.

**Keep appending.** The About block goes at the *end* of `INSTRUCTIONS`
(server.js:282) and must stay there. Prompt caching keys off a stable prefix:
the static instructions cache regardless, and only the tail invalidates when
facts change. Prepending would invalidate the whole prompt on every edit.

**Sort deterministically** by `createdAt`, never by recency-of-use, so an
unchanged fact set produces byte-identical prompt text between sessions and
stays cacheable. Cap the block: 60 facts or ~1,500 tokens, whichever comes
first, dropping oldest unpinned facts and logging what was dropped.

### 5. Tier B — capturing turns

Transcripts already flow through the client. `handleServerEvent`
(app.js:1344) surfaces user text at
`conversation.item.input_audio_transcription.completed` (app.js:1347) and
assistant text at `response.output_audio_transcript.done` (app.js:1364), with
`response.output_text.done` (app.js:1374) covering typed and text-mode turns.
No extra speech-to-text service is needed — the text is already there, feeding
`addMessage`.

Accumulate a bounded ring buffer alongside the on-screen transcript:

```js
let turnBuffer = [];   // { role, text, tools } — last 8 turns, trimmed on push
```

Record which tools ran during a turn (needed by §6). Flush to
`PUT /api/memory/rollover` on a ~5 s debounce and in `teardown()`
(app.js:1321). Debounced flush is what makes this survive an *unclean* drop:
by the time the connection dies, the server already has everything but the last
few seconds.

Writes are fire-and-forget — a failed flush is logged and dropped, never
retried into the voice path.

### 6. Tier B — what is eligible for rollover

Two filters, both load-bearing.

**Staleness.** Only replay if the previous session ended within
`ROLLOVER_MAX_AGE_MIN` (default **30**). A reconnect and a fast page reload
land inside it; yesterday's conversation does not. Without this, the hourly
session cap would silently glue an entire day into one context.

**Provenance.** Drop any turn whose `tools` include a skill that ingests
third-party content — `run_routine` when it includes news, and the news step
itself. `GET /api/news` proxies Google News headlines that Nova reads aloud;
replaying those turns forward is a path for text Nova doesn't control to reach
the next session's context. Weather, calendar, and Home Assistant reads are
low-risk but should carry the same tag so the filter can be tightened without a
schema change.

This is the same reason `source` exists on facts: only `speech`-sourced facts
are ever eligible for the prompt.

### 7. Tier B — injecting on the new session

The rollover rides back on the existing `POST /api/session` response — no extra
round trip on the startup path:

```js
{ client_secret: {...}, rollover: { turns: [...] } | null }
```

Inject in `onDataChannelOpen()` (app.js:1200), after the `session.update` that
registers tools and before the greeting, following the pattern the
missed-reminders block (app.js:1232) already establishes.

Send it as **one item**, not one item per turn:

```js
sendEvent({
  type: "conversation.item.create",
  item: {
    type: "message",
    role: "system",
    content: [{ type: "input_text", text:
      "Earlier in this conversation (the connection dropped and resumed):\n" +
      turns.map(t => `${t.role === "user" ? "User" : "You"}: ${t.text}`).join("\n") +
      "\nContinue naturally. Don't re-greet or recap unless asked." }],
  },
});
```

One item keeps the token budget in one place and sidesteps a documented
failure: replaying prior turns as **assistant**-role items makes the model
adopt that message's modality. OpenAI's own compaction cookbook uses a
system-role item for exactly this reason.

Then adjust the greeting branch (app.js:1257): with a rollover injected, drop
"Sorry, I lost you for a second" in favor of `response.create` with no greeting
instruction at all — the model has the context and should simply be ready. Keep
the apology for a reconnect with no eligible rollover.

### 8. Instructions

Add to `INSTRUCTIONS` (server.js:72):

> If the user asks you to remember something that isn't their name, city,
> units, or your voice, call `remember` to save it — don't just say you will.
> If they tell you something that contradicts a fact you were given, save the
> new one with `replaces` set to the old fact's id.

## Files touched

| File | Change |
|------|--------|
| `lib/store.js` | generalize `createStore(filePath, defaults)` (~10 lines changed) |
| `lib/memory.js` | **new** — fact validation, supersede logic, rollover eligibility, block rendering; all pure (~120 lines) |
| `lib/prefs.js` | `buildAboutBlock(prefs, facts)` (~+15 lines) |
| `server.js` | memory store instance, `/api/memory/facts` + `/api/memory/rollover`, `sessionConfig(prefs, facts)`, rollover on the session response (~+90 lines) |
| `public/app.js` | `remember` tool + handler, `turnBuffer` capture, debounced flush, rollover injection, greeting branch (~+130 lines) |
| `test/memory.test.js` | **new** — supersede chains, staleness window, provenance filter, token cap, block rendering |
| `test/store.test.js` | updated for the generalized signature |
| `test/server.test.js` | memory endpoint smoke tests, path-traversal parity with lists |
| `README.md` | "Try:" lines; memory in the architecture list; update the "won't remember the typed exchange" note (§ Edge cases) |
| `.env.example` | `ROLLOVER_MAX_AGE_MIN` with a comment |
| `plans/README.md` | plan 9 row + dependency note |

## Edge cases & decisions

- **Facts are server-side, prefs stay client-side.** Deliberate: it keeps the
  proven prefs path untouched and ships this plan without a localStorage
  migration. The seam is `buildAboutBlock`, which composes both. Migrating
  prefs into the same store is a later, separate change.
- **Rollover is shared across devices, like lists.** Ask on the kitchen
  tablet, follow up on your phone within the staleness window, and it carries.
  That matches the household-memory goal, and it inherits the same LAN trust
  level the README already documents for lists — worth a line in Notes & limits.
- **Text sessions now carry forward**, assuming you take option C-1 above.
  Either way the README paragraph on typed sessions needs rewriting or
  re-confirming in the same PR — it currently documents the opposite.
- **No summarization in v1.** Turns beyond the last 8 are dropped, not
  compressed. Verbatim text substantially outperforms LLM-distilled artifacts
  in controlled comparison, summarization is itself an exploitable write
  channel, and skipping it means zero extra model calls and zero extra cost.
  Revisit only if the 8-turn window proves too short in practice.
- **Corrupt memory file** follows the store's existing behavior: rename to
  `.bad`, start fresh, never delete. Losing memory must never wedge startup.
- **Voice-only deletion is a footgun.** "Forget that" is soft-delete precisely
  because speech recognition will occasionally mishear which fact was meant.
- **Cap enforcement is server-side.** The browser never decides what goes in
  the prompt.

## Deliberately deferred

Each of these has a concrete trigger; none should be built speculatively.

| Deferred | Build it when |
|----------|---------------|
| Rollover summarization | The 8-turn window demonstrably loses context you needed. Use a cheap text model server-side, off the voice path — never the realtime model. |
| Keyword search over history (FTS5) | You can't find a fact you know you saved. Costs one native dependency: `node:sqlite` does not compile FTS5. |
| Embeddings / `sqlite-vec` | Keyword search fails on paraphrase — you say "how fast", the fact says "speed". Fuse results by rank (RRF, k=60), not by score. |
| Per-person memory | Someone actually complains about shared facts. `subject` is already there. |
| Automatic fact extraction | Probably never. It is the highest-risk, lowest-measured-value component in the design. |

## Verification

1. **Fact round-trip.** "Remember that I'm allergic to shellfish" → `data/memory.json`
   gains a fact with `source: "speech"`. Reconnect → ask "what do you know
   about me?" → Nova reports the fact *and* the existing prefs.
2. **Contradiction.** "Remember I live in Portland", then "actually I moved to
   Seattle" → new fact saved with `replaces` set; the Portland row is still in
   the file with `supersededBy` populated; the prompt block shows Seattle only.
3. **Rollover across a drop.** Ask "what's a good pasta shape for pesto?",
   wait for the answer, kill the network (DevTools offline) until Nova
   reconnects, then ask "what did I just ask you?" → it answers from the
   rollover and does not re-greet.
4. **Rollover across a reload.** Same, but hard-refresh the page instead of
   dropping the network.
5. **Staleness.** Hand-edit `rollover.endedAt` in `memory.json` to two hours
   ago, start a session → no rollover injected, normal greeting.
6. **Provenance filter.** Run "good morning" so a news step executes, reconnect
   within the window → the injected item contains the conversational turns but
   no news turns. Verify by logging the injected item once.
7. **Prompt stability.** Start two sessions with no memory changes between them
   → the generated About block is byte-identical (assert in a unit test, not by
   eye).
8. **Budget.** Seed 200 facts → the block caps at the configured limit, drops
   oldest unpinned first, and logs what it dropped.
9. **Degradation.** Delete `data/memory.json` mid-run, then start a session →
   clean start, no error surfaced to the user. Corrupt it with invalid JSON →
   renamed to `.bad`, session still starts.
10. **Offline write.** Stop the server mid-session → turn-buffer flushes fail
    silently, voice keeps working, no console spam.

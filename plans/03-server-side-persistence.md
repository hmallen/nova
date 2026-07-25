# Plan 3 — Server-side persistence for lists (shared across devices)

## Goal

The shopping list a phone adds to is the same list the kitchen tablet reads.
Move list storage from `localStorage` to a small JSON file store behind two
endpoints in `server.js`, with polling-based sync so multiple open clients
converge within a few seconds. Still zero dependencies.

## Scope decision

Only **lists** move server-side in this plan. Devices stay in localStorage
until Plan 7 replaces them with Home Assistant. Timers/alarms/reminders stay
per-device deliberately — a timer set on the kitchen tablet should ring on
the kitchen tablet (and cross-device ringing needs push, which is out of
scope; noted in README limits).

## Design

### 1. Server store (`server.js` + new `lib/store.js`)

New module `lib/store.js` (ES module, `node:fs`), so Plan 8 can unit-test it:

```js
// lib/store.js
export function createStore(filePath) {
  //  - load(): parse file, return { lists: {...}, rev: number }; on missing
  //    file or parse error return { lists: {}, rev: 0 } (corrupt file is
  //    renamed to state.json.bad, not deleted)
  //  - update(mutator): serialize writes through a promise chain; mutator
  //    receives the current data, returns new lists; rev++ on every write;
  //    atomic write: write to <file>.tmp then fs.renameSync over the original
  //  - get(): current in-memory data (file is read once at boot)
}
```

- Data file: `data/state.json` (`data/` created on boot with
  `mkdirSync(recursive: true)`; add `data/` to `.gitignore`).
- `rev` is a monotonically increasing integer used for cheap change detection
  by polling clients — no timestamps, no per-item versions.
- Single Node process, promise-chain serialization → no cross-write races.

### 2. Endpoints (`server.js`)

Reuse the `readBody(req)` helper from Plan 2 (or introduce it here if this
lands first — whichever merges second rebases).

- `GET /api/lists` → `200 { rev, lists }`.
  Optional `?since=<rev>`: if store rev equals `since`, return `304` with no
  body — keeps the poll nearly free.
- `PUT /api/lists` → body `{ rev, lists }`. If `body.rev !== store.rev`,
  return `409 { rev, lists }` (current server state) — the client re-applies
  its change on top (see §3). Otherwise commit, `200 { rev }`.
  Validate: `lists` is an object of `string → string[]`, item length ≤ 200,
  ≤ 100 items/list, ≤ 20 lists; else `400`.

No auth: the server is LAN-local and already gates nothing else; note in
README that anyone on the LAN can edit lists (same trust level as an Echo on
your network).

### 3. Client changes (`public/app.js`)

Replace the two `localStorage` list touchpoints:

- **State shape**: `state.lists` stays the same object; add
  `state.listsRev = 0`.
- **Boot**: `GET /api/lists`. If server lists are empty **and**
  `localStorage["nova.lists"]` has items → one-time migration: PUT the local
  lists, then delete the localStorage key. Otherwise adopt server state.
  If the fetch fails (server restarted mid-session, etc.), fall back to
  localStorage copy and set `state.listsOffline = true`.
- **`manage_list` handler** (app.js:265): after mutating `state.lists`
  locally (keep the optimistic local mutation — voice UX must not wait on
  disk), fire-and-await `PUT /api/lists { rev: state.listsRev, lists }`.
  - On `200`: update `state.listsRev`.
  - On `409`: adopt the returned server lists, **re-apply the user's single
    action** (re-run the same switch-case against the fresh state), and PUT
    again with the new rev — one retry, then give up and return
    `{ ok: true, warning: "saved locally, sync conflict" }`.
  - On network error: keep local state, mirror to localStorage as a crash
    backup, return `ok: true` (voice flow shouldn't fail because the tablet's
    Wi-Fi blipped) but set `state.listsOffline = true`.
- **Polling**: `setInterval` every 4 s **only while the page is visible**
  (`document.visibilityState === "visible"`; also poll once on
  `visibilitychange` → visible): `GET /api/lists?since=state.listsRev`; on a
  200 (rev changed) adopt + `renderLists()`. 4 s is fast enough for the
  "added on phone, ask the tablet" flow.
- **UI**: small "offline — changes saved locally" badge on the Lists card
  when `listsOffline` (clears on the next successful request).

### 4. Concurrency story (why this is enough)

Voice edits are single-item and rare; the 409-retry covers the realistic
conflict (two people adding items within the same few seconds) because
re-applying an `add` on top of fresh state is always safe. `remove`/`clear`
re-application is idempotent. No CRDT needed; say so in a comment.

## Files touched

| File | Change |
|------|--------|
| `lib/store.js` | new (~70 lines) |
| `server.js` | two endpoints + store wiring (~+60 lines) |
| `public/app.js` | boot sync, manage_list rewrite, polling, offline badge (~+90/-15 lines) |
| `public/style.css` | offline badge style |
| `.gitignore` | `data/` |
| `README.md` | architecture diagram note, LAN-trust limitation |

## Edge cases

- Server restart wipes nothing (file-backed); in-flight PUT during restart →
  network error path → localStorage backup → re-synced by the next poll+PUT.
- Two tabs in one browser: both poll; the 409 path handles their races.
- `?since` param must be parsed as integer; garbage → treat as 0 (full 200).
- JSON file hand-edited to invalid JSON while running: store never re-reads
  after boot, so no runtime impact; on next boot the `.bad` rename path runs.

## Verification

1. Add "milk" by voice → `data/state.json` contains it.
2. Open a second browser (or incognito) → list shows milk within 4 s of
   adding "eggs" in the first.
3. Kill the server, add "butter" by voice → Nova still confirms, offline
   badge appears; restart server → within one poll+next-edit cycle butter is
   in `state.json` (verify the re-sync PUT happens on next successful poll —
   implement: when a poll succeeds while `listsOffline`, PUT local state).
4. Simulate 409: `curl` a PUT with a stale rev → server returns 409 + current
   state.
5. First run with old localStorage lists → they appear in `state.json`
   (migration) and the localStorage key is gone.

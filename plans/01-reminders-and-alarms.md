# Plan 1 — Reminders, recurring alarms, snooze & timekeeping persistence

## Goal

Close the biggest gap vs. a real Alexa: "Remind me to take the chicken out at
5", "Wake me at 7 on weekdays", "Snooze", and timers/alarms that survive a
page refresh. All work is in `public/app.js` plus small copy updates in
`server.js` (INSTRUCTIONS) and `README.md`.

## Current state (what we build on)

- `state.timers` / `state.alarms` (app.js:33–34) are in-memory only — a
  refresh wipes them.
- A 500 ms engine loop (app.js:525–545) fires timers by `endsAt` and alarms
  by exact `HH:MM` string match, calls `onTimerFired(t)` (app.js:547) which
  plays a chime and injects a `[system event]` conversation item so Nova
  announces it, then auto-clears the entry after 30 s.
- `cancel_timer_or_alarm` filters both arrays by label substring.

## Design

### 1. Data model changes

Extend the two arrays into one unified concept internally but keep separate
arrays (less churn in `renderTimers`):

```js
// timer:    {id, kind:"timer",    label, endsAt, done}
// alarm:    {id, kind:"alarm",    label, time:"HH:MM", days:[0..6]|null,
//            done, lastFiredOn:"YYYY-MM-DD"|null}
// reminder: {id, kind:"reminder", text, at:epochMs, done}
```

- `days`: array of JS weekday numbers (0=Sun). `null`/absent = one-shot
  (current behavior). A recurring alarm is **never auto-removed** and `done`
  is not used; instead `lastFiredOn` guards against re-firing within the same
  day+minute.
- Reminders are stored in a new `state.reminders` array and use an absolute
  epoch timestamp so "tomorrow at 3pm" and "in 20 minutes" both work with one
  representation. The **model** resolves natural language to a timestamp — the
  tool takes an ISO local datetime string (see schema below) because
  `get_current_datetime` already gives the model "now" and the timezone.

### 2. New/changed tools

**New: `set_reminder`**

```js
{
  type: "function",
  name: "set_reminder",
  description: "Set a reminder that Nova will announce at a specific time. " +
    "Resolve relative phrases ('in 20 minutes', 'tomorrow at 3pm') to an " +
    "absolute local datetime yourself; call get_current_datetime first if " +
    "you don't know the current time.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "What to remind the user about, phrased as said: 'take the chicken out'" },
      datetime: { type: "string", description: "Local datetime YYYY-MM-DDTHH:MM" },
    },
    required: ["text", "datetime"],
  },
}
```

Handler: parse with `new Date(datetime)` (local-time semantics for that
format); reject past times with `{ error }` so the model asks a follow-up.

**Changed: `set_alarm`** — add optional `days`:

```js
days: { type: "array", items: { type: "string",
  enum: ["sun","mon","tue","wed","thu","fri","sat"] },
  description: "For a repeating alarm, e.g. weekdays = [mon,tue,wed,thu,fri]. Omit for one-time." }
```

Handler maps names → numbers. Spoken confirmation includes the recurrence
("Alarm set for 7 AM, Monday through Friday").

**New: `snooze`**

```js
{
  name: "snooze",
  description: "Snooze the alarm, timer, or reminder that is currently ringing or just rang.",
  parameters: { type: "object", properties: {
    minutes: { type: "number", description: "Default 9" } }, required: [] },
}
```

Handler: track the most recent fired entry in a module-level
`lastFired = {kind, label, at}` set inside `onTimerFired`. Snooze stops the
chime, and re-arms: for timers/alarms it creates a one-shot timer labeled
`"snoozed <label>"`; for reminders it shifts `at` forward and clears `done`.
If nothing fired in the last 5 minutes, return
`{ error: "Nothing to snooze." }`.

**Changed: `cancel_timer_or_alarm`** — description now mentions reminders and
the handler also filters `state.reminders` (matching on `text`). Consider
renaming the tool to `cancel_scheduled` — **don't**: keep the name stable and
just widen the description, so existing prompt phrasing keeps working.

### 3. Engine loop changes (app.js:525)

- Timers: unchanged.
- Alarms: fire when `a.time === hhmm` **and** (`!a.days` ? `!a.done` :
  (`a.days.includes(now.getDay())` and `a.lastFiredOn !== todayStr`)).
  On fire: one-shots set `done=true` (existing auto-clear removes them);
  recurring set `lastFiredOn = todayStr` and are *not* removed by the
  auto-clear timeout in `onTimerFired` (guard on `t.days`).
- Reminders: fire when `!r.done && now >= r.at`. The injected system-event
  text differs: `The reminder "<text>" is due. Say: "This is your reminder
  to <text>."` — so Nova's phrasing matches Alexa's.
- Persist on every mutation (see §4), including `done`/`lastFiredOn` flips.

### 4. Persistence across refresh

New helpers next to the existing localStorage usage:

```js
function saveSchedules() {
  localStorage.setItem("nova.schedules", JSON.stringify({
    timers: state.timers, alarms: state.alarms, reminders: state.reminders }));
}
```

Load at startup (merge into `state` before the initial `renderTimers()`):

- Timers whose `endsAt` already passed while the page was closed: drop
  silently if > 60 s past, otherwise fire immediately (chime only — there is
  no session yet, so skip the conversation-item injection when
  `connected === false`; `onTimerFired` already guards with `if (connected)`).
- One-shot alarms with `done: true`: drop. Recurring alarms: always keep.
- Reminders > 60 s past due: keep but mark as `missed: true` and render dimmed
  with "missed" so the user sees it; announce missed reminders once at the
  start of the next session (inject one summary conversation item from
  `onDataChannelOpen` if any `missed` reminders exist, then clear the flag).

Call `saveSchedules()` from every handler that mutates the three arrays and
from the engine loop when `changed`.

### 5. UI (`renderTimers` in app.js:759 + `index.html`)

- Reminders render in the existing Timers & Alarms card with a 🔔 icon and
  the due time formatted via `toLocaleString` (drop the date part when it's
  today). Rename the card heading to "Timers, Alarms & Reminders".
- Recurring alarms show their day pattern compactly: `7:00 · M–F` (build a
  short label: consecutive-run collapsing is a nice-to-have; `M T W T F` is
  acceptable v1).
- Missed reminders: `.timer-done`-style dimming plus the word "missed".

### 6. Instructions (`server.js` INSTRUCTIONS)

Add one capability sentence:

> You can also set reminders ("remind me to X at Y"), repeating alarms, and
> snooze whatever just rang. When a reminder fires, announce it as "This is
> your reminder to …".

## Files touched

| File | Change |
|------|--------|
| `public/app.js` | new tools + handlers, engine loop, persistence, lastFired tracking, render updates (~+180 lines) |
| `public/index.html` | card heading text |
| `server.js` | one INSTRUCTIONS sentence |
| `README.md` | new "Try:" lines (remind me…, weekday alarm, snooze) |

## Edge cases

- Two alarms with the same time: both fire; `lastFiredOn` is per-entry.
- "Cancel my 7 AM alarm" — model passes `label`; if the user labeled nothing,
  labels default to "alarm", so matching may over-cancel. Widen matching:
  also match alarms whose `time` renders to a string containing the label's
  digits (e.g. "7:00"). Cheap heuristic, worth it.
- Snooze during an *ambient sound*: `stopChime()` only — don't stop ambient.
- DST: alarms are wall-clock (`HH:MM` string compare) so they inherently
  follow local clock changes — correct behavior, note it in a comment.
- Model sends `datetime` without minutes or as UTC ISO with `Z`: validate
  with a regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}` and reject otherwise.

## Verification

1. `npm start`, connect, "Remind me to stretch in 1 minute" → reminder card
   appears; at T+60 s chime + spoken "This is your reminder to stretch."
2. "Set an alarm for <2 minutes from now> on weekdays" → fires (if today is a
   weekday), stays in the list afterwards, `lastFiredOn` set; refresh page →
   alarm still listed.
3. "Snooze" right after → chime stops, "snoozed" timer appears.
4. Set a 15 s timer, refresh at 10 s → timer survives and fires on time.
5. Set a reminder 1 min out, close the tab, reopen after it's due → shows
   "missed"; start a session → Nova mentions the missed reminder once.

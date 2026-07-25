# Plan 5 — Session robustness & text input

## Goal

Two independent quality-of-life upgrades to the session layer in
`public/app.js`:

1. **Auto-reconnect** — a Wi-Fi blip shouldn't end the conversation with
   "tap the ring to reconnect".
2. **Text input** — a typed message box as an accessibility / quiet-hours /
   debugging path that reuses the same session and tools.

## Part A — Auto-reconnect

### Current behavior

`pc.onconnectionstatechange` (app.js:363) tears everything down via
`stopSession("Connection lost — tap the ring to reconnect")`. The README
documents that Realtime has **no session resume** — so "reconnect" means a
brand-new session; the goal is doing that automatically and gracefully.

### Design

- New module-level `reconnectAttempts = 0`, and a `userStopped` flag set only
  by the ring-click stop path so intentional stops never auto-reconnect.
- In `onconnectionstatechange`, on `failed`/`disconnected`/`closed` while
  `connected && !userStopped`:
  - tear down (existing `stopSession` internals, but factor the teardown out
    of `stopSession` into `teardown()` so we can reuse it without the
    idle-UI/wake-word side effects),
  - if `reconnectAttempts < 2`: set ring state `connecting`
    ("Reconnecting…"), wait `1000 * 2^attempts` ms, `startSession()` again.
  - else: fall back to today's terminal message.
- On any successful `onDataChannelOpen`, reset `reconnectAttempts = 0` —
  but **only after** the channel opens, so a mint-token failure loop can't
  spin (startSession's catch path must not reset it).
- **Greeting on reconnect**: replace the greeting `response.create`
  (app.js:416–421) instructions when `wasReconnect` with:
  "Say only: 'Sorry, I lost you for a second.'" — so the assistant
  acknowledges rather than re-greeting from scratch. Conversation *history*
  is gone (no resume); that's acceptable and worth one README sentence.
- `disconnected` can self-heal in WebRTC; before tearing down on
  `disconnected` specifically, wait 3 s and re-check `pc.connectionState`
  (a timer that aborts if the state returns to `connected`).

### Also: mint-token retry

`startSession` currently fails hard if `POST /api/session` fails (server
briefly restarting). Wrap the token fetch in one retry after 1 s before
surfacing the error.

## Part B — Text input

### Design

- **UI** (`index.html` + `style.css`): a slim form under the transcript:
  `<form id="textForm"><input id="textInput" placeholder="Type to Nova…"><button>Send</button></form>`.
  Always visible; when no session is live, submitting **starts one** (see
  below) rather than erroring — the box doubles as a mouse-free way to wake
  Nova.
- **Send path** (new function next to `sendEvent`):

  ```js
  function sendTypedMessage(text) {
    addMessage("user", text);            // transcript immediately
    sendEvent({ type: "conversation.item.create",
      item: { type: "message", role: "user",
              content: [{ type: "input_text", text }] } });
    sendEvent({ type: "response.create" });
  }
  ```

  The response comes back as **speech + transcript** exactly like a spoken
  turn — no output-mode changes needed, and tool calls work identically since
  they ride the same data channel.
- **Submitting while disconnected**: store the text in `pendingTypedMessage`,
  call `startSession()`, and in `onDataChannelOpen` — after the
  `session.update` — send it *instead of* the greeting `response.create`
  (the user asked a question; answering it is the greeting).
- **Interaction with semantic VAD**: typing while Nova is mid-speech should
  behave like barge-in — before sending, if `assistantSpeaking`, send
  `{ type: "response.cancel" }` first.
- Keep the mic flow primary: no autofocus on page load (mobile keyboards
  popping up unprompted would hurt the tablet use case).

## Files touched

| File | Change |
|------|--------|
| `public/app.js` | teardown/refactor, reconnect logic, token retry, text send path (~+90 lines) |
| `public/index.html` | text form |
| `public/style.css` | form styling |
| `README.md` | reconnect + text-input notes ("history doesn't survive a reconnect") |

## Edge cases

- Reconnect fires while the tab is backgrounded: timers still run in most
  browsers at reduced resolution; acceptable. Don't reconnect when
  `document.visibilityState === "hidden"` — defer until `visibilitychange`
  (avoids burning tokens on a session in a tab nobody's looking at).
- Ephemeral token expired between mint and SDP exchange after a slow retry
  wait: SDP exchange fails → caught by the same reconnect path (counts as an
  attempt).
- Text sent during the `connecting` state: queue in `pendingTypedMessage`
  (last-write-wins is fine; it's one input box).
- Empty/whitespace submit: ignore.

## Verification

1. Start a session, toggle OS Wi-Fi off/on → ring shows "Reconnecting…",
   then Nova says "Sorry, I lost you for a second." Mic works after.
2. Toggle Wi-Fi off and leave it off → two spaced attempts, then the
   terminal idle message.
3. Click the ring to stop → **no** reconnect attempt fires.
4. Type "set a 1 minute timer" with no session → session starts, timer set,
   spoken confirmation; timer card appears.
5. Type while Nova is talking → she stops and answers the typed message.
6. Stop the server, click ring → after ~1 s retry it either connects (server
   back) or shows a clean error.

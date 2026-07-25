# Plan 6 — PWA & mobile support

## Goal

Nova installs to a phone/tablet home screen and launches full-screen like a
real assistant appliance. This requires (a) a web app manifest + icons,
(b) a minimal service worker, and (c) solving the real blocker for household
use: **microphone access requires a secure context**, and a tablet hitting
`http://<desktop-ip>:3000` doesn't have one. So this plan includes optional
HTTPS in `server.js`.

## Part A — HTTPS support (the enabler)

`getUserMedia` and the wake-word SpeechRecognition only work on `localhost`
or HTTPS. For any second device on the LAN, HTTPS is mandatory — ship it
first or the PWA is desktop-only.

### server.js changes

```
# .env additions
# HTTPS_CERT=./certs/nova.pem      # enable HTTPS by setting both
# HTTPS_KEY=./certs/nova-key.pem
```

- If both are set: `import { createServer } from "node:https"` with the
  key/cert read at boot, listen on `PORT` (same var); log the `https://` URL
  and the machine's LAN IPs (`os.networkInterfaces()`) so the user knows what
  to type on the tablet.
- If unset: exactly today's HTTP behavior.
- Refactor: the request handler is already a standalone function passed to
  `http.createServer` — just choose which `createServer` wraps it.

### Docs (README "Use it on a tablet/phone" section)

- Recommend [mkcert](https://github.com/FiloSottile/mkcert):
  `mkcert -install && mkcert <lan-ip> localhost` → two files → point the env
  vars at them → install the mkcert root CA on the tablet (mkcert's
  documented mobile flow). This is the honest, working path; self-signed
  without a trusted CA fails silently for service workers, so don't suggest it.

## Part B — Manifest & icons

- `public/manifest.json`:

  ```json
  {
    "name": "Nova Voice Assistant", "short_name": "Nova",
    "start_url": "/", "display": "standalone",
    "background_color": "#0b0f14", "theme_color": "#0b0f14",
    "icons": [{ "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
              { "src": "icon-512.png", "sizes": "512x512", "type": "image/png" },
              { "src": "icon-maskable-512.png", "sizes": "512x512",
                "type": "image/png", "purpose": "maskable" }]
  }
  ```

  (Match `background_color` to the actual page background in `style.css` —
  read it, don't guess.)
- Icons: generate the ring logo (already an inline SVG favicon in
  index.html:8) as PNGs at 192/512 + a maskable variant with safe-zone
  padding. Generate once with a throwaway script (canvas in the browser or
  any tool) and commit the PNGs — no build step.
- `index.html`: `<link rel="manifest">`, `<meta name="theme-color">`,
  `apple-touch-icon` link (iOS ignores manifest icons), and
  `<meta name="apple-mobile-web-app-capable" content="yes">`.

## Part C — Service worker

Keep it deliberately dumb — this app is useless offline (the whole point is
a live OpenAI session), so the SW exists only to satisfy installability and
to make loads instant:

- `public/sw.js`:
  - `install`: pre-cache the static shell (`/`, `app.js`, `style.css`,
    `manifest.json`, icons) into cache `nova-v1`.
  - `fetch`: **network-first, cache fallback** for same-origin GETs; never
    touch `/api/*` or cross-origin (OpenAI/Open-Meteo) requests — pass
    through untouched.
  - `activate`: delete old `nova-*` caches. Bump the cache name string
    whenever shell files change (documented in a comment; acceptable
    hand-managed versioning for a 3-file shell).
- Registration in `app.js`, guarded:
  `if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js")`.

## Part D — small mobile CSS pass

- Verify (browser preview at 375×812 via the existing launch.json server):
  ring size, cards stacking, transcript height, the Plan 5 text input not
  being covered by the keyboard (`viewport-fit=cover` +
  `env(safe-area-inset-bottom)` padding on the form).
- `touch-action: manipulation` on `#ring` and `.pill` to kill the 300 ms
  tap delay / double-tap zoom on the primary control.
- Wake-word note: Web Speech API on iOS Safari is unavailable/limited —
  `wakeBtn` already degrades ("Wake word unsupported here"); confirm that
  path renders sensibly on iOS rather than erroring.

## Files touched

| File | Change |
|------|--------|
| `server.js` | HTTPS option + LAN IP logging (~+30 lines) |
| `public/manifest.json`, `public/sw.js`, 3 icon PNGs | new |
| `public/index.html` | manifest/meta/apple links, SW-safe viewport meta |
| `public/app.js` | SW registration (3 lines) |
| `public/style.css` | safe-area + touch tweaks |
| `.env.example` | HTTPS_CERT / HTTPS_KEY comments |
| `README.md` | "Use it on a tablet" walkthrough |

## Edge cases

- SW caching a stale `app.js` during development: network-first ordering
  means dev serves fresh files whenever the server is reachable — the
  annoying stale-SW dev loop mostly doesn't apply. Mention
  "unregister via devtools" in a README dev note anyway.
- `display: standalone` removes the URL bar → mic permission prompts still
  appear (fine), but there's no reload button: the Plan 5 reconnect logic is
  what makes standalone mode livable. Note the soft dependency.
- HTTP fallback on a second device: page loads but mic fails —
  `startSession`'s existing error path shows the mic-blocked message, which
  is misleading here. Add a boot check: if `!window.isSecureContext`, set
  status text to "Needs HTTPS for the microphone — see README" and disable
  the ring.

## Verification

1. Desktop Chrome: Lighthouse PWA checks pass (installable, manifest,
   SW registered); install → standalone window opens, ring works.
2. mkcert setup on LAN → tablet loads `https://<ip>:3000`, mic prompt
   appears, session works, Add-to-Home-Screen produces a full-screen app.
3. Airplane-mode the tablet after one load → app shell still opens (cache
   fallback), shows the connection error cleanly rather than a browser
   dinosaur.
4. `http://<ip>:3000` from a second device → the "Needs HTTPS" status shows
   instead of a dead mic prompt.

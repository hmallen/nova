// User-preference validation and prompt building (Plan 8, extracted from
// server.js so it can be unit-tested as pure string-in/string-out logic).

// Voices the client may request via saved preferences (mirrored in app.js).
export const ALLOWED_VOICES = ["marin", "cedar", "alloy"];

// Prefs arrive from the browser and get spliced into the system prompt —
// treat as untrusted: allowlist enums, truncate free text, strip newlines.
// That plus the clearly labeled block in buildAboutBlock is sufficient
// prompt-injection hygiene for a self-hosted LAN app.
export function sanitizePrefs(raw) {
  const prefs = {};
  if (!raw || typeof raw !== "object") return prefs;
  const clean = (s) => String(s).replace(/[\r\n]+/g, " ").trim().slice(0, 60);
  if (typeof raw.name === "string" && raw.name.trim()) prefs.name = clean(raw.name);
  if (typeof raw.homeLabel === "string" && raw.homeLabel.trim()) prefs.homeLabel = clean(raw.homeLabel);
  if (raw.units === "fahrenheit" || raw.units === "celsius") prefs.units = raw.units;
  if (ALLOWED_VOICES.includes(raw.voice)) prefs.voice = raw.voice;
  return prefs;
}

// "About this user" block appended to the base instructions — empty string
// when there is nothing to say.
export function buildAboutBlock(prefs = {}) {
  const about = [];
  if (prefs.name) about.push(`- Name: ${prefs.name} — address them by name occasionally, not every turn.`);
  if (prefs.homeLabel) about.push(`- Home: ${prefs.homeLabel} — assume this for weather and time-of-day context.`);
  if (prefs.units) about.push(`- Units: ${prefs.units}.`);
  if (!about.length) return "";
  return `\n\nAbout this user (from saved preferences):\n${about.join("\n")}`;
}

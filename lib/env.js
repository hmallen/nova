// Minimal .env parsing (Plan 8, extracted from server.js) so no dotenv
// dependency is needed. Supports KEY=value lines, optional single/double
// quotes around the value, comments, and CRLF (Windows) line endings.

// parseEnv(text) → { KEY: value, ... }
export function parseEnv(text) {
  const out = {};
  if (typeof text !== "string") return out;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

// Copy parsed vars into env; variables already present in env win, so real
// environment variables always override the .env file.
export function applyEnv(parsed, env = process.env) {
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in env)) env[key] = value;
  }
  return env;
}

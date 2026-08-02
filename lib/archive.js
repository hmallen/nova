// Tier C — the memory archive (Plan 10).
//
// An append-only log of what happened, read *only* when the model explicitly
// asks for it. It never enters the system prompt, so it costs nothing on a
// normal turn no matter how large it grows — which is the whole reason it
// exists as a separate mechanism from lib/store.js. createStore rewrites its
// entire file on every update; that's right for a small mutable document and
// wrong for a log that only grows, where appending one row would cost O(file).
//
// One JSON object per line, one file per month:
//
//   data/archive/2026-08.jsonl
//
// Monthly partitioning bounds any single scan, makes retention a file
// deletion rather than a rewrite, and gives "last week" queries an obvious
// place to stop reading.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export const ARCHIVE_KINDS = ["tool", "turn", "list", "device"];
// Provenance, same vocabulary as Plan 9's facts. "external" marks anything
// carrying third-party content — news items in particular — and is the filter
// that keeps fetched text from ever being recited back as household history.
export const ARCHIVE_SOURCES = ["speech", "routine", "derived", "external"];

export const MAX_NAME_CHARS = 80;
export const MAX_SUMMARY_CHARS = 200;
export const MAX_ARGS_CHARS = 240;
export const MAX_ARGS_KEYS = 8;
export const MAX_BATCH_EVENTS = 60;
export const RECALL_LIMIT = 10;
export const DEFAULT_TURN_RETENTION_DAYS = 90;
// The v1 read path is a linear scan, which is fine at low thousands of rows
// per month and not fine at high tens of thousands. Rather than leave the
// measurement in plans/10 "Before you start" B to someone remembering to run
// it, the scan reports its own size once it crosses the line where the FTS5
// escalation becomes worth its native dependency.
export const SCAN_ROW_WARN = 50_000;

const MONTH_FILE_RE = /^(\d{4}-\d{2})\.jsonl$/;

export function monthOf(iso) {
  return String(iso || "").slice(0, 7);
}

function monthFileName(month) {
  return `${month}.jsonl`;
}

// Months that actually exist on disk, oldest first. A missing directory is a
// normal state (nothing has happened yet), not an error.
export function archiveMonths(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map(name => MONTH_FILE_RE.exec(name)?.[1])
    .filter(Boolean)
    .sort();
}

// Byte size per month — the cheap half of the volume measurement above,
// logged at boot so growth is visible without opening anything.
export function archiveStats(dir) {
  return archiveMonths(dir).map((month) => {
    let bytes = 0;
    try { bytes = fs.statSync(path.join(dir, monthFileName(month))).size; } catch {}
    return { month, bytes };
  });
}

// Only scalars survive, and only until the budget runs out. Trimming happens
// before the write rather than after: retrieval quality degrades sharply when
// one stored record mixes topics, so a row that has grown a free-text field is
// worse than a row missing it. One event, one subject.
function sanitizeArgs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out = {};
  let budget = MAX_ARGS_CHARS;
  for (const key of Object.keys(raw).slice(0, MAX_ARGS_KEYS)) {
    const value = raw[key];
    const kind = typeof value;
    if (kind !== "string" && kind !== "number" && kind !== "boolean") continue;
    if (kind === "number" && !Number.isFinite(value)) continue;
    const clean = kind === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 120) : value;
    if (clean === "") continue;
    const cost = key.length + String(clean).length + 6; // quotes, colon, comma
    if (cost > budget) continue;
    budget -= cost;
    out[key] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}

const trim = (value, max) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

// Shape check for anything arriving at POST /api/memory/archive. Returns the
// row to write, or null to drop it.
//
// `at` is stamped here rather than taken from the body, for the same reason
// sanitizeRollover stamps `endedAt`: a device with a wrong clock would
// otherwise poison every time-of-day habit in Tier D, silently and forever.
export function sanitizeEvent(raw, { now = Date.now } = {}) {
  if (!raw || typeof raw !== "object") return null;
  if (!ARCHIVE_KINDS.includes(raw.kind)) return null;
  const name = trim(raw.name, MAX_NAME_CHARS);
  const summary = trim(raw.summary, MAX_SUMMARY_CHARS);
  if (!name && !summary) return null; // nothing queryable — not worth a row
  const args = sanitizeArgs(raw.args);
  return {
    at: new Date(now()).toISOString(),
    kind: raw.kind,
    name,
    ...(args ? { args } : {}),
    ...(typeof raw.ok === "boolean" ? { ok: raw.ok } : {}),
    summary,
    source: ARCHIVE_SOURCES.includes(raw.source) ? raw.source : "speech",
    subject: "household", // per-person scoping later becomes a filter, not a rewrite
  };
}

// Appends already-sanitized rows, grouped so a batch spanning midnight on the
// 1st lands in both months. Creates the directory if it went missing — losing
// the archive must degrade capture, never break it.
export async function appendEvents(dir, events = []) {
  if (!events.length) return 0;
  const byMonth = new Map();
  for (const event of events) {
    const month = monthOf(event.at);
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    byMonth.set(month, (byMonth.get(month) || "") + JSON.stringify(event) + "\n");
  }
  if (!byMonth.size) return 0;
  await fsp.mkdir(dir, { recursive: true });
  for (const [month, lines] of byMonth) {
    await fsp.appendFile(path.join(dir, monthFileName(month)), lines, "utf8");
  }
  return events.length;
}

// Every line of one month, malformed lines skipped. A log that can wedge
// startup is worse than a log with a hole in it.
async function eachRow(dir, month, visit) {
  const file = path.join(dir, monthFileName(month));
  let stream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
  } catch {
    return 0;
  }
  let rows = 0;
  try {
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      rows++;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row && typeof row === "object") visit(row);
    }
  } catch {
    // Unreadable mid-file (deleted under us, bad bytes): keep what we have.
  } finally {
    stream.destroy();
  }
  return rows;
}

// Every token of the query has to appear somewhere in the row. Substring
// matching on the whole phrase would miss "shopping list" against a row that
// stores { list: "shopping" } with summary "added milk" — the fields are
// separate, the user's phrasing isn't.
function matcher(query) {
  const tokens = String(query || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  if (!tokens.length) return () => true;
  return (row) => {
    const hay = `${row.name || ""} ${row.summary || ""} ${row.args ? JSON.stringify(row.args) : ""}`.toLowerCase();
    return tokens.every(token => hay.includes(token));
  };
}

function inRange(at, since, until) {
  if (typeof at !== "string") return false;
  if (since && at < since) return false;
  if (until && at > until) return false;
  return true;
}

// Resolve an ISO date (or datetime) to a bound comparable against `at`.
// "2026-07-20" as an `until` means the end of that day, not its first instant.
function bound(value, end) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return end ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// The recall read path. Newest-first, because "last week" questions almost
// always want the most recent match.
//
// Returns { found: false } when nothing matches — never an empty array, which
// reads to the model as success. Models retrieving verbatim history
// substantially under-decline on unanswerable questions, and "when did I last
// water the plants?" has a confident, wrong, entirely fabricated answer
// available at all times.
export async function scanArchive(dir, {
  query = "",
  kind = null,
  since = null,
  until = null,
  limit = RECALL_LIMIT,
  includeExternal = false,
} = {}) {
  const from = bound(since, false);
  const to = bound(until, true);
  const matches = matcher(query);
  const wanted = ARCHIVE_KINDS.includes(kind) ? kind : null;

  const months = archiveMonths(dir)
    .filter(month => (!from || month >= monthOf(from)) && (!to || month <= monthOf(to)))
    .reverse(); // newest month first

  const found = [];
  let scanned = 0;
  let widest = 0;
  for (const month of months) {
    if (found.length >= limit) break;
    const hits = [];
    const rows = await eachRow(dir, month, (row) => {
      if (wanted && row.kind !== wanted) return;
      if (!includeExternal && row.source === "external") return;
      if (!inRange(row.at, from, to)) return;
      if (!matches(row)) return;
      hits.push(row);
      if (hits.length > limit) hits.shift(); // keep the newest `limit` of this month
    });
    scanned += rows;
    widest = Math.max(widest, rows);
    found.push(...hits.reverse());
  }

  return {
    found: found.length > 0,
    events: found.slice(0, limit),
    scanned,
    // Surfaced rather than acted on: the escalation from a linear scan to FTS5
    // costs a native dependency, so it's a decision to make with the number in
    // hand, not one to make automatically.
    oversized: widest >= SCAN_ROW_WARN ? widest : 0,
  };
}

// Everything in a window, unfiltered — the input to Tier D's habit pass, which
// counts rather than searches.
export async function readRange(dir, since, until) {
  const from = bound(since, false);
  const to = bound(until, true);
  const rows = [];
  for (const month of archiveMonths(dir)) {
    if (from && month < monthOf(from)) continue;
    if (to && month > monthOf(to)) continue;
    await eachRow(dir, month, (row) => {
      if (inRange(row.at, from, to)) rows.push(row);
    });
  }
  return rows;
}

// Two clocks, because the two content types carry different risk and different
// value. Structured events are small and are the entire point of "what was on
// my list last week", so they keep indefinitely; conversation turns are
// bulkier, lower query value, and the higher-sensitivity content in an
// always-listening device, so they expire.
//
// A month left with nothing is deleted outright — that's what makes a whole
// expired month a file deletion rather than a rewrite.
export async function sweepArchive(dir, {
  now = Date.now(),
  turnRetentionDays = DEFAULT_TURN_RETENTION_DAYS,
} = {}) {
  if (!(turnRetentionDays > 0)) return { removed: 0, months: 0, deleted: 0 };
  const cutoff = new Date(now - turnRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  let removed = 0;
  let touched = 0;
  let deleted = 0;

  for (const month of archiveMonths(dir)) {
    if (month > monthOf(cutoff)) continue; // entirely inside the retention window
    const keep = [];
    let dropped = 0;
    await eachRow(dir, month, (row) => {
      if (row.kind === "turn" && typeof row.at === "string" && row.at < cutoff) {
        dropped++;
        return;
      }
      keep.push(row);
    });
    if (!dropped) continue;
    removed += dropped;
    touched++;
    const file = path.join(dir, monthFileName(month));
    if (!keep.length) {
      await fsp.rm(file, { force: true });
      deleted++;
      continue;
    }
    // Same tmp+rename as createStore: a sweep interrupted halfway must not
    // leave a truncated month behind.
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, keep.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
    await fsp.rename(tmp, file);
  }
  return { removed, months: touched, deleted };
}

// Persistent memory (Plans 9 and 10): profile facts, session rollover, and the
// habit suggestions Tier D proposes.
//
// Pure functions only — no I/O, and the clock always arrives as an argument so
// every rule here is testable. server.js owns the store and the endpoints;
// this file owns the rules:
//   - what a fact may contain, and how one fact supersedes another
//   - which facts reach the system prompt, in what order, and how many
//   - whether the previous session's tail is still worth replaying, and which
//     of its turns are safe to replay
//   - how a proposed habit becomes a fact, and only ever by a human saying so
//
// Two API facts shape the numbers below. Sessions end after 60 minutes no
// matter what, so rehydration is a routine path rather than a failure handler;
// and the whole conversation is resent to the model on every turn, so anything
// injected is paid for repeatedly. Hence: text only, and small.

// ---- Facts (Tier A) ----

export const MAX_FACT_CHARS = 200;
export const MAX_FACTS = 60;
// ~1,500 tokens at the usual ~4 chars/token. Measured headroom for the check
// in plans/09 "Before you start": the tool schemas are ~2,200 tokens and the
// base instructions ~550, so this fits with room to spare even under the
// 16,384-token instructions+tools cap documented for the superseded model.
export const MAX_FACT_BLOCK_CHARS = 6000;
// Storage cap, distinct from the prompt cap above — a stuck client looping on
// `remember` should not be able to grow the file without bound.
export const MAX_STORED_FACTS = 500;

// Provenance that may reach the prompt. "speech" is something the user said;
// "derived" is a habit Tier D noticed and a human then accepted. Everything
// else — "news" and anything added later — is stored but never spliced into
// instructions.
export const PROMPT_SOURCES = ["speech", "derived"];

// ---- Rollover (Tier B) ----

export const MAX_ROLLOVER_TURNS = 8;
export const MAX_TURN_CHARS = 400;
export const MAX_ROLLOVER_CHARS = 3200; // ~800 tokens
export const DEFAULT_ROLLOVER_MAX_AGE_MIN = 30;

// Tools that pull in text Nova doesn't control. GET /api/news proxies Google
// News headlines; replaying one into the next session's context would be a
// write channel for whoever wrote the headline. Weather, calendar and Home
// Assistant reads are low-risk but still recorded on every turn, so this list
// can be tightened later without a schema change.
export const UNTRUSTED_TOOLS = ["get_news"];

// Fact text is spliced into the system prompt, so it gets the same treatment
// as preferences: one line, bounded length. See sanitizePrefs in lib/prefs.js.
export function sanitizeFactText(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CHARS);
}

export function newFactId() {
  return "f_" + Math.random().toString(36).slice(2, 8);
}

export function activeFacts(facts = []) {
  return facts.filter(f => f && typeof f.text === "string" && !f.supersededBy);
}

// Returns { facts, fact } on success or { error } — never throws, because the
// caller is one hop from something Nova has to say out loud.
//
// `rule`/`support` are set only for derived facts (Plan 10 §7): they record
// which habit rule produced this and how strong it was, so §9 can re-measure
// the same rule later and retire a habit that has quietly ended.
export function addFact(facts = [], { text, replaces, source = "speech", rule, key, support } = {}, clock = {}) {
  const { now = Date.now, id = newFactId } = clock;
  const clean = sanitizeFactText(text);
  if (!clean) return { error: "There was nothing to remember — no text was given." };
  if (activeFacts(facts).length >= MAX_STORED_FACTS) {
    return { error: "Memory is full — forget something first." };
  }
  const next = facts.slice();
  const fact = {
    id: id(),
    text: clean,
    subject: "household", // per-person scoping later becomes a filter, not a rewrite
    source,               // provenance: see PROMPT_SOURCES
    createdAt: new Date(now()).toISOString(),
    supersededBy: null,
    pinned: false,
    ...(rule ? { rule, key, support, stale: false } : {}),
  };
  if (replaces) {
    // "I moved to Seattle" doesn't delete "I live in Portland" — it points the
    // old fact at the new one, so history survives and "no wait, go back" is
    // recoverable from the file.
    const idx = next.findIndex(f => f.id === replaces && !f.supersededBy);
    if (idx === -1) return { error: `There's no active memory with id "${replaces}".` };
    next[idx] = { ...next[idx], supersededBy: fact.id };
  }
  next.push(fact);
  return { facts: next, fact };
}

export function forgetFact(facts = [], id) {
  const idx = facts.findIndex(f => f.id === id && !f.supersededBy);
  if (idx === -1) return { error: `There's no active memory with id "${id}".` };
  const next = facts.slice();
  // Soft delete. Speech recognition will occasionally mishear which fact was
  // meant, so "forget that" has to be recoverable from the file.
  next[idx] = { ...next[idx], supersededBy: "forgotten" };
  return { facts: next, forgotten: next[idx] };
}

// Retire or restore a derived fact without deleting it (Plan 10 §9).
export function setFactStale(facts = [], id, stale) {
  const idx = facts.findIndex(f => f.id === id);
  if (idx === -1 || Boolean(facts[idx].stale) === Boolean(stale)) return facts;
  const next = facts.slice();
  next[idx] = { ...next[idx], stale: Boolean(stale) };
  return next;
}

const byAge = (a, b) =>
  String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id));

// The facts that go into the system prompt, oldest first — deterministic
// ordering, never recency-of-use, so an unchanged fact set renders
// byte-identically between sessions and stays behind the prompt cache.
// Over budget, the oldest unpinned facts are the ones that go.
export function factsForPrompt(facts = []) {
  // A stale derived fact stays in the file — a habit resuming should simply
  // restore it — but stops being told to the model.
  const eligible = activeFacts(facts).filter(f => PROMPT_SOURCES.includes(f.source) && !f.stale);
  const cost = (f) => f.text.length + 3; // "- " plus a newline

  const kept = [];
  let chars = 0;
  const take = (fact) => { kept.push(fact); chars += cost(fact); };

  // Pinned facts are kept unconditionally; the rest fill whatever is left,
  // newest first, so the budget goes to what was said most recently.
  for (const fact of eligible.filter(f => f.pinned).sort(byAge)) take(fact);
  for (const fact of eligible.filter(f => !f.pinned).sort(byAge).reverse()) {
    if (kept.length >= MAX_FACTS || chars + cost(fact) > MAX_FACT_BLOCK_CHARS) continue;
    take(fact);
  }
  return { facts: kept.sort(byAge), dropped: eligible.length - kept.length };
}

// Shape check for the rollover write, mirroring validLists in server.js: the
// browser is the only writer, but a buggy client shouldn't be able to balloon
// the file or smuggle a novel into the next session's prompt.
//
// `endedAt` is stamped here rather than taken from the body — a device with a
// wrong clock would otherwise either disable rollover forever or make it
// permanent.
export function sanitizeRollover(raw, { now = Date.now } = {}) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.turns)) return null;
  const turns = raw.turns
    .filter(t => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
    .map(t => ({
      role: t.role,
      text: t.text.replace(/\s+/g, " ").trim().slice(0, MAX_TURN_CHARS),
      tools: Array.isArray(t.tools)
        ? t.tools.filter(n => typeof n === "string").slice(0, 12)
        : [],
      mode: t.mode === "text" ? "text" : "voice",
    }))
    // Unusable turns go before the window is taken, so a blank one can't cost
    // a real turn its slot.
    .filter(t => t.text)
    .slice(-MAX_ROLLOVER_TURNS);
  if (!turns.length) return null;
  return { endedAt: new Date(now()).toISOString(), turns };
}

// Turns that ingested third-party text never ride forward. The question that
// prompted one goes too — a lone unanswered question reads as something Nova
// failed to do.
export function dropUntrustedTurns(turns = []) {
  const keep = turns.map(() => true);
  turns.forEach((turn, i) => {
    if (!(turn.tools || []).some(name => UNTRUSTED_TOOLS.includes(name))) return;
    keep[i] = false;
    if (i > 0 && turns[i - 1].role === "user") keep[i - 1] = false;
  });
  return turns.filter((_, i) => keep[i]);
}

// The previous session's tail, if it is still worth replaying. A reconnect and
// a fast reload land inside the staleness window; yesterday's conversation
// does not — without that check the hourly session cap would quietly glue a
// whole day into one context. `maxAgeMin: 0` turns rollover off entirely.
export function rolloverForSession(rollover, {
  now = Date.now(),
  maxAgeMin = DEFAULT_ROLLOVER_MAX_AGE_MIN,
  includeTextMode = true,
} = {}) {
  if (!rollover || !Array.isArray(rollover.turns)) return null;
  const endedAt = Date.parse(rollover.endedAt);
  if (!Number.isFinite(endedAt) || now - endedAt > maxAgeMin * 60 * 1000) return null;
  const eligible = includeTextMode ? rollover.turns : rollover.turns.filter(t => t.mode !== "text");
  const turns = dropUntrustedTurns(eligible).slice(-MAX_ROLLOVER_TURNS);
  if (!turns.length) return null;
  return { endedAt: rollover.endedAt, turns };
}

// Rendered once, server-side, and handed to the client as finished text: the
// browser never decides what goes into the prompt. It goes in as a single
// conversation item rather than one per turn, which keeps the token budget in
// one place and sidesteps a documented failure — replaying prior turns as
// assistant-role items makes the model adopt that message's modality.
export function renderRolloverText(turns = []) {
  const lines = turns.map(t => `${t.role === "user" ? "User" : "You"}: ${t.text}`);
  while (lines.length > 1 && lines.join("\n").length > MAX_ROLLOVER_CHARS) lines.shift();
  return "Earlier in this conversation (the connection dropped and resumed):\n" +
    lines.join("\n").slice(0, MAX_ROLLOVER_CHARS) +
    "\nContinue naturally. Don't re-greet or recap unless asked.";
}

// ---- Habit suggestions (Tier D) ----
//
// lib/habits.js counts the patterns; this half decides what happens to one
// afterwards. Nothing here writes a fact on its own — acceptSuggestion is the
// only path from a noticed pattern into the system prompt, and it runs only
// when a human has said yes.

export const MAX_SUGGESTIONS = 200;
export const MAX_PENDING_SUGGESTIONS = 12;

export function newSuggestionId() {
  return "s_" + Math.random().toString(36).slice(2, 8);
}

export function pendingSuggestions(suggestions = []) {
  return suggestions.filter(s => s && s.status === "pending");
}

export function supportText(support) {
  if (typeof support === "string") return support;
  return support && Number.isFinite(support.n) && Number.isFinite(support.of)
    ? `${support.n}/${support.of}`
    : "";
}

// Fold a scan's findings into the stored list. A pattern already accepted or
// already dismissed never comes back: the whole value of remembering a
// dismissal is that the same suggestion doesn't resurface every six hours.
// A still-pending one has its wording and support refreshed in place, keeping
// its id so a card the user is looking at doesn't change under them.
export function mergeSuggestions(suggestions = [], detected = [], clock = {}) {
  const { now = Date.now, id = newSuggestionId } = clock;
  const at = new Date(now()).toISOString();
  const byKey = new Map(suggestions.map(s => [`${s.rule}|${s.key}`, s]));
  let next = suggestions.slice();
  let added = 0;

  for (const habit of detected) {
    const seen = byKey.get(`${habit.rule}|${habit.key}`);
    if (seen && seen.status !== "pending") continue;
    if (seen) {
      next = next.map(s => (s.id === seen.id
        ? { ...s, text: habit.text, support: supportText(habit.support), seenAt: at }
        : s));
      continue;
    }
    if (pendingSuggestions(next).length >= MAX_PENDING_SUGGESTIONS) continue;
    next.push({
      id: id(),
      text: habit.text,
      rule: habit.rule,
      key: habit.key,
      support: supportText(habit.support),
      proposedAt: at,
      seenAt: at,
      status: "pending",
    });
    added++;
  }

  // Resolved entries are the "don't ask again" record, so they're the last
  // thing dropped and the oldest go first.
  if (next.length > MAX_SUGGESTIONS) {
    const resolved = next.filter(s => s.status !== "pending");
    const drop = new Set(resolved.slice(0, next.length - MAX_SUGGESTIONS).map(s => s.id));
    next = next.filter(s => !drop.has(s.id));
  }
  return { suggestions: next, added };
}

// Claim the next suggestion for Nova to raise out loud, and stamp it so she
// raises it exactly once. Claiming server-side rather than in the browser is
// what makes "once" hold across a reload, a reconnect, and a second device.
//
// An unanswered ask stays pending on purpose: the card is the fallback record,
// so a suggestion missed while nobody was in the room isn't lost — it just
// stops being spoken.
export function askSuggestion(suggestions = [], clock = {}) {
  const { now = Date.now } = clock;
  const idx = suggestions.findIndex(s => s.status === "pending" && !s.askedAt);
  if (idx === -1) return { suggestion: null };
  const next = suggestions.slice();
  next[idx] = { ...next[idx], askedAt: new Date(now()).toISOString() };
  return { suggestions: next, suggestion: next[idx] };
}

export function dismissSuggestion(suggestions = [], id, clock = {}) {
  const { now = Date.now } = clock;
  const idx = suggestions.findIndex(s => s.id === id && s.status === "pending");
  if (idx === -1) return { error: `There's no pending suggestion with id "${id}".` };
  const next = suggestions.slice();
  next[idx] = { ...next[idx], status: "dismissed", resolvedAt: new Date(now()).toISOString() };
  return { suggestions: next, dismissed: next[idx] };
}

// The fact is written with source "derived" so it stays distinguishable from
// something the user actually said, forever — and carries the rule that
// produced it so decay can re-measure the same pattern later.
export function acceptSuggestion({ facts = [], suggestions = [] } = {}, id, clock = {}) {
  const { now = Date.now } = clock;
  const idx = suggestions.findIndex(s => s.id === id && s.status === "pending");
  if (idx === -1) return { error: `There's no pending suggestion with id "${id}".` };
  const suggestion = suggestions[idx];
  const result = addFact(facts, {
    text: suggestion.text,
    source: "derived",
    rule: suggestion.rule,
    key: suggestion.key,
    support: suggestion.support,
  }, clock);
  if (result.error) return { error: result.error };
  const next = suggestions.slice();
  next[idx] = {
    ...suggestion,
    status: "accepted",
    resolvedAt: new Date(now()).toISOString(),
    factId: result.fact.id,
  };
  return { facts: result.facts, suggestions: next, fact: result.fact };
}

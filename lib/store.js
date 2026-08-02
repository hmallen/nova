// Tiny file-backed JSON store, shared by the lists (Plan 3) and memory (Plan 9).
//
// - The file is read once at boot; after that the in-memory copy is the truth
//   and every update() rewrites the file atomically (tmp file + rename).
// - `rev` is a monotonically increasing integer used for cheap change
//   detection by polling clients — no timestamps, no per-item versions.
// - Writes are serialized through a promise chain; with a single Node process
//   that rules out cross-write races. No CRDT needed: voice edits are
//   single-item and rare, and the client's 409-retry re-applies the one
//   action on top of fresh state.
// - `defaults` describes the shape. Its keys are the only ones read back off
//   disk, and a stored value whose broad kind doesn't match its default is
//   discarded. Anything finer is the caller's business (see lib/memory.js).

import fs from "node:fs";

// Arrays stay arrays, plain objects stay plain objects, everything else
// matches by typeof. A `null` default accepts any object — whoever owns that
// key validates it.
function sameKind(value, fallback) {
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (fallback && typeof fallback === "object") {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }
  return typeof value === typeof fallback;
}

export function createStore(filePath, defaults = { lists: {} }) {
  const fresh = () => ({ ...structuredClone(defaults), rev: 0 });
  let data = load();
  let chain = Promise.resolve();

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return fresh(); // missing file: fresh store
    }
    try {
      const parsed = JSON.parse(raw);
      const next = fresh();
      for (const key of Object.keys(defaults)) {
        if (sameKind(parsed?.[key], defaults[key])) next[key] = parsed[key];
      }
      next.rev = Number.isInteger(parsed?.rev) ? parsed.rev : 0;
      return next;
    } catch {
      // Corrupt file: keep it for inspection, don't delete.
      try { fs.renameSync(filePath, filePath + ".bad"); } catch {}
      return fresh();
    }
  }

  function write() {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  }

  return {
    // Current in-memory data — treat as read-only.
    get() {
      return data;
    },
    // mutator(current) → the new data object (may be async). rev++ per write.
    // Return null/undefined from the mutator to abort (no write, no rev bump)
    // — that keeps conflict checks atomic with the commit.
    update(mutator) {
      chain = chain.then(async () => {
        const next = await mutator(data);
        if (next == null) return data;
        data = { ...next, rev: data.rev + 1 };
        write();
        return data;
      });
      return chain;
    },
  };
}

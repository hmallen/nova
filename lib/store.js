// Tiny file-backed JSON store for the shared lists (Plan 3).
//
// - The file is read once at boot; after that the in-memory copy is the truth
//   and every update() rewrites the file atomically (tmp file + rename).
// - `rev` is a monotonically increasing integer used for cheap change
//   detection by polling clients — no timestamps, no per-item versions.
// - Writes are serialized through a promise chain; with a single Node process
//   that rules out cross-write races. No CRDT needed: voice edits are
//   single-item and rare, and the client's 409-retry re-applies the one
//   action on top of fresh state.

import fs from "node:fs";

export function createStore(filePath) {
  let data = load();
  let chain = Promise.resolve();

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      return { lists: {}, rev: 0 }; // missing file: fresh store
    }
    try {
      const parsed = JSON.parse(raw);
      return {
        lists: parsed && typeof parsed.lists === "object" && parsed.lists ? parsed.lists : {},
        rev: Number.isInteger(parsed?.rev) ? parsed.rev : 0,
      };
    } catch {
      // Corrupt file: keep it for inspection, don't delete.
      try { fs.renameSync(filePath, filePath + ".bad"); } catch {}
      return { lists: {}, rev: 0 };
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
    // mutator(current) → new lists object (may be async). rev++ per write.
    // Return null/undefined from the mutator to abort (no write, no rev bump)
    // — that keeps conflict checks atomic with the commit.
    update(mutator) {
      chain = chain.then(async () => {
        const lists = await mutator(data);
        if (lists == null) return data;
        data = { lists, rev: data.rev + 1 };
        write();
        return data;
      });
      return chain;
    },
  };
}

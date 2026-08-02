import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-store-"));
  return path.join(dir, "state.json");
}

test("fresh store starts at rev 0; rev bumps per write and persists", async () => {
  const file = tmpFile();
  const store = createStore(file);
  assert.deepEqual(store.get(), { lists: {}, rev: 0 });
  await store.update(() => ({ lists: { shopping: ["milk"] } }));
  assert.equal(store.get().rev, 1);
  // A second instance reads the same state back off disk.
  const reloaded = createStore(file);
  assert.deepEqual(reloaded.get(), { lists: { shopping: ["milk"] }, rev: 1 });
});

test("atomic write leaves no .tmp residue", async () => {
  const file = tmpFile();
  const store = createStore(file);
  await store.update(() => ({ lists: { "to-do": ["a", "b"] } }));
  assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(file + ".tmp"));
});

test("corrupt file is quarantined to .bad, not deleted", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ this is not json");
  const store = createStore(file);
  assert.deepEqual(store.get(), { lists: {}, rev: 0 });
  assert.ok(fs.existsSync(file + ".bad"));
  assert.equal(fs.readFileSync(file + ".bad", "utf8"), "{ this is not json");
});

test("mutator returning null aborts without a rev bump", async () => {
  const file = tmpFile();
  const store = createStore(file);
  const result = await store.update(() => null);
  assert.equal(result.rev, 0);
  assert.ok(!fs.existsSync(file)); // nothing was ever written
});

test("concurrent update() calls serialize (no lost writes)", async () => {
  const file = tmpFile();
  const store = createStore(file);
  await Promise.all(
    [...Array(10)].map((_, i) =>
      store.update(cur => ({ lists: { ...cur.lists, ["list" + i]: [String(i)] } }))
    )
  );
  assert.equal(store.get().rev, 10);
  assert.equal(Object.keys(store.get().lists).length, 10);
  // On-disk copy matches the final in-memory state.
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), store.get());
});

test("a custom defaults shape round-trips, and unknown keys are ignored", async () => {
  const file = tmpFile();
  const store = createStore(file, { facts: [], rollover: null });
  assert.deepEqual(store.get(), { facts: [], rollover: null, rev: 0 });

  await store.update(cur => ({ ...cur, facts: [{ id: "f_1", text: "cat is Widget" }] }));
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), sneaky: true }));

  const reloaded = createStore(file, { facts: [], rollover: null });
  assert.equal(reloaded.get().facts[0].text, "cat is Widget");
  assert.equal(reloaded.get().rev, 1);
  assert.ok(!("sneaky" in reloaded.get()));
});

test("a persisted value of the wrong kind falls back to its default", () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ facts: "not an array", rollover: null, rev: 4 }));
  const store = createStore(file, { facts: [], rollover: null });
  assert.deepEqual(store.get(), { facts: [], rollover: null, rev: 4 });
});

test("defaults are not shared between store instances", async () => {
  const defaults = { facts: [], rollover: null };
  const a = createStore(tmpFile(), defaults);
  await a.update(cur => ({ ...cur, facts: [{ id: "f_1", text: "x" }] }));
  assert.deepEqual(createStore(tmpFile(), defaults).get().facts, []);
  assert.deepEqual(defaults.facts, []);
});

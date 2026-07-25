import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEnv, applyEnv } from "../lib/env.js";

test("parseEnv: values, quotes, comments, junk lines", () => {
  const parsed = parseEnv(
    'PLAIN=1\nDOUBLE="quoted value"\nSINGLE=\'single\'\n# a comment\nNOT A VAR\nEQUALS=a=b\nEMPTY=\n'
  );
  assert.deepEqual(parsed, {
    PLAIN: "1",
    DOUBLE: "quoted value",
    SINGLE: "single",
    EQUALS: "a=b",
    EMPTY: "",
  });
});

test("parseEnv: CRLF line endings (Windows)", () => {
  const parsed = parseEnv("A=1\r\nB=2\r\n");
  assert.deepEqual(parsed, { A: "1", B: "2" });
});

test("parseEnv: non-string input returns empty object", () => {
  assert.deepEqual(parseEnv(null), {});
  assert.deepEqual(parseEnv(undefined), {});
});

test("applyEnv: existing environment variables win over the file", () => {
  const env = { A: "keep" };
  applyEnv({ A: "from-file", B: "added" }, env);
  assert.deepEqual(env, { A: "keep", B: "added" });
});

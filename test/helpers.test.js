import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsedTime } from "../public/lib/helpers.js";

test("formatElapsedTime renders stopwatch durations", () => {
  assert.equal(formatElapsedTime(0), "0:00");
  assert.equal(formatElapsedTime(65_999), "1:05");
  assert.equal(formatElapsedTime(3_661_000), "1:01:01");
  assert.equal(formatElapsedTime(-1_000), "0:00");
  assert.equal(formatElapsedTime(Number.NaN), "0:00");
});

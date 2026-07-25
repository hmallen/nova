import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRss } from "../lib/rss.js";

const fixture = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.rss.xml"),
  "utf8"
);

test("parses items: CDATA titles, named/numeric entities, source, skips title-less items", () => {
  const items = parseRss(fixture);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Markets rally as <tech> stocks surge");
  assert.equal(items[0].source, "Example News");
  assert.equal(items[0].published, "Sat, 25 Jul 2026 08:00:00 GMT");
  assert.equal(items[1].title, "AT&T & Verizon reach deal — shares up");
});

test("malformed feed returns an empty array, never throws", () => {
  assert.deepEqual(parseRss("<<<< not xml at all"), []);
  assert.deepEqual(parseRss("<rss><channel><item><title></title></item></channel></rss>"), []);
  assert.deepEqual(parseRss(""), []);
  assert.deepEqual(parseRss(null), []);
});

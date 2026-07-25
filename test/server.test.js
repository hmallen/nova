import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNovaServer } from "../server.js";

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nova-data-"));
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))
  );
}

// fetch() normalizes "/../" out of URLs before sending, so traversal probes
// go through a raw http.request with the path passed verbatim.
function rawGet(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("server smoke", async (t) => {
  const server = createNovaServer({ env: { OPENAI_API_KEY: "sk-test" }, dataDir: tmpDataDir() });
  const base = await listen(server);
  t.after(() => server.close());

  await t.test("GET / serves the client shell", async () => {
    const resp = await fetch(base + "/");
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type"), /text\/html/);
    assert.match(await resp.text(), /Nova/);
  });

  await t.test("path traversal is rejected (plain and percent-encoded)", async () => {
    for (const p of ["/../server.js", "/..%2f..%2fserver.js", "/..%5c..%5cserver.js", "/%2e%2e/server.js"]) {
      const { status, body } = await rawGet(base, p);
      assert.ok([403, 404].includes(status), `${p} → HTTP ${status}`);
      assert.ok(!body.includes("createNovaServer"), `${p} leaked server source`);
    }
  });

  await t.test("unknown static path → 404", async () => {
    const resp = await fetch(base + "/nope.js");
    assert.equal(resp.status, 404);
  });

  await t.test("lists: GET, PUT, 304, 409 conflict, 400 validation", async () => {
    let resp = await fetch(base + "/api/lists");
    assert.deepEqual(await resp.json(), { lists: {}, rev: 0 });

    resp = await fetch(base + "/api/lists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev: 0, lists: { shopping: ["milk"] } }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { rev: 1 });

    resp = await fetch(base + "/api/lists?since=1");
    assert.equal(resp.status, 304);

    resp = await fetch(base + "/api/lists?since=0");
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { lists: { shopping: ["milk"] }, rev: 1 });

    // Stale rev → 409 with current server state.
    resp = await fetch(base + "/api/lists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev: 0, lists: { shopping: ["eggs"] } }),
    });
    assert.equal(resp.status, 409);
    assert.deepEqual(await resp.json(), { lists: { shopping: ["milk"] }, rev: 1 });

    // Shape violations → 400.
    for (const lists of [{ shopping: "nope" }, { shopping: [42] }, "x", null]) {
      resp = await fetch(base + "/api/lists", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: 1, lists }),
      });
      assert.equal(resp.status, 400);
    }
  });

  await t.test("integrations report off and 404 when unconfigured", async () => {
    const resp = await fetch(base + "/api/config");
    const config = await resp.json();
    assert.equal(config.homeAssistant, false);
    assert.equal(config.calendar, false);
    assert.ok(Array.isArray(config.radio) && config.radio.length > 0);
    assert.equal((await fetch(base + "/api/ha/states")).status, 404);
    assert.equal((await fetch(base + "/api/calendar")).status, 404);
  });

  await t.test("HA call validation rejects non-allowlisted domains even when configured", async () => {
    const ha = createNovaServer({
      env: { OPENAI_API_KEY: "sk-test", HA_URL: "http://127.0.0.1:9", HA_TOKEN: "t" },
      dataDir: tmpDataDir(),
    });
    const haBase = await listen(ha);
    try {
      for (const call of [
        { domain: "shell_command", service: "turn_on", entity_id: "shell_command.x" },
        { domain: "light", service: "reload", entity_id: "light.office" },
        { domain: "light", service: "turn_on", entity_id: "sensor.sneaky" },
        { domain: "light", service: "turn_on", entity_id: "light.office", data: { brightness: 255 } },
      ]) {
        const resp = await fetch(haBase + "/api/ha/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(call),
        });
        assert.equal(resp.status, 400, JSON.stringify(call));
      }
    } finally {
      ha.close();
    }
  });

  await t.test("POST /api/session without a key → friendly 500", async () => {
    const bare = createNovaServer({ env: {}, dataDir: tmpDataDir() });
    const bareBase = await listen(bare);
    try {
      const resp = await fetch(bareBase + "/api/session", { method: "POST" });
      assert.equal(resp.status, 500);
      assert.match((await resp.json()).error, /OPENAI_API_KEY/);
    } finally {
      bare.close();
    }
  });
});

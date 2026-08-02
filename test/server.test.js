import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createNovaServer, HttpsSetupError } from "../server.js";

const SERVER_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../server.js");

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
  assert.equal(server.novaInfo.https, false);
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

  await t.test("memory facts: add, list, supersede, forget, and validation", async () => {
    const post = (body) => fetch(base + "/api/memory/facts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let resp = await fetch(base + "/api/memory/facts");
    assert.deepEqual(await resp.json(), { facts: [] });

    resp = await post({ action: "add", text: "Allergic to shellfish" });
    assert.equal(resp.status, 200);
    const shellfish = (await resp.json()).fact;
    // Only speakable fields come back — no timestamps, no provenance.
    assert.deepEqual(Object.keys(shellfish).sort(), ["id", "text"]);

    const portland = (await (await post({ action: "add", text: "Lives in Portland" })).json()).fact;
    resp = await post({ action: "add", text: "Lives in Seattle", replaces: portland.id });
    assert.equal(resp.status, 200);

    resp = await fetch(base + "/api/memory/facts");
    assert.deepEqual((await resp.json()).facts.map(f => f.text),
      ["Allergic to shellfish", "Lives in Seattle"]);

    resp = await post({ action: "forget", id: shellfish.id });
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).forgot.text, "Allergic to shellfish");

    resp = await fetch(base + "/api/memory/facts");
    assert.deepEqual((await resp.json()).facts.map(f => f.text), ["Lives in Seattle"]);

    for (const body of [
      { action: "add", text: "   " },
      { action: "add", text: "x", replaces: "f_nope" },
      { action: "forget", id: "f_nope" },
      { action: "wipe_everything" },
      null,
    ]) {
      assert.equal((await post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await fetch(base + "/api/memory/facts", { method: "DELETE" })).status, 405);
  });

  await t.test("memory rollover: accepts PUT and POST, rejects junk", async () => {
    const send = (method, body) => fetch(base + "/api/memory/rollover", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const turns = [{ role: "user", text: "what did I just ask you?", tools: [], mode: "voice" }];

    assert.equal((await send("PUT", { turns })).status, 200);
    // sendBeacon on pagehide can only POST.
    assert.equal((await send("POST", { turns })).status, 200);

    for (const body of [{ turns: [] }, { turns: "nope" }, null]) {
      assert.equal((await send("PUT", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await fetch(base + "/api/memory/rollover")).status, 405);
  });

  await t.test("archive: capture, then recall — found:false when nothing matches", async () => {
    const send = (events) => fetch(base + "/api/memory/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
    const recall = (body) => fetch(base + "/api/memory/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    let resp = await send([
      { kind: "tool", name: "set_timer", args: { label: "pasta", minutes: 8 }, ok: true, summary: "label: pasta" },
      { kind: "turn", name: "user", summary: "set a pasta timer" },
      { kind: "tool", name: "get_news", summary: "headlines: 8", source: "external" },
      { kind: "nonsense", name: "dropped" },
    ]);
    assert.equal((await resp.json()).stored, 3, "the unknown kind never reached the file");

    resp = await recall({ query: "pasta" });
    const hit = await resp.json();
    assert.equal(hit.found, true);
    assert.equal(hit.events.length, 2);
    // Only speakable fields, and no bare provenance leaking to the model.
    assert.deepEqual(Object.keys(hit.events[0]).sort(), ["at", "kind", "name", "summary"]);

    // Fetched third-party text is on disk but never comes back as history.
    assert.deepEqual(await (await recall({ query: "headlines" })).json(), { found: false });

    // The abstention path: an explicit false, never an empty array.
    assert.deepEqual(await (await recall({ query: "watered the plants" })).json(), { found: false });

    const turnsOnly = await (await recall({ query: "pasta", kind: "turn" })).json();
    assert.deepEqual(turnsOnly.events.map(e => e.name), ["user"]);

    assert.equal((await recall({ query: "  " })).status, 400);
    assert.equal((await fetch(base + "/api/memory/recall")).status, 405);
    assert.equal((await fetch(base + "/api/memory/archive")).status, 405);
  });

  await t.test("a list edit is archived server-side, with no client involved", async () => {
    // Verification 3: this is the only capture path for an edit made on a
    // device that isn't the one running the session.
    const cur = await (await fetch(base + "/api/lists")).json();
    const resp = await fetch(base + "/api/lists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev: cur.rev, lists: { ...cur.lists, shopping: ["oat milk"] } }),
    });
    assert.equal(resp.status, 200);
    // The write is deliberately off the response path — the list PUT is what
    // the voice flow waits on, and history is worth less than a fast reply.
    await server.novaMemory.settled();

    const hit = await (await fetch(base + "/api/memory/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "oat milk", kind: "list" }),
    })).json();
    assert.equal(hit.found, true);
    assert.match(hit.events[0].summary, /added oat milk to shopping/);
  });

  await t.test("memory survives a corrupt file without taking the lists with it", async () => {
    const dir = tmpDataDir();
    fs.writeFileSync(path.join(dir, "memory.json"), "{ not json");
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ lists: { shopping: ["milk"] }, rev: 3 }));
    const server2 = createNovaServer({ env: { OPENAI_API_KEY: "sk-test" }, dataDir: dir });
    const base2 = await listen(server2);
    try {
      assert.deepEqual(await (await fetch(base2 + "/api/memory/facts")).json(), { facts: [] });
      assert.deepEqual(await (await fetch(base2 + "/api/lists")).json(), { lists: { shopping: ["milk"] }, rev: 3 });
      assert.ok(fs.existsSync(path.join(dir, "memory.json.bad")));
    } finally {
      server2.close();
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

// Tier D end to end, on the real server: a pattern in the archive becomes a
// suggestion, a suggestion becomes a fact only when someone accepts it, and a
// habit that stops happening retires itself.
test("learned habits: propose, accept, decay", async (t) => {
  const dataDir = tmpDataDir();
  const archiveDir = path.join(dataDir, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });

  // Local time, for the same reason the habits unit tests use it: the rules
  // count the days and hours a person in the house would count.
  const at = (daysAgo, hour) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const seed = (rows) => {
    const byMonth = new Map();
    for (const r of rows) {
      const month = r.at.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) || "") + JSON.stringify(r) + "\n");
    }
    for (const [month, text] of byMonth) {
      fs.appendFileSync(path.join(archiveDir, `${month}.jsonl`), text);
    }
  };
  const weatherAt7am = (days) => Array.from({ length: days }, (_, i) => ({
    at: at(i + 1, 7), kind: "tool", name: "get_weather",
    summary: "temperature: 72", source: "speech", subject: "household",
  }));

  const server = createNovaServer({ env: { OPENAI_API_KEY: "sk-test" }, dataDir });
  const base = await listen(server);
  t.after(() => server.close());
  const suggestions = () => fetch(base + "/api/memory/suggestions").then(r => r.json());
  const resolve = (body) => fetch(base + "/api/memory/suggestions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const promptFacts = () => JSON.parse(fs.readFileSync(path.join(dataDir, "memory.json"), "utf8")).facts;

  await t.test("below threshold, nothing is proposed", async () => {
    seed(weatherAt7am(5));
    const summary = await server.novaMemory.runHabitScan({ force: true });
    assert.equal(summary.proposed, 0);
    assert.deepEqual((await suggestions()).suggestions, []);
  });

  let proposed;
  await t.test("at threshold, one suggestion appears with its support", async () => {
    seed(weatherAt7am(9).slice(5)); // 5 already seeded → 9 distinct days
    const summary = await server.novaMemory.runHabitScan({ force: true });
    assert.equal(summary.proposed, 1);
    [proposed] = (await suggestions()).suggestions;
    assert.equal(proposed.text, "You usually ask for the weather around 7am");
    assert.equal(proposed.support, "9/21");
    assert.deepEqual(Object.keys(proposed).sort(), ["id", "support", "text"]);
  });

  await t.test("a pending suggestion is not in the prompt block", () => {
    assert.deepEqual(promptFacts(), [], "proposed, not committed");
  });

  await t.test("accepting is what writes the fact, and it stays marked derived", async () => {
    assert.equal((await resolve({ action: "accept", id: proposed.id })).status, 200);
    const [fact] = promptFacts();
    assert.equal(fact.text, "You usually ask for the weather around 7am");
    assert.equal(fact.source, "derived");
    assert.equal(fact.rule, "time_of_day");
    assert.equal(fact.stale, false);
    assert.deepEqual((await suggestions()).suggestions, [], "no longer pending");

    assert.equal((await resolve({ action: "accept", id: proposed.id })).status, 400);
    assert.equal((await resolve({ action: "burn_it_all" })).status, 400);
    assert.equal((await fetch(base + "/api/memory/suggestions", { method: "DELETE" })).status, 405);
  });

  await t.test("the habit ending retires the fact without deleting it", async () => {
    // Move every observation out of the 21-day window.
    fs.rmSync(archiveDir, { recursive: true, force: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    seed(weatherAt7am(9).map((r, i) => ({ ...r, at: at(40 + i, 7) })));

    const summary = await server.novaMemory.runHabitScan({ force: true });
    assert.equal(summary.retired, 1);
    const [fact] = promptFacts();
    assert.equal(fact.stale, true, "still on disk");

    // And a habit resuming simply restores it — no re-accept, no new card.
    seed(weatherAt7am(9));
    const again = await server.novaMemory.runHabitScan({ force: true });
    assert.equal(again.restored, 1);
    assert.equal(promptFacts()[0].stale, false);
    assert.deepEqual((await suggestions()).suggestions, [], "an accepted pattern isn't re-proposed");
  });

  await t.test("Nova claims a suggestion to ask about, and only once", async () => {
    // set_timer has no argument worth counting, so this trips exactly one rule
    // — the point here is the claim, not the detection.
    seed(Array.from({ length: 9 }, (_, i) => ({
      at: at(i + 1, 22), kind: "tool", name: "set_timer",
      args: { label: "tea" }, summary: "label: tea", source: "speech", subject: "household",
    })));
    await server.novaMemory.runHabitScan({ force: true });

    const ask = () => resolve({ action: "ask" }).then(r => r.json());
    const claimed = (await ask()).suggestion;
    assert.equal(claimed.text, "You usually set a timer around 10pm");
    assert.deepEqual(await ask(), { suggestion: null }, "a second routine doesn't re-ask");

    // Answering by voice goes through the same endpoint as the card, so the
    // fact it writes is derived, not something the user is recorded as saying.
    assert.equal((await resolve({ action: "accept", id: claimed.id })).status, 200);
    const derived = promptFacts().filter(f => f.source === "derived");
    assert.ok(derived.some(f => f.text === claimed.text));
  });

  await t.test("a dismissed suggestion does not come back on the next scan", async () => {
    seed(Array.from({ length: 9 }, (_, i) => ({
      at: at(i + 1, 20), kind: "device", name: "porch light",
      args: { action: "on" }, summary: "porch light turn on", source: "speech", subject: "household",
    })));
    await server.novaMemory.runHabitScan({ force: true });
    const light = (await suggestions()).suggestions.find(s => s.text.includes("porch light"));
    assert.equal(light.text, "You usually turn the porch light on around 8pm");

    assert.equal((await resolve({ action: "dismiss", id: light.id })).status, 200);
    await server.novaMemory.runHabitScan({ force: true });
    assert.equal((await suggestions()).suggestions.some(s => s.text.includes("porch light")), false);
  });
});

test("ARCHIVE_TURN_RETENTION_DAYS expires turns and leaves events alone", async (t) => {
  const dataDir = tmpDataDir();
  const archiveDir = path.join(dataDir, "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  const old = new Date(Date.now() - 5 * 86400000).toISOString();
  fs.writeFileSync(path.join(archiveDir, `${old.slice(0, 7)}.jsonl`),
    JSON.stringify({ at: old, kind: "turn", name: "user", summary: "old chatter", source: "speech" }) + "\n" +
    JSON.stringify({ at: old, kind: "list", name: "shopping", summary: "added milk to shopping", source: "speech" }) + "\n");

  const server = createNovaServer({
    env: { OPENAI_API_KEY: "sk-test", ARCHIVE_TURN_RETENTION_DAYS: "1" },
    dataDir,
  });
  const base = await listen(server);
  t.after(() => server.close());

  const result = await server.novaMemory.runSweep();
  assert.equal(result.removed, 1);

  const recall = (query) => fetch(base + "/api/memory/recall", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then(r => r.json());
  assert.deepEqual(await recall("old chatter"), { found: false });
  assert.equal((await recall("milk")).found, true);

  // Once a day, not once a scan: the sweep re-reads old month files.
  assert.equal(await server.novaMemory.runSweep(), null);
});

test("HTTPS setup errors are actionable", async (t) => {
  await t.test("requires HTTPS_CERT and HTTPS_KEY together", () => {
    assert.throws(
      () => createNovaServer({
        env: { HTTPS_CERT: "./certs/nova.pem" },
        dataDir: tmpDataDir(),
      }),
      (err) => {
        assert.ok(err instanceof HttpsSetupError);
        assert.match(err.message, /HTTPS_KEY is not set/);
        assert.match(err.message, /Set both HTTPS_CERT and HTTPS_KEY/);
        assert.match(err.message, /unset both variables to use HTTP/);
        return true;
      }
    );
  });

  await t.test("identifies a missing certificate file and how to recover", () => {
    assert.throws(
      () => createNovaServer({
        env: {
          HTTPS_CERT: "./certs/does-not-exist.pem",
          HTTPS_KEY: "./certs/does-not-exist-key.pem",
        },
        dataDir: tmpDataDir(),
      }),
      (err) => {
        assert.ok(err instanceof HttpsSetupError);
        assert.match(err.message, /HTTPS_CERT/);
        assert.match(err.message, /does-not-exist\.pem/);
        assert.match(err.message, /could not be read \(ENOENT\)/);
        assert.match(err.message, /mkcert/);
        return true;
      }
    );
  });

  await t.test("identifies an unreadable key path", () => {
    const dir = tmpDataDir();
    const certPath = path.join(dir, "cert.pem");
    const keyPath = path.join(dir, "key-is-a-directory");
    fs.writeFileSync(certPath, "test-only placeholder");
    fs.mkdirSync(keyPath);

    assert.throws(
      () => createNovaServer({
        env: { HTTPS_CERT: certPath, HTTPS_KEY: keyPath },
        dataDir: path.join(dir, "data"),
      }),
      (err) => {
        assert.ok(err instanceof HttpsSetupError);
        assert.match(err.message, /HTTPS_KEY/);
        assert.match(err.message, /could not be read/);
        assert.match(err.message, /file permissions/);
        return true;
      }
    );
  });

  await t.test("rejects invalid PEM contents with a setup error", () => {
    const dir = tmpDataDir();
    const certPath = path.join(dir, "cert.pem");
    const keyPath = path.join(dir, "key.pem");
    fs.writeFileSync(certPath, "not a certificate");
    fs.writeFileSync(keyPath, "not a private key");

    assert.throws(
      () => createNovaServer({
        env: { HTTPS_CERT: certPath, HTTPS_KEY: keyPath },
        dataDir: path.join(dir, "data"),
      }),
      (err) => {
        assert.ok(err instanceof HttpsSetupError);
        assert.match(err.message, /valid PEM certificate and private-key pair/);
        assert.match(err.message, /Regenerate both files with mkcert/);
        return true;
      }
    );
  });

  await t.test("direct startup prints the setup error without a stack trace", () => {
    const result = spawnSync(process.execPath, [SERVER_PATH], {
      cwd: path.dirname(SERVER_PATH),
      encoding: "utf8",
      env: {
        ...process.env,
        HTTPS_CERT: "./certs/does-not-exist.pem",
        HTTPS_KEY: "./certs/does-not-exist-key.pem",
      },
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /HTTPS setup error: HTTPS_CERT/);
    assert.match(result.stderr, /mkcert/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });
});

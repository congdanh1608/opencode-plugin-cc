import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "../plugins/opencode/scripts/lib/opencode-server.mjs";
import { authHeaders, readServerState, writeServerState } from "../plugins/opencode/scripts/lib/server-auth.mjs";

test("V2 routes unwrap data and authenticate every request", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), ...options });
    const route = new URL(url).pathname;
    const result = route === "/api/session" ? { data: { id: "ses_test" } }
      : route.endsWith("/message") ? { data: [{ id: "msg_test", type: "assistant", content: [] }], cursor: {} }
      : { interrupted: true };
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = createClient("http://127.0.0.1:4096", { password: "test-password" });
    assert.equal((await client.createSession({ title: "test" })).id, "ses_test");
    assert.equal((await client.getMessages("ses_test", { limit: 1 }))[0].id, "msg_test");
    await client.abortSession("ses_test");
    await client.sendPromptAsync("ses_test", "hello", { agent: "plan", model: "demo/model" });
    assert.deepEqual(requests.map((r) => new URL(r.url).pathname), [
      "/api/session", "/api/session/ses_test/message", "/api/session/ses_test/interrupt",
      "/api/session/ses_test/agent", "/api/session/ses_test/model", "/api/session/ses_test/prompt",
    ]);
    assert.deepEqual(JSON.parse(requests[4].body), { model: { providerID: "demo", id: "model" } });
    assert.deepEqual(JSON.parse(requests[5].body), { text: "hello" });
    for (const request of requests)
      assert.equal(request.headers.Authorization, `Basic ${Buffer.from("opencode:test-password").toString("base64")}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("server password is stored in a private file and reused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-v2-test-"));
  const old = process.env.OPENCODE_COMPANION_DATA;
  process.env.OPENCODE_COMPANION_DATA = root;
  try {
    writeServerState({ url: "http://127.0.0.1:4096", port: 4096, pid: 123, password: "test-password" });
    assert.equal(readServerState().password, "test-password");
    assert.equal(authHeaders().Authorization, `Basic ${Buffer.from("opencode:test-password").toString("base64")}`);
    const stateDir = path.join(root, "state");
    const child = fs.readdirSync(stateDir)[0];
    assert.equal(fs.statSync(path.join(stateDir, child, "server.json")).mode & 0o777, 0o600);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_COMPANION_DATA;
    else process.env.OPENCODE_COMPANION_DATA = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function mockRun(script) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const body = u.pathname.endsWith("/message") ? script.messages(calls) : u.pathname.endsWith("/prompt") ? { data: {} }
      : u.pathname.startsWith("/api/session/") ? script.session(calls) : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const step = (finish, text, created) => ({ type: "assistant", finish, time: { created, completed: created + 1 },
  content: text ? [{ type: "text", text }] : [{ type: "reasoning", text: "r" }, { type: "tool", name: "shell" }] });

test("sendPrompt waits for session idle and returns the final stop step", async () => {
  process.env.OPENCODE_COMPLETION_POLL_MS = "5";
  const future = Date.now() + 60_000;
  const polls = () => 0;
  let n = 0;
  const run = mockRun({
    session: () => ({ data: { time: n >= 3 ? { idle: future } : {}, outcome: "succeeded" } }),
    messages: () => {
      n++;
      const msgs = [step("tool-calls", null, future - 10), step("stop", "final answer", future - 5)];
      return { data: n >= 3 ? [{ type: "idle", outcome: "succeeded", time: { created: future } }, ...msgs.reverse()] : [msgs[0]] };
    },
  });
  try {
    const client = createClient("http://127.0.0.1:4096");
    const msg = await client.sendPrompt("ses_a", "go");
    assert.equal(msg.finish, "stop");
    assert.equal(msg.content[0].text, "final answer");
    assert.ok(n >= 3, `kept polling until idle (polls=${n}, ${polls()})`);
  } finally { run.restore(); delete process.env.OPENCODE_COMPLETION_POLL_MS; }
});

test("sendPrompt does not return a completed step while the session is not idle", async () => {
  process.env.OPENCODE_COMPLETION_POLL_MS = "5";
  const future = Date.now() + 60_000;
  let n = 0;
  const run = mockRun({
    session: () => ({ data: { time: {} } }),
    messages: () => { n++; return { data: [step("stop", "early", future)] }; },
  });
  try {
    const client = createClient("http://127.0.0.1:4096");
    const outcome = await Promise.race([client.sendPrompt("ses_b", "go").then(() => "returned"),
      new Promise((r) => setTimeout(() => r("still polling"), 100))]);
    assert.equal(outcome, "still polling");
    assert.ok(n > 2);
  } finally { run.restore(); delete process.env.OPENCODE_COMPLETION_POLL_MS; }
});

test("sendPrompt rejects when the session outcome is failed", async () => {
  const future = Date.now() + 60_000;
  const run = mockRun({
    session: () => ({ data: { time: { idle: future }, outcome: "failed" } }),
    messages: () => ({ data: [step("tool-calls", null, future)] }),
  });
  try {
    const client = createClient("http://127.0.0.1:4096");
    await assert.rejects(client.sendPrompt("ses_c", "go"), /failed/);
  } finally { run.restore(); }
});

test("probeSessionTerminal maps idle outcome to terminal state", async () => {
  const { probeSessionTerminal } = await import("../plugins/opencode/scripts/lib/auto-heal.mjs");
  const run = mockRun({
    session: () => ({ data: { time: { idle: 2000 }, outcome: "succeeded" } }),
    messages: () => ({ data: [step("stop", "done", 1500), step("tool-calls", null, 1200)] }),
  });
  try {
    const p = await probeSessionTerminal("http://127.0.0.1:4096", "ses_d", 1000);
    assert.equal(p.terminal, true);
    assert.equal(p.text, "done");
    const early = await probeSessionTerminal("http://127.0.0.1:4096", "ses_d", 3000);
    assert.equal(early.terminal, false);
  } finally { run.restore(); }
});

test("isServerRunning accepts V2 info without pid", async () => {
  const { isServerRunning } = await import("../plugins/opencode/scripts/lib/opencode-server.mjs");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ version: "2.0.25", urls: [] }), { status: 200 });
  try { assert.equal(await isServerRunning("127.0.0.1", 4096, "x"), true); }
  finally { globalThis.fetch = original; }
});

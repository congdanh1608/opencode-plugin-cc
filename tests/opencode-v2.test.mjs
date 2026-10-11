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

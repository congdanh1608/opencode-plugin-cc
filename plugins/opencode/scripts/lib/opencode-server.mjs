// OpenCode HTTP API client.
// Unlike codex-plugin-cc which uses JSON-RPC over stdin/stdout,
// OpenCode exposes a REST API + SSE. This module wraps that API.

import { spawn, spawnSync } from "node:child_process";
import net from "node:net";

// Re-export for spec-compliance / discoverability: probeSessionTerminal lives
// in auto-heal.mjs because it is tightly coupled to heal-decision logic, but
// conceptually it is a server probe.
export { probeSessionTerminal } from "./auto-heal.mjs";
import { evaluateRun } from "./auto-heal.mjs";
import { assertOpencodeConfig } from "./opencode-config.mjs";
import { classifyError } from "./errors.mjs";
import { authHeaders, newServerPassword, readServerState, writeServerState } from "./server-auth.mjs";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_PORT = 4096;
const DEFAULT_HOST = "127.0.0.1";
const SERVER_START_TIMEOUT = 30_000;

// Long-running tasks (e.g. engine builds, large refactors) can easily exceed
// the old 5-10 min caps, causing `fetch failed` at a fixed deadline. Default
// PROMPT_TIMEOUT_MS to 4 hours — absolute safety cap. Real stall detection
// lives in the watcher via IDLE_TIMEOUT_MS + pgrep child-process check.
const REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_REQUEST_TIMEOUT_MS) || 1_800_000;
const PROMPT_TIMEOUT_MS = Number(process.env.OPENCODE_PROMPT_TIMEOUT_MS) || 14_400_000;
// How long a session may go without ANY activity signal before we assume it
// is stuck. Activity = new message, new parts, tool output growth, status
// change. Default 1h — long enough for silent-but-live tool subprocesses.
const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 3_600_000;

function modelRef(model) {
  if (typeof model === "object") return model;
  const slash = model.indexOf("/");
  if (slash < 1) throw new Error("Model must be provider/model for OpenCode V2");
  const [id, variant] = model.slice(slash + 1).split("#", 2);
  return { providerID: model.slice(0, slash), id, ...(variant ? { variant } : {}) };
}

/**
 * Find the PID of `opencode serve` listening on `port`, if we can.
 * Returns null on Windows or any detection failure (caller degrades gracefully).
 */
function resolveServePid(port) {
  if (IS_WINDOWS) return null;
  try {
    // macOS + Linux: lsof works the same way. Short timeout so we never block
    // the watcher loop if the tool is slow/missing.
    const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 2000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const lines = r.stdout.split("\n").slice(1).filter(Boolean);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
  } catch {
    // lsof missing or errored — degrade to no pgrep checks
  }
  return null;
}

/**
 * Check if an OpenCode server is already running on the given port.
 * @param {string} host
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export async function isServerRunning(host = DEFAULT_HOST, port = DEFAULT_PORT, password = readServerState()?.password) {
  try {
    const res = await fetch(`http://${host}:${port}/api/info`, {
      headers: authHeaders(password),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const info = await res.json();
    return typeof info?.version === "string" || typeof info?.pid === "number" || Array.isArray(info?.urls);
  } catch {
    return false;
  }
}

/**
 * Start the OpenCode server if not already running.
 * @param {object} opts
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {string} [opts.cwd]
 * @returns {Promise<{ url: string, pid?: number, alreadyRunning: boolean }>}
 */
export async function ensureServer(opts = {}) {
  const host = opts.host ?? DEFAULT_HOST;
  const saved = readServerState();
  let port = opts.port ?? saved?.port ?? DEFAULT_PORT;
  let url = `http://${host}:${port}`;
  if (await isServerRunning(host, port, saved?.password)) return { url, alreadyRunning: true };

  // A listener with different credentials is never adopted. Only stop a PID
  // recorded by this plugin and still bound to the recorded port.
  const occupied = async (p) => {
    try { await fetch(`http://${host}:${p}/api/info`, { headers: authHeaders(saved?.password), signal: AbortSignal.timeout(1500) }); return true; }
    catch {
      return new Promise((resolve) => {
        const socket = net.createServer();
        socket.once("error", () => resolve(true));
        socket.listen(p, host, () => socket.close(() => resolve(false)));
      });
    }
  };
  if (await occupied(port)) {
    const listener = resolveServePid(port);
    if (saved?.pid && saved.port === port && listener === saved.pid && ![66885, 85362].includes(listener)) {
      try { process.kill(listener, "SIGTERM"); } catch { /* The port check below chooses another port. */ }
      const until = Date.now() + 5000;
      while (Date.now() < until && resolveServePid(port) === listener)
        await new Promise((r) => setTimeout(r, 100));
    }
    if (await occupied(port)) {
      port = await new Promise((resolve, reject) => {
        const socket = net.createServer();
        socket.once("error", reject);
        socket.listen(0, host, () => {
          const selected = socket.address().port;
          socket.close(() => resolve(selected));
        });
      });
      url = `http://${host}:${port}`;
    }
  }

  // Throws on a missing or hang-prone worker config; the server reads it only at startup.
  const configPath = assertOpencodeConfig();

  // Start the server
  // Windows npm shims are .cmd/.ps1; spawn() only resolves those via a shell.
  // stdio must not be piped: open pipes to the detached server keep this process alive.
  const password = newServerPassword();
  const proc = spawn("opencode", ["serve", "--port", String(port), "--hostname", host], {
    stdio: "ignore",
    detached: true,
    cwd: opts.cwd,
    env: { ...process.env, OPENCODE_CONFIG: configPath, OPENCODE_PASSWORD: password },
    shell: IS_WINDOWS,
  });
  proc.unref();

  // Wait for the server to become ready
  const deadline = Date.now() + SERVER_START_TIMEOUT;
  while (Date.now() < deadline) {
    if (await isServerRunning(host, port, password)) {
      writeServerState({ url, port, pid: proc.pid, password });
      return { url, pid: proc.pid, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`OpenCode server failed to start within ${SERVER_START_TIMEOUT / 1000}s`);
}

/**
 * Create an API client bound to a running OpenCode server.
 * @param {string} baseUrl
 * @param {object} [opts]
 * @param {string} [opts.directory] - workspace location for V2 requests
 * @returns {OpenCodeClient}
 */
export function createClient(baseUrl, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
  };
  Object.assign(headers, authHeaders(opts.password));
  const locationQuery = opts.directory
    ? `?${new URLSearchParams({ "location[directory]": opts.directory })}` : "";

  async function request(method, path, body) {
    const startedAt = Date.now();
    let res;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw classifyError(err, { baseUrl, startedAt, timeoutMs: REQUEST_TIMEOUT_MS, op: `request ${method} ${path}` });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw classifyError(
        new Error(`OpenCode API ${method} ${path} returned ${res.status}: ${text}`),
        { baseUrl, startedAt, timeoutMs: REQUEST_TIMEOUT_MS, op: `request ${method} ${path}` },
      );
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    return res.text();
  }

  return {
    baseUrl,

    // Health
    health: () => request("GET", "/api/info"),

    // Sessions
    listSessions: async () => (await request("GET", opts.directory
      ? `/api/session?${new URLSearchParams({ directory: opts.directory })}` : "/api/session")).data,
    createSession: async (session = {}) => (await request("POST", "/api/session",
      opts.directory ? { ...session, location: session.location ?? { directory: opts.directory } } : session)).data,
    getSession: async (id) => (await request("GET", `/api/session/${id}`)).data,
    deleteSession: (id) => request("DELETE", `/api/session/${id}`),
    abortSession: (id) => request("POST", `/api/session/${id}/interrupt`),
    getSessionStatus: async () => (await request("GET", "/api/session/active")).data,
    getSessionDiff: async (id) => (await request("GET", `/api/session/${id}/diff`)).data,

    // Messages
    getMessages: (sessionId, opts = {}) => {
      const params = new URLSearchParams();
      if (opts.limit) params.set("limit", String(opts.limit));
      if (opts.cursor) params.set("cursor", opts.cursor);
      if (opts.order) params.set("order", opts.order);
      const qs = params.toString();
      return request("GET", `/api/session/${sessionId}/message${qs ? "?" + qs : ""}`).then((r) => r.data);
    },

    /** Queue a V2 prompt, wait for the session to go idle, return the final assistant step. */
    sendPrompt: async (sessionId, promptText, opts = {}) => {
      const startedAt = Date.now();
      if (opts.agent) await request("POST", `/api/session/${sessionId}/agent`, { agent: opts.agent });
      if (opts.model) await request("POST", `/api/session/${sessionId}/model`, { model: modelRef(opts.model) });
      const text = opts.system ? `${opts.system}\n\n${promptText}` : promptText;
      await request("POST", `/api/session/${sessionId}/prompt`, { text });
      let lastActivity = Date.now();
      let signature = "";
      while (Date.now() - startedAt < PROMPT_TIMEOUT_MS) {
        const session = (await request("GET", `/api/session/${sessionId}`)).data;
        const messages = (await request("GET", `/api/session/${sessionId}/message?limit=50&order=desc`)).data;
        const run = evaluateRun(session, messages, startedAt);
        const next = JSON.stringify([session?.time?.updated, session?.time?.idle, messages?.[0]]);
        if (next !== signature) { signature = next; lastActivity = Date.now(); }
        if (run.done) {
          if (run.outcome && run.outcome !== "succeeded") throw new Error(`OpenCode session ${run.outcome}`);
          if (!run.final) throw new Error("session finished without an assistant message");
          return run.final;
        }
        if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) throw new Error("session idle timeout");
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.OPENCODE_COMPLETION_POLL_MS) || 5000));
      }
      throw new Error("prompt timeout");
    },

    sendPromptAsync: async (sessionId, promptText, opts = {}) => {
      if (opts.agent) await request("POST", `/api/session/${sessionId}/agent`, { agent: opts.agent });
      if (opts.model) await request("POST", `/api/session/${sessionId}/model`, { model: modelRef(opts.model) });
      return (await request("POST", `/api/session/${sessionId}/prompt`, { text: promptText })).data;
    },

    // Agents
    listAgents: async () => (await request("GET", `/api/agent${locationQuery}`)).data,

    // Providers
    listProviders: async () => (await request("GET", `/api/provider${locationQuery}`)).data,
    listModels: async () => (await request("GET", `/api/model${locationQuery}`)).data,

    // Config
    getConfig: () => request("GET", `/api/config${locationQuery}`),

    // Events (SSE) - returns a ReadableStream
    subscribeEvents: async () => {
      const res = await fetch(`${baseUrl}/api/event`, {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      if (!res.ok) throw new Error(`OpenCode event stream returned ${res.status}`);
      return res.body;
    },
  };
}

/**
 * Connect to OpenCode: ensure server is running, create client.
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {number} [opts.port]
 * @returns {Promise<ReturnType<typeof createClient> & { serverInfo: object }>}
 */
export async function connect(opts = {}) {
  const { url } = await ensureServer(opts);
  const client = createClient(url, { directory: opts.cwd });
  return { ...client, serverInfo: { url } };
}

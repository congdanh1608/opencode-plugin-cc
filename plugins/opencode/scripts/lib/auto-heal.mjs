// Session-level auto-heal for tracked jobs.
//
// Background: task-worker subprocesses wrap `client.sendPrompt(sid, ...)` in
// runTrackedJob so that on successful return the job flips status→completed
// and the response text is persisted to jobDataPath. But sendPrompt can hang
// or the worker can be killed before that return happens — even though the
// OpenCode session itself completed cleanly server-side. The job then stays
// in a non-terminal state ("investigating"/"running") forever and downstream
// Monitor scripts never see the true finish.
//
// This module provides a best-effort reconciliation pass: given a job with
// an `opencodeSessionId`, query the OpenCode server for the last assistant
// message in that session. If it looks terminal, upsert the job as completed
// and persist the text. If the worker process is gone and the session has
// been idle long enough, mark as failed with a clear error message.
//
// All functions are no-ops (or log to stderr and return the original job)
// when the server is unreachable, so callers can sprinkle autoHealJob at
// the top of status-reading paths without wrapping in try/catch themselves.

import fs from "node:fs";
import path from "node:path";

import { ensureDir } from "./fs.mjs";
import { upsertJob, jobDataPath } from "./state.mjs";
import { authHeaders, serverUrl } from "./server-auth.mjs";

// A worker/session can be legitimately silent for a while (big model thinking,
// slow tool) — only declare it dead after >60s of no session activity AND no
// live task-worker process. 60s matches the spec.
const STALE_IDLE_MS = 60_000;

function buildHeaders() {
  return { "Content-Type": "application/json", ...authHeaders() };
}

/**
 * True if the given PID is currently alive. Treats missing/invalid PID as dead.
 * @param {number|undefined|null} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 is a permission/existence probe — no signal delivered.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = process exists but we can't signal it
    // (still alive from our perspective).
    return err.code === "EPERM";
  }
}

/**
 * Extract visible text from an OpenCode message `parts` array.
 * @param {Array|undefined} parts
 * @returns {string}
 */
function extractPartsText(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** Joined text parts of a V2 assistant message. */
export function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return extractPartsText(message?.content);
}

/**
 * V2 run state: finished only once the session is idle after startedAt.
 * Result = last "stop" assistant message of the run, else the last assistant message.
 */
export function evaluateRun(session, messages, startedAt) {
  const list = Array.isArray(messages) ? messages : [];
  const created = (m) => (typeof m?.time?.created === "number" ? m.time.created : 0);
  const idleMsg = list.find((m) => m?.type === "idle" && created(m) >= startedAt);
  const idleAt = session?.time?.idle;
  const done = (typeof idleAt === "number" && idleAt >= startedAt) || !!idleMsg;
  const outcome = session?.outcome ?? idleMsg?.outcome;
  const steps = list
    .filter((m) => m?.type === "assistant" && created(m) >= startedAt)
    .sort((a, b) => created(a) - created(b));
  const final = [...steps].reverse().find((m) => m.finish === "stop") ?? steps[steps.length - 1] ?? null;
  return { done, outcome, final };
}

/**
 * Query the opencode server for the terminal state of a session.
 *
 * Returns:
 *   { terminal: true, outcome, finish, completed, text, info } when the session is idle after startedAt.
 *   { terminal: false, reachable: true, lastUpdatedAt, lastInfo } while the session is still running.
 *   { terminal: false, reachable: false, error }                  when server unreachable / errored.
 *
 * @param {string} baseUrl
 * @param {string} sessionId
 * @param {number} startedAtMs - epoch ms; only treat idle at/after this as ours
 * @param {object} [headers]
 */
export async function probeSessionTerminal(baseUrl, sessionId, startedAtMs, headers) {
  const h = headers ?? buildHeaders();
  try {
    const get = (p) => fetch(`${baseUrl}/api/session/${sessionId}${p}`, {
      method: "GET",
      headers: h,
      signal: AbortSignal.timeout(10_000),
    });
    const [sres, mres] = await Promise.all([get(""), get("/message?limit=50&order=desc")]);
    if (!sres.ok || !mres.ok) {
      return { terminal: false, reachable: true, error: `HTTP ${sres.ok ? mres.status : sres.status}` };
    }
    const session = (await sres.json()).data;
    const messages = (await mres.json()).data;
    const run = evaluateRun(session, messages, startedAtMs || 0);
    const info = run.final;

    if (run.done) {
      const completed = info?.time?.completed ?? session?.time?.idle ?? Date.now();
      return {
        terminal: true,
        outcome: run.outcome,
        finish: info?.finish,
        completed,
        text: messageText(info),
        info,
      };
    }
    const lastUpdatedAt = Math.max(
      session?.time?.updated ?? 0,
      ...(messages ?? []).map((m) => Math.max(m?.time?.created ?? 0, m?.time?.completed ?? 0)),
    );
    return { terminal: false, reachable: true, lastUpdatedAt, lastInfo: info };
  } catch (err) {
    return { terminal: false, reachable: false, error: err.message };
  }
}

/**
 * Fetch the session's last activity summary for display in `status` output.
 * Never throws — returns null on any failure (unreachable, bad response).
 *
 * Return shape:
 *   null                                         — server unreachable / no info
 *   { kind:"tool", tool, command, ageSec }       — last part is a tool call
 *   { kind:"text", text, ageSec }                — last part is text
 *   { kind:"none", ageSec }                      — session has info but empty parts
 *
 * @param {string} baseUrl
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
export async function getSessionLastActivity(baseUrl, sessionId) {
  if (!sessionId) return null;
  const h = buildHeaders();
  try {
    const res = await fetch(`${baseUrl}/api/session/${sessionId}/message?limit=1&order=desc&type=assistant`, {
      method: "GET",
      headers: h,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const page = await res.json();
    const last = page.data?.[0];
    if (!last) return null;
    const info = last;
    const parts = Array.isArray(last.content) ? last.content : [];

    const updatedMs = Math.max(
      typeof info?.time?.completed === "number" ? info.time.completed : 0,
      typeof info?.time?.created === "number" ? info.time.created : 0,
    );
    const ageSec = updatedMs ? Math.max(0, Math.floor((Date.now() - updatedMs) / 1000)) : null;

    // Walk backwards to find the most recent meaningful part.
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!p) continue;
      if (p.type === "tool") {
        const tool = p.name || "tool";
        let command = "";
        const input = p.state?.input || p.input || {};
        if (tool === "shell" || tool === "bash") command = String(input.command || input.cmd || "");
        else if (tool === "edit" || tool === "write") command = String(input.filePath || input.file_path || input.path || "");
        else if (tool === "read") command = String(input.filePath || input.file_path || input.path || "");
        else command = JSON.stringify(input).slice(0, 120);
        return { kind: "tool", tool, command: command.slice(0, 80), ageSec };
      }
      if (p.type === "text" && typeof p.text === "string" && p.text.trim()) {
        return { kind: "text", text: p.text.trim().slice(0, 80), ageSec };
      }
    }
    return { kind: "none", ageSec };
  } catch {
    return null;
  }
}

/**
 * Parse an ISO-ish timestamp that might be a number or string. Returns epoch ms, or 0.
 */
function toEpochMs(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // tolerate seconds
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Attempt to auto-heal a single job. Mutates persistent state via upsertJob
 * on transitions. Returns the up-to-date job record (healed or not).
 *
 * @param {string} workspace
 * @param {object} job
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]
 * @param {boolean} [opts.dryRun] - when true, do not write state; return `{job, action, details}`
 */
export async function autoHealJob(workspace, job, opts = {}) {
  const baseUrl = opts.baseUrl ?? job?.serverUrl ?? serverUrl();
  const dryRun = !!opts.dryRun;
  const HEALABLE = new Set(["starting", "investigating", "running", "finalizing"]);

  if (!job || !job.opencodeSessionId) {
    return { job, action: "skip", reason: "no opencodeSessionId" };
  }
  if (!HEALABLE.has(job.status)) {
    return { job, action: "skip", reason: `status=${job.status} not healable` };
  }

  const startedAtMs =
    toEpochMs(job.startedAt) ||
    toEpochMs(job.createdAt) ||
    toEpochMs(job.updatedAt) ||
    0;

  const probe = await probeSessionTerminal(baseUrl, job.opencodeSessionId, startedAtMs);

  if (probe.terminal && probe.outcome && probe.outcome !== "succeeded") {
    const errMsg = `session ${probe.outcome}`;
    if (dryRun) return { job, action: "would-fail", details: { errorMessage: errMsg } };
    upsertJob(workspace, {
      id: job.id,
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: errMsg,
      healed: true,
    });
    return {
      job: { ...job, status: "failed", errorMessage: errMsg, healed: true },
      action: "healed-failed",
      details: { errorMessage: errMsg },
    };
  }

  if (probe.terminal) {
    const completedIso = new Date(probe.completed).toISOString();
    const summary = (probe.text || "").slice(0, 500);
    if (dryRun) {
      return {
        job,
        action: "would-complete",
        details: {
          finish: probe.finish,
          completedAt: completedIso,
          textLen: (probe.text || "").length,
        },
      };
    }

    // Persist the result payload to disk so handleResult can surface it.
    try {
      const dataFile = jobDataPath(workspace, job.id);
      ensureDir(path.dirname(dataFile));
      const payload = {
        rendered: probe.text,
        summary,
        healed: true,
        finish: probe.finish,
      };
      fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      // Non-fatal: the status transition below is still useful.
      process.stderr.write(`auto-heal: failed to write data file for ${job.id}: ${err.message}\n`);
    }

    upsertJob(workspace, {
      id: job.id,
      status: "completed",
      completedAt: completedIso,
      phase: "completed",
      result: summary || job.result || null,
      healed: true,
      finish: probe.finish,
    });
    return {
      job: { ...job, status: "completed", completedAt: completedIso, result: summary, healed: true, finish: probe.finish },
      action: "healed-completed",
      details: { finish: probe.finish, textLen: (probe.text || "").length },
    };
  }

  // Not terminal. Can we at least declare it dead?
  if (!probe.reachable) {
    const updatedMs = toEpochMs(job.updatedAt);
    const idleMs = updatedMs ? Date.now() - updatedMs : Infinity;
    if (!isProcessAlive(job.pid) && idleMs >= STALE_IDLE_MS) {
      const errMsg = "server unreachable while worker dead";
      if (dryRun) {
        return { job, action: "would-fail", details: { errorMessage: errMsg } };
      }

      upsertJob(workspace, {
        id: job.id,
        status: "failed",
        completedAt: new Date().toISOString(),
        errorMessage: errMsg,
        healed: true,
      });
      return {
        job: { ...job, status: "failed", errorMessage: errMsg, healed: true },
        action: "healed-failed",
        details: { errorMessage: errMsg },
      };
    }
    return { job, action: "skip", reason: `server unreachable: ${probe.error}` };
  }

  const workerAlive = isProcessAlive(job.pid);
  if (workerAlive) {
    return { job, action: "skip", reason: "worker still alive" };
  }

  const lastUpdateMs = probe.lastUpdatedAt || toEpochMs(job.updatedAt);
  const idleMs = lastUpdateMs ? Date.now() - lastUpdateMs : Infinity;
  if (idleMs < STALE_IDLE_MS) {
    return { job, action: "skip", reason: `idle ${Math.floor(idleMs / 1000)}s < ${STALE_IDLE_MS / 1000}s threshold` };
  }

  const idleSec = Number.isFinite(idleMs) ? Math.floor(idleMs / 1000) : -1;
  const errMsg = `task-worker exited without completion; session last updated ${idleSec}s ago`;

  if (dryRun) {
    return { job, action: "would-fail", details: { errorMessage: errMsg } };
  }

  upsertJob(workspace, {
    id: job.id,
    status: "failed",
    completedAt: new Date().toISOString(),
    errorMessage: errMsg,
    healed: true,
  });
  return {
    job: { ...job, status: "failed", errorMessage: errMsg, healed: true },
    action: "healed-failed",
    details: { errorMessage: errMsg },
  };
}

/**
 * Auto-heal a list of jobs, returning the (possibly updated) jobs in the same
 * order, plus a list of heal actions for reporting.
 *
 * @param {string} workspace
 * @param {object[]} jobs
 * @param {object} [opts]
 * @returns {Promise<{ jobs: object[], actions: object[] }>}
 */
export async function autoHealJobs(workspace, jobs, opts = {}) {
  const actions = [];
  const out = [];
  for (const j of jobs ?? []) {
    try {
      const r = await autoHealJob(workspace, j, opts);
      out.push(r.job ?? j);
      if (r.action && r.action !== "skip") {
        actions.push({ id: j.id, action: r.action, details: r.details });
      }
    } catch (err) {
      // Auto-heal must never crash the caller.
      process.stderr.write(`auto-heal: ${j.id} errored: ${err.message}\n`);
      out.push(j);
    }
  }
  return { jobs: out, actions };
}

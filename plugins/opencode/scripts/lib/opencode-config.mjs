// Worker config check for the headless `opencode serve` the companion spawns.
//
// opencode's tools hang forever in headless mode on any permission that
// resolves to "ask" (sst/opencode#14473). The companion never writes the
// user's opencode.json: it runs the server with a dedicated worker config and
// refuses to start while any permission in it is "ask".
// external_directory and doom_loop default to "ask", so both must be set.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJson } from "./fs.mjs";

export const MUST_BE_EXPLICIT = ["external_directory", "doom_loop"];

/**
 * Worker config path: $OPENCODE_COMPANION_CONFIG, else
 * $XDG_CONFIG_HOME/opencode/worker.json (default ~/.config/opencode/worker.json).
 * @returns {string}
 */
export function resolveConfigPath() {
  if (process.env.OPENCODE_COMPANION_CONFIG) return process.env.OPENCODE_COMPANION_CONFIG;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "worker.json");
}

/**
 * @returns {{ path: string, exists: boolean, data: object }}
 */
export function readOpencodeConfig() {
  const p = resolveConfigPath();
  const exists = fs.existsSync(p);
  const data = exists ? (readJson(p) ?? {}) : {};
  return { path: p, exists, data };
}

/**
 * Permission keys that would hang a headless server: any "ask" (pattern maps
 * included) plus MUST_BE_EXPLICIT keys left unset.
 * @param {object} data
 * @returns {string[]}
 */
export function missingPermissions(data) {
  const perm = data && data.permission;
  if (perm === "ask") return ["permission"];
  if (typeof perm === "string") return [];
  const problems = [];
  const walk = (value, key) => {
    if (value === "ask") problems.push(key);
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, `${key}.${k}`);
    }
  };
  for (const [k, v] of Object.entries(perm || {})) walk(v, k);
  for (const k of MUST_BE_EXPLICIT) {
    if (!perm || perm[k] == null) problems.push(`${k} (unset, defaults to ask)`);
  }
  return problems;
}

/**
 * Validate the worker config. Never writes anything.
 * @returns {{ path: string, exists: boolean, missing: string[] }}
 */
export function checkOpencodeConfig() {
  const { path: p, exists, data } = readOpencodeConfig();
  return { path: p, exists, missing: exists ? missingPermissions(data) : [] };
}

/**
 * Throw unless the worker config exists and has no "ask" permission.
 * @returns {string} the config path, passed to opencode as OPENCODE_CONFIG
 */
export function assertOpencodeConfig() {
  const r = checkOpencodeConfig();
  if (!r.exists) {
    throw new Error(`worker config not found: ${r.path} — create it from worker-config.example.json or set OPENCODE_COMPANION_CONFIG`);
  }
  if (r.missing.length > 0) {
    throw new Error(`worker config ${r.path} would hang headless opencode; set to "allow" or "deny": ${r.missing.join(", ")}`);
  }
  return r.path;
}

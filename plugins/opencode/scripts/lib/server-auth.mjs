import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateRoot } from "./state.mjs";

const file = () => path.join(stateRoot("__server__"), "server.json");

export function readServerState() {
  try {
    const stat = fs.statSync(file());
    if ((stat.mode & 0o077) !== 0) return null;
    const state = JSON.parse(fs.readFileSync(file(), "utf8"));
    return typeof state.password === "string" && state.password ? state : null;
  } catch {
    return null;
  }
}

export function writeServerState(state) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export function newServerPassword() {
  return crypto.randomBytes(32).toString("base64url");
}

export function authHeaders(password = readServerState()?.password) {
  return { Authorization: `Basic ${Buffer.from(`opencode:${password ?? ""}`).toString("base64")}` };
}

export function serverUrl() {
  const state = readServerState();
  return state?.url ?? "http://127.0.0.1:4096";
}

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createTmpDir, cleanupTmpDir } from "./helpers.mjs";
import {
  missingPermissions,
  checkOpencodeConfig,
  assertOpencodeConfig,
  resolveConfigPath,
} from "../plugins/opencode/scripts/lib/opencode-config.mjs";

const SAFE = { external_directory: "deny", doom_loop: "deny" };

describe("missingPermissions", () => {
  it("accepts explicit allow/deny with pattern maps", () => {
    assert.deepEqual(missingPermissions({ permission: { ...SAFE, bash: { "*": "allow", "cat *.env*": "deny" } } }), []);
  });

  it("flags ask at top level, per key, and inside pattern maps", () => {
    assert.deepEqual(missingPermissions({ permission: "ask" }), ["permission"]);
    assert.deepEqual(missingPermissions({ permission: { ...SAFE, edit: "ask" } }), ["edit"]);
    assert.deepEqual(missingPermissions({ permission: { ...SAFE, bash: { "*": "allow", "git push*": "ask" } } }), ["bash.git push*"]);
  });

  it("flags keys that default to ask when unset", () => {
    assert.deepEqual(missingPermissions({}), [
      "external_directory (unset, defaults to ask)",
      "doom_loop (unset, defaults to ask)",
    ]);
  });

  it("treats a blanket string permission other than ask as safe", () => {
    assert.deepEqual(missingPermissions({ permission: "deny" }), []);
  });
});

describe("worker config file", () => {
  let tmp;
  beforeEach(() => {
    tmp = createTmpDir("oc-config");
    process.env.OPENCODE_COMPANION_CONFIG = path.join(tmp, "worker.json");
  });
  afterEach(() => {
    delete process.env.OPENCODE_COMPANION_CONFIG;
    cleanupTmpDir(tmp);
  });

  it("resolves from OPENCODE_COMPANION_CONFIG", () => {
    assert.equal(resolveConfigPath(), path.join(tmp, "worker.json"));
  });

  it("throws when the file is missing and never creates it", () => {
    assert.throws(() => assertOpencodeConfig(), /worker config not found/);
    assert.equal(fs.existsSync(path.join(tmp, "worker.json")), false);
  });

  it("throws on ask and leaves the file untouched", () => {
    const p = path.join(tmp, "worker.json");
    const body = JSON.stringify({ permission: { ...SAFE, bash: "ask" } });
    fs.writeFileSync(p, body);
    assert.throws(() => assertOpencodeConfig(), /bash/);
    assert.equal(fs.readFileSync(p, "utf8"), body);
  });

  it("returns the path for a safe config", () => {
    fs.writeFileSync(path.join(tmp, "worker.json"), JSON.stringify({ permission: SAFE }));
    assert.equal(assertOpencodeConfig(), path.join(tmp, "worker.json"));
    assert.deepEqual(checkOpencodeConfig().missing, []);
  });

  it("the shipped example config passes", () => {
    const example = path.join(import.meta.dirname, "../plugins/opencode/worker-config.example.json");
    fs.copyFileSync(example, path.join(tmp, "worker.json"));
    assert.deepEqual(checkOpencodeConfig().missing, []);
  });
});

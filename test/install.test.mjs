import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALLER = path.join(REPO, "install.mjs");

// Cursor and OpenCode refuse to register on Node < 22.5 (they read SQLite), so
// their assertions only hold where node:sqlite exists.
const [maj, min] = String(process.versions.node).split(".").map(Number);
const sqliteCapable = maj > 22 || (maj === 22 && min >= 5);
const needsSqlite = { skip: sqliteCapable ? false : "installer refuses Cursor/OpenCode below Node 22.5" };

/**
 * install.mjs resolves every target from os.homedir(), which paths.mjs captures
 * at import time — so this has to be a real child process with the home
 * redirected, never an in-process import. That also keeps copyApp() and the
 * global config inside the sandbox.
 */
function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-install-"));
  const project = path.join(home, "project");
  fs.mkdirSync(project, { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (args, cwd = project) => {
    const stdout = path.join(home, "install.stdout");
    const stderr = path.join(home, "install.stderr");
    // File descriptors also work where a Windows sandbox refuses synchronous pipes.
    const out = fs.openSync(stdout, "w");
    const err = fs.openSync(stderr, "w");
    let result;
    try {
      result = spawnSync(process.execPath, [INSTALLER, ...args], {
        cwd,
        stdio: ["ignore", out, err],
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      });
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
    assert.ifError(result.error);
    return { ...result, stdout: fs.readFileSync(stdout, "utf8"), stderr: fs.readFileSync(stderr, "utf8") };
  };

  return {
    home,
    project,
    run,
    read: (rel) => {
      try {
        return fs.readFileSync(path.join(home, rel), "utf8");
      } catch {
        return null;
      }
    },
    readJson: (rel) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(home, rel), "utf8"));
      } catch {
        return null;
      }
    },
    write: (rel, body) => {
      const file = path.join(home, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
    },
  };
}

const CLAUDE_SETTINGS = path.join(".claude", "settings.json");
const CURSOR_HOOKS = path.join(".cursor", "hooks.json");
const OPENCODE_PLUGIN = path.join(".config", "opencode", "plugins", "ai-usage-inspector.js");
const hookText = (value) => JSON.stringify(value);

test("--claude registers a Stop hook and copies the app into the sandbox", (t) => {
  const box = sandbox(t);
  const r = box.run(["--claude"]);
  assert.equal(r.status, 0, r.stderr);

  const settings = box.readJson(CLAUDE_SETTINGS);
  assert.ok(Array.isArray(settings.hooks.Stop), "Stop hook array created");
  assert.match(hookText(settings.hooks.Stop), /ai-usage-inspector/);
  assert.match(hookText(settings.hooks.Stop), /--provider claude/);
  assert.ok(fs.existsSync(path.join(box.home, ".ai-usage-inspector", "app", "src", "record.mjs")));
  assert.ok(fs.existsSync(path.join(box.home, ".ai-usage-inspector", "config.json")), "global defaults seeded");
  // Install corrects stored estimates as a catch-up and records it, so the worker does not
  // repeat the same correction for the same rates.
  assert.ok(fs.existsSync(path.join(box.home, ".ai-usage-inspector", "estimates.json")), "the correction is recorded");
});

test("installing twice does not duplicate the hook", (t) => {
  const box = sandbox(t);
  box.run(["--claude"]);
  const second = box.run(["--claude"]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already registered/);
  assert.equal(box.readJson(CLAUDE_SETTINGS).hooks.Stop.length, 1);
});

test("a user's own Claude settings and hooks survive install and uninstall", (t) => {
  const box = sandbox(t);
  box.write(CLAUDE_SETTINGS, {
    model: "opus",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
  });

  box.run(["--claude"]);
  let settings = box.readJson(CLAUDE_SETTINGS);
  assert.equal(settings.model, "opus", "unrelated settings untouched");
  assert.equal(settings.hooks.Stop.length, 2);

  box.run(["--uninstall", "--claude"]);
  settings = box.readJson(CLAUDE_SETTINGS);
  assert.equal(settings.model, "opus");
  assert.equal(hookText(settings.hooks.Stop).includes("ai-usage-inspector"), false, "ours removed");
  assert.match(hookText(settings.hooks.Stop), /echo mine/, "theirs kept");
});

test("--local writes the project's settings.local.json and leaves the global file alone", (t) => {
  const box = sandbox(t);
  const r = box.run(["--claude", "--local"]);
  assert.equal(r.status, 0, r.stderr);

  const local = JSON.parse(fs.readFileSync(path.join(box.project, ".claude", "settings.local.json"), "utf8"));
  assert.match(hookText(local.hooks.Stop), /--provider claude/);
  assert.equal(box.readJson(CLAUDE_SETTINGS), null, "global settings not created");
  assert.ok(fs.existsSync(path.join(box.project, ".ai-usage", "config.json")), "project config seeded");
});

test("--cursor registers its stop hook and preserves other entries", needsSqlite, (t) => {
  const box = sandbox(t);
  box.write(CURSOR_HOOKS, { version: 1, hooks: { stop: [{ command: "echo mine" }] } });

  assert.equal(box.run(["--cursor"]).status, 0);
  let hooks = box.readJson(CURSOR_HOOKS);
  assert.equal(hooks.hooks.stop.length, 2);
  assert.match(hookText(hooks.hooks.stop), /--provider cursor/);

  box.run(["--uninstall", "--cursor"]);
  hooks = box.readJson(CURSOR_HOOKS);
  assert.deepEqual(hooks.hooks.stop, [{ command: "echo mine" }], "only ours removed");
});

test("--opencode writes a session.idle plugin and uninstall deletes it", needsSqlite, (t) => {
  const box = sandbox(t);
  assert.equal(box.run(["--opencode"]).status, 0);

  const plugin = box.read(OPENCODE_PLUGIN);
  assert.match(plugin, /session\.idle/);
  assert.match(plugin, /--provider/);
  assert.match(plugin, /ai-usage-inspector/);
  assert.match(plugin, /detached: true/, "must outlive a one-shot `opencode run`");

  box.run(["--uninstall", "--opencode"]);
  assert.equal(box.read(OPENCODE_PLUGIN), null);
});

test("scan-only providers report themselves without registering a hook", (t) => {
  const box = sandbox(t);
  const r = box.run(["--kilo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /captured on sync/);
  assert.equal(box.readJson(CLAUDE_SETTINGS), null, "no hook file invented for a scan-only provider");
});

test("an unknown flag fails before anything is written", (t) => {
  const box = sandbox(t);
  const r = box.run(["--bogus"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /unknown option/);
  assert.equal(fs.existsSync(path.join(box.home, ".ai-usage-inspector")), false, "nothing copied");
});

test("--uninstall with no provider flag clears every tool's hook", needsSqlite, (t) => {
  const box = sandbox(t);
  box.run(["--claude"]);
  box.run(["--cursor"]);
  box.run(["--opencode"]);

  assert.equal(box.run(["--uninstall"]).status, 0);
  assert.equal(hookText(box.readJson(CLAUDE_SETTINGS)).includes("ai-usage-inspector"), false);
  assert.equal(hookText(box.readJson(CURSOR_HOOKS)).includes("ai-usage-inspector"), false);
  assert.equal(box.read(OPENCODE_PLUGIN), null);
});

// The point of the launcher is that nobody has to type a command. It is
// generated with the bundle, so a project that has recorded anything has one.
test("a project bundle gets a launcher pointing at its own viewer", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-launcher-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = process.env.AI_USAGE_DIR;
  delete process.env.AI_USAGE_DIR;                 // aggregate mode has no bundle
  t.after(() => { if (saved !== undefined) process.env.AI_USAGE_DIR = saved; });

  const { ensureBundleForTest } = await import("../src/lib/ingest.mjs");
  ensureBundleForTest(dir);

  const name = process.platform === "win32" ? "Open dashboard.cmd"
    : process.platform === "darwin" ? "Open dashboard.command"
    : "open-dashboard.sh";
  const file = path.join(dir, ".ai-usage", name);
  assert.ok(fs.existsSync(file), `expected ${name}`);

  const body = fs.readFileSync(file, "utf8");
  assert.match(body, /launch\.mjs/, "it runs the launcher, not the server directly");
  assert.ok(!/[A-Za-z]:\|\/tmp\//.test(body), "paths stay relative so the project can move");
});

test("an unchanged POSIX launcher has its executable bit restored", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-launchermode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { ensureLauncherForTest } = await import("../src/lib/ingest.mjs");
  ensureLauncherForTest(dir, "linux");

  const original = fs.chmodSync;
  let mode = null;
  try {
    fs.chmodSync = (_file, nextMode) => { mode = nextMode; };
    ensureLauncherForTest(dir, "linux");
  } finally {
    fs.chmodSync = original;
  }
  assert.equal(mode, 0o755, "matching contents must not bypass permission repair");
});

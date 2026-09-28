import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recordInstall, repairDue } from "../src/lib/scan-state.mjs";

const SYNC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sync.mjs");

function runSync(env, provider) {
  const stdout = path.join(env.HOME, "sync.stdout");
  const stderr = path.join(env.HOME, "sync.stderr");
  // File descriptors also work where a Windows sandbox refuses synchronous pipes.
  const out = fs.openSync(stdout, "w");
  const err = fs.openSync(stderr, "w");
  let result;
  try {
    result = spawnSync(process.execPath, [SYNC, "--provider", provider, "--days", "7"], {
      env, stdio: ["ignore", out, err],
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  assert.ifError(result.error);
  return { ...result, stdout: fs.readFileSync(stdout, "utf8"), stderr: fs.readFileSync(stderr, "utf8") };
}

// The dashboard runs `sync --days 7` at start, and on a --local or autoSweep:false
// machine nothing else runs automatically, so sync must honour a repair an upgrade
// asked for, and read the whole history exactly once.
test("sync reads a provider's whole history once when an upgrade owes a repair", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-synchome-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-syncproj-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  const state = path.join(home, "scan-state.json");
  const thread = "019f5143-59f3-7143-8649-4ff9f3b2f7cf";
  const day = path.join(home, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-08-01T10-00-00-${thread}.jsonl`);
  const rec = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
  fs.writeFileSync(rollout, [
    rec("2026-08-01T10:00:00.000Z", "session_meta", { id: thread, cwd: project, cli_version: "0.154.0" }),
    rec("2026-08-01T10:00:01.000Z", "event_msg", { type: "user_message", message: "an old turn" }),
    rec("2026-08-01T10:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 1 }, last_token_usage: { input_tokens: 10, output_tokens: 1 } } }),
  ].join("\n") + "\n");
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(rollout, old, old);

  const env = { ...process.env, HOME: home, USERPROFILE: home, AI_USAGE_SCAN_STATE_FILE: state, NO_COLOR: "1" };
  delete env.AI_USAGE_DIR;
  delete env.CODEX_HOME;
  const usage = path.join(project, ".ai-usage", "usage.ndjson");
  const rows = () => (fs.existsSync(usage) ? fs.readFileSync(usage, "utf8").split("\n").filter(Boolean).length : 0);
  const sync = () => {
    const r = runSync(env, "codex");
    assert.equal(r.status, 0, r.stderr);
  };

  sync();
  assert.equal(rows(), 0, "a 30-day-old rollout is outside a 7-day window");

  await recordInstall({ file: state, upgrading: true, providerIds: ["codex"] });
  sync();
  assert.equal(rows(), 1, "the owed repair reads the whole history");
  assert.equal(repairDue("codex", { file: state }), null, "and settles it");

  fs.rmSync(path.join(project, ".ai-usage"), { recursive: true, force: true });
  sync();
  assert.equal(rows(), 0, "only once");
});

// An older hook left a copy of the session in the subfolder Claude had cd'd into.
// The repair reads the session into its own store, then removes the copy.
for (const blocked of [false, true]) test(blocked
  ? "sync leaves a Claude repair owed and ingests nothing when its backup fails"
  : "the Claude repair removes a copy left in a subfolder, after backing it up", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-synchome-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-syncproj-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  const sub = path.join(project, "web");
  fs.mkdirSync(sub);
  const state = path.join(home, "scan-state.json");
  const session = "11111111-2222-4333-8444-555555555555";
  const prompt = "22222222-3333-4444-8555-666666666666";
  const transcript = path.join(home, ".claude", "projects", "project", `${session}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [
    { type: "user", uuid: prompt, sessionId: session, cwd: project, timestamp: "2026-08-01T10:00:00.000Z", message: { role: "user", content: "build it" } },
    { type: "assistant", uuid: "a1", sessionId: session, cwd: project, timestamp: "2026-08-01T10:00:05.000Z", message: { id: "m1", role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cd web && npm run build" } }], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "user", uuid: "r1", sessionId: session, cwd: sub, timestamp: "2026-08-01T10:00:09.000Z", toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const copyFile = path.join(sub, ".ai-usage", "usage.ndjson");
  fs.mkdirSync(path.dirname(copyFile), { recursive: true });
  fs.writeFileSync(copyFile, JSON.stringify({ provider: "claude", sessionId: session, id: prompt, cwd: project, ts: "2026-08-01T10:00:00.000Z", cost: { total: 1, source: "priced" } }) + "\n");

  const env = { ...process.env, HOME: home, USERPROFILE: home, AI_USAGE_SCAN_STATE_FILE: state, NO_COLOR: "1" };
  delete env.AI_USAGE_DIR;
  await recordInstall({ file: state, upgrading: true, providerIds: ["claude"] });
  if (blocked) {
    fs.mkdirSync(path.join(home, ".ai-usage-inspector"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ai-usage-inspector", "backups"), "blocked");
  }
  const r = runSync(env, "claude");
  if (blocked) {
    assert.equal(fs.existsSync(path.join(project, ".ai-usage", "usage.ndjson")), false);
    assert.notEqual(repairDue("claude", { file: state }), null);
    return;
  }
  assert.equal(r.status, 0, r.stderr);

  const lines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines(path.join(project, ".ai-usage", "usage.ndjson")).length, 1, "the session is whole in its own store");
  assert.equal(lines(copyFile).length, 0, "the copy is gone");
  assert.ok(r.stdout.includes(path.join(sub, ".ai-usage")), "only the emptied usage folder is named");
  assert.match(r.stdout, /store holds no rows; its \.ai-usage folder can be deleted/);
  assert.ok(fs.readdirSync(path.join(home, ".ai-usage-inspector", "backups")).length === 1, "and backed up first");
  assert.equal(repairDue("claude", { file: state }), null);
});

// Sync finds stores through transcripts. A project whose transcripts Claude Code
// has all deleted is reachable no other way, and its dashboard may be opened long
// after the upgrade repair finished; the dashboard names its own store, and sync
// re-measures it every time.
test("sync re-measures the store a dashboard names, even with no transcript left and no repair owed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-synchome-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-orphan-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  const state = path.join(home, "scan-state.json");
  fs.writeFileSync(state, JSON.stringify({ schema: 1, installedRepairEpoch: 99, providers: { claude: { repaired: { default: 99 } } } }));
  const usage = path.join(project, ".ai-usage", "usage.ndjson");
  fs.mkdirSync(path.dirname(usage), { recursive: true });
  fs.writeFileSync(usage, JSON.stringify({ provider: "claude", sessionId: "gone", id: "t1", model: "claude-opus-5", contextTokens: 800_000, contextMax: 200_000, contextFillPct: 400 }) + "\n");

  const env = { ...process.env, HOME: home, USERPROFILE: home, AI_USAGE_SCAN_STATE_FILE: state, NO_COLOR: "1", AI_USAGE_PROJECT_STORE: usage };
  delete env.AI_USAGE_DIR;
  const result = runSync(env, "claude");
  assert.equal(result.status, 0, result.stderr);
  const [row] = fs.readFileSync(usage, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual([row.contextMax, row.contextFillPct], [1_000_000, 80]);
});

// The dashboard refetches rates on every start but corrects nothing, then launches this sync,
// which finds the cache fresh and learns nothing itself. The turn stored with a guessed price
// must still be priced, although its rollout is outside the window this sync reads.
test("sync prices a stored estimate once rates another process fetched know its model", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-synchome-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-syncproj-"));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });
  const state = path.join(home, "scan-state.json");
  const thread = "019f5143-59f3-7143-8649-4ff9f3b2f7d0";
  const day = path.join(home, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-08-01T10-00-00-${thread}.jsonl`);
  const rec = (timestamp, type, payload) => JSON.stringify({ timestamp, type, payload });
  fs.writeFileSync(rollout, [
    rec("2026-08-01T10:00:00.000Z", "session_meta", { id: thread, cwd: project, cli_version: "0.154.0" }),
    rec("2026-08-01T10:00:00.500Z", "turn_context", { model: "gpt-future-sync-8", cwd: project }),
    rec("2026-08-01T10:00:01.000Z", "event_msg", { type: "user_message", message: "an old turn" }),
    rec("2026-08-01T10:00:02.000Z", "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 1000000, output_tokens: 0 }, last_token_usage: { input_tokens: 1000000, output_tokens: 0 } } }),
  ].join("\n") + "\n");
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.utimesSync(rollout, old, old);

  const env = { ...process.env, HOME: home, USERPROFILE: home, AI_USAGE_SCAN_STATE_FILE: state, AI_USAGE_NO_PRICING_REFRESH: "1", NO_COLOR: "1" };
  delete env.AI_USAGE_DIR;
  delete env.CODEX_HOME;
  const usage = path.join(project, ".ai-usage", "usage.ndjson");
  const row = () => JSON.parse(fs.readFileSync(usage, "utf8").trim());
  const sync = () => {
    const r = runSync(env, "codex");
    assert.equal(r.status, 0, r.stderr);
  };

  await recordInstall({ file: state, upgrading: true, providerIds: ["codex"] });
  sync();
  assert.equal(row().cost.source, "estimated", "an unknown model is priced on a guess");

  // What a dashboard start leaves behind: the rate, fetched by someone else.
  const cache = path.join(home, ".ai-usage-inspector", "pricing-codex.json");
  fs.writeFileSync(cache, JSON.stringify({ schema: 3, fetchedAt: Date.now(), attemptedAt: Date.now(),
    rates: { "gpt-future-sync-8": { input: 3, cachedInput: 0.3, output: 12, source: "openai" } } }));
  sync();
  assert.equal(row().cost.source, "priced");
  assert.equal(row().cost.total, 3, "one million input tokens at $3");
});

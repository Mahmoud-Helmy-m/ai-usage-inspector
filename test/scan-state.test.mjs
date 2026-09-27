import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FIRST_SCAN_WINDOW_MS,
  REPAIR_EPOCH,
  SCAN_OVERLAP_MS,
  markRepaired,
  readScanState,
  recordInstall,
  recordScanResult,
  repairDue,
  scanWindow,
} from "../src/lib/scan-state.mjs";

function tmpState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-scanstate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "scan-state.json");
}

test("first scan falls back to the 24h window", (t) => {
  const file = tmpState(t);
  const now = Date.parse("2026-08-10T12:00:00Z");
  const { sinceMs } = scanWindow("cursor", { file, now });
  assert.equal(sinceMs, now - FIRST_SCAN_WINDOW_MS);
});

test("a completed scan advances the mark; the next window uses it with overlap", async (t) => {
  const file = tmpState(t);
  const startedAt = Date.parse("2026-08-10T12:00:00Z");
  await recordScanResult("cursor", { file, scanStartedAtMs: startedAt, status: "ok", completed: true });

  // A week later the window reaches back to the mark, NOT just 24h — this is the
  // outage case the fixed window used to lose.
  const now = startedAt + 7 * 24 * 60 * 60 * 1000;
  const { sinceMs } = scanWindow("cursor", { file, now });
  assert.equal(sinceMs, startedAt - SCAN_OVERLAP_MS);
  assert.ok(sinceMs < now - FIRST_SCAN_WINDOW_MS, "must look back further than 24h");
});

test("a failed or partial scan does NOT advance the mark", async (t) => {
  const file = tmpState(t);
  const good = Date.parse("2026-08-10T12:00:00Z");
  await recordScanResult("opencode", { file, scanStartedAtMs: good, status: "ok", completed: true });

  // healthy store but an ingest failed -> not completed
  await recordScanResult("opencode", { file, scanStartedAtMs: good + 60_000, status: "ok", completed: false });
  // scan ran to the end but the store was locked
  await recordScanResult("opencode", { file, scanStartedAtMs: good + 120_000, status: "locked", completed: true, detail: "database is locked" });

  const state = readScanState(file);
  const entry = state.providers.opencode;
  assert.equal(entry.lastSuccessfulScanMs, good, "mark must stay at the last clean scan");
  assert.equal(entry.lastScanStatus, "locked");
  assert.equal(entry.lastScanDetail, "database is locked");
  assert.equal(scanWindow("opencode", { file, now: good + 999_999 }).sinceMs, good - SCAN_OVERLAP_MS);
});

test("the mark never moves backwards", async (t) => {
  const file = tmpState(t);
  const later = Date.parse("2026-08-10T12:00:00Z");
  await recordScanResult("cursor", { file, scanStartedAtMs: later, status: "ok", completed: true });
  await recordScanResult("cursor", { file, scanStartedAtMs: later - 60 * 60 * 1000, status: "ok", completed: true });
  assert.equal(readScanState(file).providers.cursor.lastSuccessfulScanMs, later);
});

test("providers keep independent marks", async (t) => {
  const file = tmpState(t);
  const a = Date.parse("2026-08-10T12:00:00Z");
  await recordScanResult("cursor", { file, scanStartedAtMs: a, status: "ok", completed: true });
  const state = readScanState(file);
  assert.ok(state.providers.cursor);
  assert.equal(state.providers.opencode, undefined);
  assert.equal(scanWindow("opencode", { file, now: a }).sinceMs, a - FIRST_SCAN_WINDOW_MS);
});

// A fix to how turns are identified or costed reaches a stored row only when its
// session is read again. An upgrade across one reads each agent's history once;
// a fresh install owes nothing and must not import history nobody asked for.
test("a fresh install owes no repair", async (t) => {
  const file = tmpState(t);
  const now = Date.parse("2026-09-15T12:00:00Z");
  assert.equal(await recordInstall({ file, upgrading: false, providerIds: ["claude"] }), false);
  assert.equal(repairDue("claude", { file }), null);
  assert.equal(scanWindow("claude", { file, now }).sinceMs, now - FIRST_SCAN_WINDOW_MS);
});

test("an upgrade reads each agent's whole history until a clean pass settles it", async (t) => {
  const file = tmpState(t);
  const now = Date.parse("2026-09-15T12:00:00Z");
  await recordScanResult("codex", { file, scanStartedAtMs: now - 3_600_000, status: "ok", completed: true });
  assert.equal(await recordInstall({ file, upgrading: true, providerIds: ["codex", "claude"] }), true);

  const window = scanWindow("codex", { file, now });
  assert.equal(window.sinceMs, 0, "the whole history, not the mark");
  assert.equal(window.repairEpoch, REPAIR_EPOCH);

  await recordScanResult("codex", { file, scanStartedAtMs: now, status: "ok", completed: false });
  assert.equal(scanWindow("codex", { file, now }).sinceMs, 0, "a pass that did not finish settles nothing");

  await recordScanResult("codex", { file, scanStartedAtMs: now, status: "ok", completed: true, repairEpoch: window.repairEpoch });
  assert.equal(repairDue("codex", { file }), null);
  assert.equal(scanWindow("codex", { file, now: now + 60_000 }).sinceMs, now - SCAN_OVERLAP_MS, "back to the normal window");
  assert.equal(repairDue("claude", { file }), REPAIR_EPOCH, "each agent is repaired on its own");
});

test("an upgrade from a version that already repairs asks for nothing", async (t) => {
  const file = tmpState(t);
  await recordInstall({ file, upgrading: false, providerIds: ["codex"] });
  assert.equal(await recordInstall({ file, upgrading: true, providerIds: ["codex"] }), false);
  assert.equal(repairDue("codex", { file }), null);
});

test("sync's stamp settles a repair the same way", async (t) => {
  const file = tmpState(t);
  await recordInstall({ file, upgrading: true, providerIds: ["claude"] });
  await markRepaired("claude", REPAIR_EPOCH, { file });
  assert.equal(repairDue("claude", { file }), null);
});

test("a repair settled in an aggregate directory is still owed to the projects' own rows", async (t) => {
  const file = tmpState(t);
  const saved = process.env.AI_USAGE_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_DIR;
    else process.env.AI_USAGE_DIR = saved;
  });
  delete process.env.AI_USAGE_DIR;
  await recordInstall({ file, upgrading: true, providerIds: ["cursor"] });
  process.env.AI_USAGE_DIR = path.join(path.dirname(file), "aggregate");
  await recordScanResult("cursor", { file, scanStartedAtMs: Date.now(), status: "ok", completed: true, repairEpoch: REPAIR_EPOCH });
  assert.equal(repairDue("cursor", { file }), null, "the aggregate copy is repaired");
  delete process.env.AI_USAGE_DIR;
  assert.equal(repairDue("cursor", { file }), REPAIR_EPOCH, "the projects' rows are not");
});

test("one aggregate directory spelled two ways settles one repair on Windows", { skip: process.platform !== "win32" && "paths are case-sensitive here" }, async (t) => {
  const file = tmpState(t);
  const saved = process.env.AI_USAGE_DIR;
  t.after(() => {
    if (saved === undefined) delete process.env.AI_USAGE_DIR;
    else process.env.AI_USAGE_DIR = saved;
  });
  const dir = path.join(path.dirname(file), "Aggregate");
  delete process.env.AI_USAGE_DIR;
  await recordInstall({ file, upgrading: true, providerIds: ["cursor"] });
  process.env.AI_USAGE_DIR = dir.toUpperCase();
  await markRepaired("cursor", REPAIR_EPOCH, { file });
  process.env.AI_USAGE_DIR = dir.toLowerCase();
  assert.equal(repairDue("cursor", { file }), null);
});

// 2.6.0 changes where rows live and how branches and subagent runs count, so an
// install that already repaired at an earlier epoch still owes one more full read.
test("an upgrade from an install repaired at an earlier epoch asks again", async (t) => {
  const file = tmpState(t);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, providers: {}, installedRepairEpoch: 2 }));
  assert.equal(await recordInstall({ file, upgrading: true, providerIds: ["claude"] }), true);
  assert.equal(repairDue("claude", { file }), REPAIR_EPOCH);
  assert.ok(REPAIR_EPOCH >= 2);
});

// Crossing multiple epochs accumulates each affected provider.
test("an upgrade from epoch 3 accumulates repairs including Codex", async (t) => {
  const file = tmpState(t);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, providers: {}, installedRepairEpoch: 3 }));
  assert.equal(await recordInstall({ file, upgrading: true, providerIds: ["opencode", "claude", "codex", "cursor"] }), true);
  assert.equal(repairDue("opencode", { file }), REPAIR_EPOCH);
  for (const id of ["claude", "cursor"]) assert.equal(repairDue(id, { file }), REPAIR_EPOCH);
  assert.equal(repairDue("codex", { file }), REPAIR_EPOCH);
});


test("upgrades through epochs 5, 6 and 7 accumulate their provider scopes", async (t) => {
  const ids = ["opencode", "cline", "roo", "kilo", "claude", "codex", "cursor"];
  assert.equal(REPAIR_EPOCH, 7);
  for (const installed of [2, 3, 4]) {
    const file = tmpState(t);
    fs.writeFileSync(file, JSON.stringify({ schema: 1, installedRepairEpoch: installed, providers: {} }));
    assert.equal(await recordInstall({ file, upgrading: true, providerIds: ids }), true);
    for (const id of ids) assert.equal(repairDue(id, { file }), installed === 2 || ["opencode", "cline", "roo", "kilo", "claude", "cursor", "codex"].includes(id) ? REPAIR_EPOCH : null, `${installed}: ${id}`);
  }
});

test("epoch 7 retains unaffected older debt without requesting absent providers", async (t) => {
  const file = tmpState(t);
  fs.writeFileSync(file, JSON.stringify({ schema: 1, installedRepairEpoch: 4,
    providers: { future: { repairRequested: 3, repaired: { projects: 2 } } } }));
  await recordInstall({ file, upgrading: true, providerIds: ["future"] });
  assert.equal(repairDue("future", { file }), 3);
  assert.equal(repairDue("opencode", { file }), null);
  assert.equal(scanWindow("opencode", { file, now: 2000000000000 }).sinceMs, 2000000000000 - FIRST_SCAN_WINDOW_MS);
});

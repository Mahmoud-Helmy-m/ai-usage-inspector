import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTurns } from "../src/providers/claude/transcript.mjs";
import { costOf as claudeCost } from "../src/providers/claude/pricing.mjs";
import { costOf as codexCost } from "../src/providers/codex/pricing.mjs";
import { buildTurns as buildCodexTurns } from "../src/providers/codex/transcript.mjs";
import { upsertSession } from "../src/lib/store.mjs";

// Claude Code closes a turn that hit an API error, or was interrupted, with an assistant message
// whose model is "<synthetic>" and whose usage is all zeros. It named the turn, measured its
// context, and — priced at the fallback — marked the whole turn estimated.

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-synthetic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const usage = (input, output, extra = {}) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...extra });
const ZERO = usage(0, 0);
const user = (ts, text, extra = {}) => ({ type: "user", uuid: `u-${ts}`, sessionId: "sess-1", cwd: "K:\\repo", timestamp: ts, message: { content: text }, ...extra });
const asst = (ts, id, model, blocks, u, extra = {}) => ({ type: "assistant", timestamp: ts, ...extra, message: { id, model, content: blocks, usage: u } });
const synthetic = (ts, id) => asst(ts, id, "<synthetic>", [{ type: "text", text: "API Error: 529 overloaded" }], ZERO, { isApiErrorMessage: true });

test("a turn ending in a synthetic message keeps the real model, context, tier and a priced cost", (t) => {
  const dir = temp(t);
  const file = path.join(dir, "sess-1.jsonl");
  const subDir = path.join(dir, "sess-1", "subagents");
  writeJsonl(file, [
    user("2026-09-20T10:00:00.000Z", "fix it", { uuid: "u1", promptId: "p1" }),
    asst("2026-09-20T10:00:01.000Z", "m1", "claude-opus-4-8",
      [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "scan", subagent_type: "Explore", prompt: "go" } }],
      usage(1000, 100, { cache_read_input_tokens: 50000, service_tier: "standard" })),
    { type: "user", uuid: "r1", timestamp: "2026-09-20T10:00:09.000Z", toolUseResult: { status: "completed", agentId: "a1" },
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] } },
    synthetic("2026-09-20T10:00:10.000Z", "m2"),
  ]);
  writeJsonl(path.join(subDir, "agent-a1.jsonl"), [
    { type: "user", agentId: "a1", promptId: "p1", isSidechain: true, timestamp: "2026-09-20T10:00:02.000Z", message: { content: "go" } },
    asst("2026-09-20T10:00:03.000Z", "s1", "claude-opus-4-8", [{ type: "text", text: "found" }], usage(2000, 20)),
    synthetic("2026-09-20T10:00:04.000Z", "s2"),
  ]);
  fs.writeFileSync(path.join(subDir, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", description: "scan", toolUseId: "toolu_1", spawnDepth: 1 }));

  const [turn] = buildTurns(file);
  assert.equal(turn.model, "claude-opus-4-8");
  assert.equal(turn.cost.source, "priced");
  assert.equal(turn.cost.estimatedRate, undefined);
  assert.equal(turn.cost.relabels, 4, "says a stored label from before revision 4 may be wrong");
  assert.equal(turn.contextTokens, 1000 + 50000, "measured from the last real request");
  assert.equal(turn.serviceTier, "standard");
  assert.equal(turn.endTs, "2026-09-20T10:00:10.000Z", "the turn still ends at its last message");
  const [run] = turn.subagents;
  assert.equal(run.model, "claude-opus-4-8");
  assert.equal(run.cost.source, "priced");
  assert.equal(run.contextTokens, 2000);
  assert.equal(run.endTs, "2026-09-20T10:00:04.000Z");
});

test("no tokens are never a guess; tokens on an unknown model still are", () => {
  for (const id of ["<synthetic>", "claude-future-9"]) {
    const none = claudeCost(id, ZERO);
    assert.equal(none.source, "priced", id);
    assert.equal(none.relabels, 4, id);
    const some = claudeCost(id, usage(1, 0));
    assert.equal(some.source, "estimated", id);
    assert.equal(some.relabels, undefined, id);
  }
  assert.equal(claudeCost("claude-opus-4-8", usage(1, 0)).relabels, undefined);
  for (const id of ["unknown", "gpt-future-9", "gpt-5.5"]) {
    const none = codexCost(id, { input: 0, cached: 0, output: 0 });
    assert.equal(none.source, "priced", id);
    assert.equal(none.relabels, 1, id);
  }
  assert.equal(codexCost("gpt-future-9", { input: 1 }).source, "estimated");
  assert.equal(codexCost("gpt-future-9", { input: 1 }).relabels, undefined);
});

test("a Codex turn with no tokens is priced and says so", (t) => {
  const file = path.join(temp(t), "rollout-2026-09-20T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl");
  writeJsonl(file, [
    { type: "session_meta", payload: { id: "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", cwd: "K:\\repo" } },
    { type: "turn_context", payload: { model: "unknown-model-9", cwd: "K:\\repo" } },
    { type: "event_msg", timestamp: "2026-09-20T10:00:00Z", payload: { type: "user_message", message: "hi" } },
  ]);
  const [row] = buildCodexTurns(file);
  assert.equal(row.cost.total, 0);
  assert.equal(row.cost.source, "priced");
  assert.equal(row.cost.relabels, 1);
});

const tokens = { input: 1000, output: 100, cacheRead: 50000, cacheCreate: 0 };
const amounts = { input: 0.005, output: 0.0025, cacheRead: 0.025, cacheWrite: 0, total: 0.0325 };
const stored = (cost, extra = {}) => ({ provider: "claude", sessionId: "s", id: "s:0", ts: "2026-09-20T10:00:00.000Z", model: "<synthetic>", usage: tokens, cost: { ...amounts, ...cost }, ...extra });
const reread = (cost = {}, extra = {}) => ({ ...stored({ source: "priced", rates: 4, relabels: 4, ...cost }), model: "claude-opus-4-8", ...extra });
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8").trim());

test("the store takes the corrected label once for an unchanged amount, and keeps the amount otherwise", async (t) => {
  const dir = temp(t);
  const cases = [
    ["stored before revision 4", stored({ source: "estimated", estimatedRate: true, rates: 3 }), reread(), "priced", 0.0325],
    ["stored before costs carried a revision", stored({ source: "estimated", estimatedRate: true }), reread(), "priced", 0.0325],
    // Already at revision 4: the ordinary no-flicker rule keeps the cautious label.
    ["stored at revision 4", stored({ source: "estimated", estimatedRate: true, rates: 4 }), reread(), "estimated", 0.0325],
    // A different amount is the rate on the day; relabelling never restates it.
    ["a different amount", stored({ source: "priced", rates: 3, total: 0.05 }), reread(), "priced", 0.05],
    ["no relabels stamp", stored({ source: "estimated", estimatedRate: true, rates: 3 }), reread({ relabels: undefined }), "estimated", 0.0325],
  ];
  for (const [label, before, after, source, total] of cases) {
    const file = path.join(dir, `${label}.ndjson`);
    await upsertSession(file, "s", [before]);
    await upsertSession(file, "s", [after]);
    const row = read(file);
    assert.equal(row.cost.source, source, label);
    assert.equal(row.cost.total, total, label);
    assert.equal(row.model, "claude-opus-4-8", `${label}: the model is not part of the cost promise`);
  }
});

test("a subagent run takes the corrected label too", async (t) => {
  const file = path.join(temp(t), "runs.ndjson");
  const run = (cost) => ({ agentId: "a1", model: "claude-opus-4-8", usage: tokens, cost: { ...amounts, ...cost } });
  await upsertSession(file, "s", [stored({ source: "priced", rates: 3 }, { subagents: [run({ source: "estimated", estimatedRate: true, rates: 3 })] })]);
  await upsertSession(file, "s", [reread({ relabels: undefined }, { subagents: [run({ source: "priced", rates: 4, relabels: 4 })] })]);
  assert.equal(read(file).subagents[0].cost.source, "priced");
});

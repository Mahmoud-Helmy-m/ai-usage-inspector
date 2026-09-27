import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildTurns } from "../src/providers/claude/transcript.mjs";

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("each session in a transcript keeps its own latest name and title", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    { type: "custom-title", customTitle: "File name" },
    { type: "ai-title", aiTitle: "File title" },
    user("2026-09-01T10:00:00Z", "first", { sessionId: undefined }),
    { type: "custom-title", sessionId: "other", customTitle: "Other name" },
    { type: "ai-title", sessionId: "other", aiTitle: "Other title" },
    user("2026-09-01T10:01:00Z", "second", { sessionId: "other" }),
    { type: "custom-title", sessionId: "sess-1", customTitle: "Renamed file" },
  ]);
  assert.deepEqual(buildTurns(s.file).map((r) => [r.sessionId, r.sessionName, r.sessionTitle]), [
    ["sess-1", "Renamed file", "File title"], ["other", "Other name", "Other title"],
  ]);
});

// <dir>/<session>.jsonl  +  <dir>/<session>/subagents/*.jsonl
function session(t, name = "sess-1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-claude-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, `${name}.jsonl`), subDir: path.join(dir, name, "subagents") };
}

const user = (ts, text, extra = {}) => ({
  type: "user",
  uuid: `u-${ts}`,
  sessionId: "sess-1",
  cwd: "K:\\repo",
  timestamp: ts,
  message: { content: text },
  ...extra,
});
const asst = (ts, id, blocks, usage, extra = {}) => {
  const { message: messageExtra, ...rest } = extra;
  return {
    type: "assistant",
    timestamp: ts,
    ...rest,
    message: { id, model: "claude-sonnet-4-5", content: blocks, usage, ...(messageExtra || {}) },
  };
};
const usage = (input, output, extra = {}) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...extra,
});

test("streamed lines sharing message.id become one API call with the final usage", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "do it"),
    // Same message.id across streamed checkpoints: usage grows, blocks accumulate.
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "partial" }], usage(100, 5)),
    asst("2026-08-10T10:00:03.000Z", "m1", [{ type: "text", text: " done" }], usage(100, 42), {
      message: { stop_reason: "end_turn" },
    }),
  ]);

  const turns = buildTurns(s.file);
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.equal(turn.counts.apiCalls, 1, "one message, not one per streamed line");
  assert.equal(turn.usage.output, 42, "final usage wins, never the sum");
  assert.equal(turn.usage.input, 100);
  assert.equal(turn.response, "partial done");
  assert.equal(turn.model, "claude-sonnet-4-5");
  assert.equal(turn.cost.source, "priced");
  assert.ok(turn.cost.total > 0);
  assert.equal(turn.firstResponseMs, 1000, "TTFT measured to the FIRST streamed line");
  assert.equal(turn.durationMs, 3000);
});

test("tool results, meta entries, and sidechains are not human prompts", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "real prompt"),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "ok" }], usage(10, 1)),
    // none of these may open a turn
    user("2026-08-10T10:00:02.000Z", "meta", { isMeta: true }),
    user("2026-08-10T10:00:03.000Z", "side", { isSidechain: true }),
    { ...user("2026-08-10T10:00:04.000Z", "tool"), toolUseResult: { ok: true } },
    {
      ...user("2026-08-10T10:00:05.000Z", ""),
      message: { content: [{ type: "tool_result", content: "x" }] },
    },
  ]);

  const turns = buildTurns(s.file);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, "real prompt");
});

test("subagent tokens attribute to the initiating prompt; subagentCalls counts files", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "spawn agents", { promptId: "p1" }),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "main" }], usage(100, 10)),
  ]);
  // Two files = two Task invocations; the first has THREE assistant messages, so a
  // flattened message count would report 4 instead of 2.
  writeJsonl(path.join(s.subDir, "a.jsonl"), [
    { type: "user", promptId: "p1", isSidechain: true, timestamp: "2026-08-10T10:00:02.000Z", message: { content: "go" } },
    asst("2026-08-10T10:00:03.000Z", "s1", [{ type: "text", text: "a" }], usage(50, 5)),
    asst("2026-08-10T10:00:04.000Z", "s2", [{ type: "text", text: "b" }], usage(50, 5)),
    asst("2026-08-10T10:00:05.000Z", "s3", [{ type: "text", text: "c" }], usage(50, 5)),
  ]);
  writeJsonl(path.join(s.subDir, "b.jsonl"), [
    { type: "user", promptId: "p1", isSidechain: true, timestamp: "2026-08-10T10:00:06.000Z", message: { content: "go" } },
    asst("2026-08-10T10:00:07.000Z", "s4", [{ type: "text", text: "d" }], usage(50, 5)),
  ]);

  const turn = buildTurns(s.file)[0];
  assert.equal(turn.counts.subagentCalls, 2, "invocations = files, not assistant messages");
  assert.equal(turn.counts.apiCalls, 1, "main-thread calls only");
  assert.equal(turn.usage.input, 100 + 4 * 50, "subagent tokens roll into the parent turn");
  assert.equal(turn.usage.output, 10 + 4 * 5);
  assert.equal(turn.response, "main", "subagent text stays out of the parent response");
});

test("skills, tool calls, and thinking blocks are counted from the turn", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "use a skill"),
    asst("2026-08-10T10:00:01.000Z", "m1", [
      { type: "thinking", thinking: "hmm" },
      { type: "tool_use", name: "Skill", input: { skill: "caveman" } },
      { type: "tool_use", name: "Read", input: { file: "x" } },
      { type: "tool_use", name: "Skill", input: { skill: "caveman" } }, // duplicate -> once
      { type: "text", text: "done" },
    ], usage(10, 2)),
  ]);

  const turn = buildTurns(s.file)[0];
  assert.deepEqual(turn.skills, ["caveman"]);
  assert.equal(turn.counts.toolCalls, 3);
  assert.equal(turn.counts.thinkingBlocks, 1);
});

test("context fill uses the last request's full input, not the token sum", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "a"),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "x" }], usage(1000, 5)),
    asst("2026-08-10T10:00:02.000Z", "m2", [{ type: "text", text: "y" }], usage(2000, 5, {
      cache_read_input_tokens: 500,
    })),
  ]);

  const turn = buildTurns(s.file)[0];
  assert.equal(turn.usage.input, 3000, "usage totals still sum every call");
  assert.equal(turn.contextTokens, 2500, "context = last call's input + cache read");
  assert.ok(turn.contextMax > 0);
});

test("a missing or empty transcript yields no turns", (t) => {
  const s = session(t);
  assert.deepEqual(buildTurns(path.join(s.dir, "nope.jsonl")), []);
  writeJsonl(s.file, []);
  assert.deepEqual(buildTurns(s.file), []);
});

test("torn trailing lines are skipped without losing earlier turns", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "keep me"),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "ok" }], usage(10, 1)),
  ]);
  fs.appendFileSync(s.file, '{"type":"assistant","message":{"id":"m2"'); // half-written line

  const turns = buildTurns(s.file);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, "keep me");
});

// Only turns an older version could not identify carry a legacy id: no uuid and
// no entry-level session, which it stored as "undefined:<promptId or ts>".
// Everything else must not gain the field.
test("a turn the old identity scheme could not name carries its legacy id", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-legacyid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sess-x.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "user", promptId: "p1", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "no uuid, no session" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:05.000Z", message: { id: "m1", role: "assistant", model: "claude-opus-4-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } } }),
    JSON.stringify({ type: "user", uuid: "u2", sessionId: "s1", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "user", content: "normal turn" } }),
    JSON.stringify({ type: "assistant", uuid: "a2", sessionId: "s1", timestamp: "2026-01-01T00:01:05.000Z", message: { id: "m2", role: "assistant", model: "claude-opus-4-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } } }),
  ].join("\n") + "\n");

  const turns = buildTurns(file, {});
  assert.equal(turns.length, 2);
  assert.equal(turns[0].legacyId, "undefined:p1", "built from promptId, as the old scheme did");
  assert.equal(turns[1].legacyId, undefined, "a turn with a uuid never had a legacy id");
});

// After /compact, Claude Code writes earlier prompts into the transcript again:
// the same uuid under a new promptId, with none of the turn's work after it. The
// replay must not open a second turn and take the real one's place.
test("a prompt replayed after compaction opens no second turn", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "spawn agents", { uuid: "u-real", promptId: "p1" }),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "main" }], usage(100, 10)),
    { type: "system", subtype: "compact_boundary", timestamp: "2026-08-10T11:00:00.000Z" },
    user("2026-08-10T10:00:00.000Z", "spawn agents", { uuid: "u-real", promptId: "p1-replayed" }),
  ]);
  writeJsonl(path.join(s.subDir, "a.jsonl"), [
    { type: "user", promptId: "p1", isSidechain: true, timestamp: "2026-08-10T10:00:02.000Z", message: { content: "go" } },
    asst("2026-08-10T10:00:03.000Z", "s1", [{ type: "text", text: "a" }], usage(50, 5)),
  ]);

  const turns = buildTurns(s.file);
  assert.equal(turns.length, 1, "the replay is not a turn");
  assert.equal(turns[0].usage.input, 100 + 50, "main and subagent tokens stay on the real turn");
  assert.equal(turns[0].counts.subagentCalls, 1);
});

const agentCall = (id, input = {}) => ({ type: "tool_use", id, name: "Agent", input: { description: "scan files", subagent_type: "Explore", prompt: "go", ...input } });
const callResult = (ts, toolUseId, toolUseResult) => ({
  type: "user",
  uuid: `r-${toolUseId}`,
  timestamp: ts,
  toolUseResult,
  message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "done" }] },
});
const runStart = (agentId, ts) => ({ type: "user", agentId, promptId: "p1", isSidechain: true, timestamp: ts, message: { content: "go" } });
const sidecar = (s, agentId, meta) => fs.writeFileSync(path.join(s.subDir, `agent-${agentId}.meta.json`), JSON.stringify(meta));

// A slash command writes its command line, its output and the expanded prompt as
// three entries of one prompt. Each opened a turn, and each was handed the
// prompt's whole subagent usage, so one run was counted three times.
test("a subagent run belongs to the turn whose call launched it, and is counted once", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "<command-name>/review</command-name>", { uuid: "u1", promptId: "p1" }),
    user("2026-08-10T10:00:00.100Z", "<local-command-stdout>ok</local-command-stdout>", { uuid: "u2", promptId: "p1" }),
    user("2026-08-10T10:00:01.000Z", "review the diff", { uuid: "u3", promptId: "p1" }),
    asst("2026-08-10T10:00:02.000Z", "m1", [agentCall("toolu_1")], usage(100, 10)),
    callResult("2026-08-10T10:00:09.000Z", "toolu_1", { status: "completed", agentId: "a1" }),
    // A later entry of the same prompt that also did work: without the sidecar's
    // link, this is the turn a run would have gone to.
    user("2026-08-10T10:00:10.000Z", "<task-notification>done</task-notification>", { uuid: "u4", promptId: "p1" }),
    asst("2026-08-10T10:00:11.000Z", "m2", [{ type: "text", text: "noted" }], usage(5, 1)),
  ]);
  writeJsonl(path.join(s.subDir, "agent-a1.jsonl"), [
    runStart("a1", "2026-08-10T10:00:03.000Z"),
    asst("2026-08-10T10:00:04.000Z", "s1", [{ type: "text", text: "found" }], usage(50, 5)),
    asst("2026-08-10T10:00:08.000Z", "s2", [{ type: "tool_use", id: "t-read", name: "Read", input: {} }], usage(60, 6)),
  ]);
  sidecar(s, "a1", { agentType: "Explore", description: "scan files", toolUseId: "toolu_1", spawnDepth: 1 });

  const turns = buildTurns(s.file);
  assert.equal(turns.length, 4);
  assert.equal(turns.reduce((n, x) => n + x.usage.input, 0), 100 + 5 + 50 + 60, "the run's tokens counted once");
  assert.deepEqual(turns.filter((x) => x.subagents).map((x) => x.id), ["u3"], "only the turn that made the call");
  const owner = turns.find((x) => x.id === "u3");
  assert.equal(owner.counts.subagentCalls, 1);
  const [run] = owner.subagents;
  assert.equal(run.agentId, "a1");
  assert.equal(run.agentType, "Explore");
  assert.equal(run.description, "scan files");
  assert.equal(run.status, "completed");
  assert.equal(run.background, false);
  assert.equal(run.usage.input, 110, "a run carries its own share");
  assert.equal(run.counts.apiCalls, 2);
  assert.equal(run.counts.toolCalls, 1);
  assert.equal(run.durationMs, 5000);
  assert.ok(run.cost.total > 0);
});

test("without a sidecar, a run goes to the last turn of its prompt that did any work", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "<command-name>/review</command-name>", { uuid: "u1", promptId: "p1" }),
    user("2026-08-10T10:00:00.100Z", "<local-command-stdout>ok</local-command-stdout>", { uuid: "u2", promptId: "p1" }),
    user("2026-08-10T10:00:01.000Z", "review the diff", { uuid: "u3", promptId: "p1" }),
    asst("2026-08-10T10:00:02.000Z", "m1", [{ type: "text", text: "main" }], usage(100, 10)),
  ]);
  writeJsonl(path.join(s.subDir, "old-run.jsonl"), [
    runStart("a1", "2026-08-10T10:00:03.000Z"),
    asst("2026-08-10T10:00:04.000Z", "s1", [{ type: "text", text: "found" }], usage(50, 5)),
  ]);

  const turns = buildTurns(s.file);
  assert.equal(turns.reduce((n, x) => n + x.usage.input, 0), 150);
  assert.deepEqual(turns.filter((x) => x.subagents).map((x) => x.id), ["u3"]);
});

test("a run launched by another run nests beneath it", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "go deep", { uuid: "u1", promptId: "p1" }),
    asst("2026-08-10T10:00:01.000Z", "m1", [agentCall("toolu_1")], usage(100, 10)),
  ]);
  writeJsonl(path.join(s.subDir, "agent-a1.jsonl"), [
    runStart("a1", "2026-08-10T10:00:02.000Z"),
    asst("2026-08-10T10:00:03.000Z", "s1", [agentCall("toolu_2", { subagent_type: "general-purpose" })], usage(50, 5)),
  ]);
  sidecar(s, "a1", { agentType: "Explore", toolUseId: "toolu_1", spawnDepth: 1 });
  writeJsonl(path.join(s.subDir, "agent-a2.jsonl"), [
    runStart("a2", "2026-08-10T10:00:04.000Z"),
    asst("2026-08-10T10:00:05.000Z", "s2", [{ type: "text", text: "leaf" }], usage(30, 3)),
  ]);
  sidecar(s, "a2", { agentType: "general-purpose", toolUseId: "toolu_2", spawnDepth: 2 });

  const [turn] = buildTurns(s.file);
  assert.equal(turn.subagents.length, 1);
  assert.equal(turn.subagents[0].agentId, "a1");
  assert.deepEqual(turn.subagents[0].subagents.map((r) => r.agentId), ["a2"]);
  assert.equal(turn.subagents[0].usage.input, 50, "a parent run's share excludes its children");
  assert.equal(turn.counts.subagentCalls, 2);
  assert.equal(turn.usage.input, 100 + 50 + 30, "the turn counts the whole tree once");
});

test("a run started in the background says so", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-08-10T10:00:00.000Z", "in the background", { uuid: "u1", promptId: "p1" }),
    asst("2026-08-10T10:00:01.000Z", "m1", [agentCall("toolu_1", { run_in_background: true })], usage(100, 10)),
    callResult("2026-08-10T10:00:01.500Z", "toolu_1", { status: "async_launched", isAsync: true, agentId: "a1" }),
  ]);
  writeJsonl(path.join(s.subDir, "agent-a1.jsonl"), [
    runStart("a1", "2026-08-10T10:00:02.000Z"),
    asst("2026-08-10T10:00:30.000Z", "s1", [{ type: "text", text: "later" }], usage(50, 5)),
  ]);
  sidecar(s, "a1", { agentType: "Explore", toolUseId: "toolu_1", spawnDepth: 1 });

  const [run] = buildTurns(s.file)[0].subagents;
  assert.equal(run.background, true);
  assert.equal(run.status, "async_launched");
  assert.equal(run.usage.input, 50, "its work is read from its own file");
});

test("every turn carries the session's current name and generated title", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    { type: "ai-title", aiTitle: "Fix the login flow", sessionId: "sess-1" },
    { type: "custom-title", customTitle: "first name", sessionId: "sess-1" },
    user("2026-08-10T10:00:00.000Z", "one"),
    asst("2026-08-10T10:00:01.000Z", "m1", [{ type: "text", text: "ok" }], usage(10, 1)),
    { type: "custom-title", customTitle: "renamed", sessionId: "sess-1" },
    user("2026-08-10T10:01:00.000Z", "two"),
    asst("2026-08-10T10:01:01.000Z", "m2", [{ type: "text", text: "ok" }], usage(10, 1)),
  ]);
  const turns = buildTurns(s.file);
  assert.deepEqual(turns.map((x) => x.sessionName), ["renamed", "renamed"], "the last name is current, for every turn");
  assert.deepEqual(turns.map((x) => x.sessionTitle), ["Fix the login flow", "Fix the login flow"]);

  const plain = session(t, "sess-2");
  writeJsonl(plain.file, [user("2026-08-10T10:00:00.000Z", "one"), asst("2026-08-10T10:00:01.000Z", "m1", [], usage(1, 1))]);
  const [unnamed] = buildTurns(plain.file);
  assert.equal(unnamed.sessionName, null);
  assert.equal(unnamed.sessionTitle, null);
});

// A branch or fork opens with entries written when it was made, then the history
// it copied from its original, whose timestamps are older.
test("turns a branch copied from an earlier session are marked as copies", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    { type: "custom-title", customTitle: "fork", sessionId: "sess-1" },
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-08-10T12:00:00.000Z", sessionId: "sess-1" },
    user("2026-08-10T10:00:00.000Z", "copied prompt", { uuid: "u1" }),
    asst("2026-08-10T10:00:05.000Z", "m1", [{ type: "text", text: "ok" }], usage(10, 1)),
    user("2026-08-10T12:00:01.000Z", "the branch's own prompt", { uuid: "u2" }),
    asst("2026-08-10T12:00:05.000Z", "m2", [{ type: "text", text: "ok" }], usage(10, 1)),
  ]);
  const turns = buildTurns(s.file);
  assert.equal(turns[0].copied, true);
  assert.equal(turns[1].copied, undefined);

  // An original whose first prompt is stamped a few seconds before its first entry
  // is clock skew between entries written together, not a copy.
  const original = session(t, "sess-2");
  writeJsonl(original.file, [
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-08-10T10:00:03.000Z", sessionId: "sess-2" },
    user("2026-08-10T10:00:00.000Z", "first", { uuid: "u3", sessionId: "sess-2" }),
    asst("2026-08-10T10:00:05.000Z", "m3", [{ type: "text", text: "ok" }], usage(10, 1)),
  ]);
  assert.equal(buildTurns(original.file)[0].copied, undefined);
});

// The main thread and each subagent run are separate conversations with windows
// of their own. A run that filled its window says so on the run; it does not make
// the turn look full, and the turn's figure is its main thread's alone.
test("the main thread and each subagent run report their own context, never a merged one", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-09-10T10:00:00.000Z", "look into it", { uuid: "u1", promptId: "p1" }),
    asst("2026-09-10T10:00:01.000Z", "m1", [agentCall("toolu_ctx")], usage(1000, 10, { cache_read_input_tokens: 99_000 }), { message: { model: "claude-opus-5" } }),
    callResult("2026-09-10T10:00:30.000Z", "toolu_ctx", { status: "completed", agentId: "big" }),
    asst("2026-09-10T10:00:31.000Z", "m2", [{ type: "text", text: "done" }], usage(2000, 20, { cache_read_input_tokens: 198_000 }), { message: { model: "claude-opus-5" } }),
  ]);
  writeJsonl(path.join(s.subDir, "agent-big.jsonl"), [
    runStart("big", "2026-09-10T10:00:02.000Z"),
    asst("2026-09-10T10:00:10.000Z", "r1", [{ type: "text", text: "reading" }], usage(1000, 5, { cache_read_input_tokens: 299_000 }), { message: { model: "claude-sonnet-5" } }),
    asst("2026-09-10T10:00:20.000Z", "r2", [{ type: "text", text: "read it all" }], usage(1000, 5, { cache_read_input_tokens: 599_000 }), { message: { model: "claude-sonnet-5" } }),
  ]);
  sidecar(s, "big", { agentType: "Explore", description: "read everything", toolUseId: "toolu_ctx", spawnDepth: 1 });

  const [turn] = buildTurns(s.file);
  assert.equal(turn.contextTokens, 200_000, "the turn: its main thread's last request, and nothing of the run's");
  assert.equal(turn.contextMax, 1_000_000, "Opus 5 has a 1M window");
  assert.equal(turn.contextFillPct, 20);
  const [run] = turn.subagents;
  assert.equal(run.contextTokens, 600_000, "the run: its own last request");
  assert.equal(run.contextMax, 1_000_000, "measured against the run's own model");
  assert.equal(run.contextFillPct, 60);
});

// A model released after this version shipped has no window here. A request
// larger than the guessed window proves the guess wrong, and Claude's only window
// above 200k is 1M — so a context is never reported several times full.
test("a model with no known window is never reported more than full", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-09-10T10:00:00.000Z", "go", { uuid: "u1" }),
    asst("2026-09-10T10:00:01.000Z", "m1", [{ type: "text", text: "ok" }], usage(1000, 10, { cache_read_input_tokens: 499_000 }), { message: { model: "claude-opus-9" } }),
  ]);
  const [turn] = buildTurns(s.file);
  assert.equal(turn.contextMax, 1_000_000);
  assert.equal(turn.contextFillPct, 50);
  assert.ok(turn.contextFillPct <= 100);
});

// A stored cost is kept while its tokens are unchanged, except when it predates a
// correction to its model's rates. That test reads the revision off the stored
// row, so a parsed turn must carry it — or a corrected cost would be worked out
// again on every read instead of settling.
test("a parsed turn carries the rate revision its cost was worked out under", (t) => {
  const s = session(t);
  writeJsonl(s.file, [
    user("2026-09-10T10:00:00.000Z", "go", { uuid: "u1" }),
    asst("2026-09-10T10:00:01.000Z", "m1", [{ type: "text", text: "ok" }], usage(10, 1, { cache_read_input_tokens: 1_000_000 }), { message: { model: "claude-fable-5-1" } }),
  ]);
  const [turn] = buildTurns(s.file);
  assert.equal(turn.cost.rates, 4);
  assert.equal(turn.cost.supersedes, 2);
  assert.equal(turn.cost.cacheRead, 0.25, "a million cache-read tokens on Fable 5.1");
});

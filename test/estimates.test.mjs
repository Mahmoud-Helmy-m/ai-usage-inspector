import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as claude from "../src/providers/claude/index.mjs";
import { applyRemoteRates, costOf, guessedModels, clearGuessedModels, pricedModel } from "../src/providers/claude/pricing.mjs";
import { ingestTranscript } from "../src/lib/ingest.mjs";
import { upsertSession } from "../src/lib/store.mjs";
import { correctEstimatedCosts, correctable, correctAll, ratesChangedSinceCorrection } from "../src/lib/estimates.mjs";
import { refreshRatesAndCorrect } from "../src/worker.mjs";

const tmp = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-usage-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const rows = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const turnUsage = { input: 1_000, output: 10_000, reasoning: 0, cacheCreate: 20_000, cacheRead: 200_000, cacheCreate1h: 0, cacheCreate5m: 20_000, webSearch: 0, webFetch: 0 };
const row = (cost, usage = turnUsage) => ({ provider: "claude", sessionId: "s", id: "s:0", ts: "2026-09-26T21:00:00.000Z", model: "claude-opus-5-5", usage, cost });

// ---------- the store rule ----------

test("a stored estimate gives way to a real price for the same tokens, runs included", async (t) => {
  const file = path.join(tmp(t, "est-store"), "usage.ndjson");
  await upsertSession(file, "s", [row({ input: 0.005, output: 0.25, cacheRead: 0.1, cacheWrite: 0.125, total: 0.48, source: "estimated", estimatedRate: true })]);
  const priced = { input: 0.004, output: 0.2, cacheRead: 0.04, cacheWrite: 0.1, total: 0.344, source: "priced", rates: 2 };
  await upsertSession(file, "s", [row(priced)]);
  assert.equal(rows(file)[0].cost.source, "priced");
  assert.equal(rows(file)[0].cost.total, 0.344);
});

test("an estimate that happened to be right keeps its cautious label, and a priced cost is never restated", async (t) => {
  const dir = tmp(t, "est-keep");
  const same = path.join(dir, "same.ndjson");
  await upsertSession(same, "s", [row({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.344, source: "estimated" })]);
  await upsertSession(same, "s", [row({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.344, source: "priced" })]);
  assert.equal(rows(same)[0].cost.source, "estimated", "no flicker when a guess landed on the real amount");
  const kept = path.join(dir, "kept.ndjson");
  await upsertSession(kept, "s", [row({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.3, source: "priced" })]);
  await upsertSession(kept, "s", [row({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.9, source: "estimated" })]);
  assert.equal(rows(kept)[0].cost.total, 0.3, "a real price is never replaced by a guess");
});

test("--relabel never changes an amount, even an estimate a real rate now contradicts", async (t) => {
  const file = path.join(tmp(t, "est-relabel"), "usage.ndjson");
  await upsertSession(file, "s", [row({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.48, source: "estimated" })]);
  process.env.AI_USAGE_RELABEL = "1";
  try {
    await upsertSession(file, "s", [row({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.344, source: "priced" })]);
  } finally { delete process.env.AI_USAGE_RELABEL; }
  assert.equal(rows(file)[0].cost.total, 0.48);
});

// ---------- remembering guesses ----------

test("pricing remembers the real models it had to guess, and nothing else", () => {
  clearGuessedModels();
  const u = { input_tokens: 10, output_tokens: 10 };
  costOf("claude-opus-5", u);
  costOf("<synthetic>", u);
  costOf("unknown", u);
  costOf("claude-guess-test-1", { input_tokens: 0, output_tokens: 0 });
  assert.deepEqual(guessedModels(), [], "known models, synthetic turns, unknown ids and empty turns are not guesses worth a fetch");
  costOf("Claude-Guess-Test-2-20260901", u);
  assert.deepEqual(guessedModels(), ["claude-guess-test-2"], "normalised: case and date snapshot");
  clearGuessedModels();
  assert.deepEqual(guessedModels(), []);
});

test("a row is worth re-reading only when every guessed part now has a real rate", () => {
  const known = (m) => m === "claude-opus-5-5";
  const base = { cost: { source: "estimated" }, usage: { input: 5 }, model: "claude-opus-5-5" };
  assert.equal(correctable(base, known), true);
  assert.equal(correctable({ ...base, cost: { source: "priced" } }, known), false, "priced rows are left alone");
  assert.equal(correctable({ ...base, usage: { input: 0 } }, known), false, "nothing to price");
  assert.equal(correctable({ ...base, model: "claude-next" }, known), false, "still unknown");
  const withRun = { ...base, subagents: [{ model: "claude-next", cost: { source: "estimated" }, usage: { input: 1 }, subagents: [] }] };
  assert.equal(correctable(withRun, known), false, "a run still guessed would keep the turn an estimate");
  const pricedRun = { ...base, subagents: [{ model: "claude-haiku-4-5", cost: { source: "priced" }, usage: { input: 1 }, subagents: [] }] };
  assert.equal(correctable(pricedRun, known), true);
});

// ---------- the correction pass, end to end ----------

test("once a new model's rate is known, the turns stored as estimates are priced from their transcripts", async (t) => {
  const project = tmp(t, "est-e2e");
  const transcriptDir = tmp(t, "est-transcripts");
  const sid = "0e0e0e0e-1111-4222-8333-444444444444";
  const transcriptPath = path.join(transcriptDir, `${sid}.jsonl`);
  const model = "claude-future-e2e-7";
  const usage = { input_tokens: 1_000, output_tokens: 10_000, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 20_000 };
  fs.writeFileSync(transcriptPath, [
    { type: "user", uuid: "u1", sessionId: sid, cwd: project, timestamp: "2026-09-26T21:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: sid, cwd: project, timestamp: "2026-09-26T21:00:30.000Z",
      message: { id: "m1", role: "assistant", model, usage, content: [{ type: "text", text: "ok" }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ref = { transcriptPath, cwd: project };
  await ingestTranscript(claude, ref);
  const store = path.join(project, ".ai-usage", "usage.ndjson");
  const before = rows(store)[0];
  assert.equal(before.cost.source, "estimated", "an unknown model is priced by guess");
  assert.equal(pricedModel(model), false);

  // Nothing can be priced yet: the pass finds the row but re-reads nothing.
  let c = await correctEstimatedCosts(claude, { transcripts: [ref] });
  assert.equal(c.reread, 0);

  applyRemoteRates({ [model]: { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 } }, { [model]: 1_000_000 });
  c = await correctEstimatedCosts(claude, { transcripts: [ref] });
  assert.deepEqual({ rows: c.rows, reread: c.reread }, { rows: 1, reread: 1 });
  const after = rows(store)[0];
  assert.equal(after.cost.source, "priced");
  const expected = (1_000 * 4 + 10_000 * 20 + 200_000 * 0.2 + 20_000 * 5) / 1e6;
  assert.ok(Math.abs(after.cost.total - expected) < 1e-9, `${after.cost.total} vs ${expected}`);
  assert.ok(after.cost.total < before.cost.total, "the guess was higher than the real rate");
  assert.equal(rows(store).length, 1, "re-read in place, nothing duplicated");

  assert.equal(c.priced, 1, "counts what actually became priced");

  c = await correctEstimatedCosts(claude, { transcripts: [ref] });
  assert.equal(c.rows, 0, "a second pass finds nothing left to price");
});

test("a turn whose guess came from a message the row does not name stays an estimate, and is not counted as priced", async (t) => {
  const project = tmp(t, "est-hidden");
  const transcriptDir = tmp(t, "est-hidden-t");
  const sid = "0f0f0f0f-1111-4222-8333-555555555555";
  const transcriptPath = path.join(transcriptDir, `${sid}.jsonl`);
  const u = { input_tokens: 500, output_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // A still-unknown model answers first; a known one answers last and names the turn.
  fs.writeFileSync(transcriptPath, [
    { type: "user", uuid: "u1", sessionId: sid, cwd: project, timestamp: "2026-09-26T22:00:00.000Z", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: sid, cwd: project, timestamp: "2026-09-26T22:00:10.000Z",
      message: { id: "m1", role: "assistant", model: "claude-still-unknown-3", usage: u, content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
    { type: "user", uuid: "u2", parentUuid: "a1", sessionId: sid, cwd: project, timestamp: "2026-09-26T22:00:11.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } },
    { type: "assistant", uuid: "a2", parentUuid: "u2", sessionId: sid, cwd: project, timestamp: "2026-09-26T22:00:20.000Z",
      message: { id: "m2", role: "assistant", model: "claude-opus-5", usage: u, content: [{ type: "text", text: "ok" }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const ref = { transcriptPath, cwd: project };
  await ingestTranscript(claude, ref);
  const store = path.join(project, ".ai-usage", "usage.ndjson");
  const [stored] = rows(store);
  assert.equal(stored.cost.source, "estimated");
  if (stored.model !== "claude-opus-5") return; // the row names the unknown model: nothing looks priceable
  const c = await correctEstimatedCosts(claude, { transcripts: [ref] });
  assert.equal(c.rows, 1, "looks priceable from what the row records");
  assert.equal(c.priced, 0, "but the re-read is still an estimate, and is not reported as priced");
  assert.equal(rows(store)[0].cost.source, "estimated");
});

// ---------- the worker ----------

function fakeClaude({ guessed = [], priced = () => false, status = "fresh" } = {}) {
  const calls = { refresh: [], cleared: 0 };
  return {
    calls,
    provider: {
      id: "claude",
      transcriptId: (file) => file,
      guessedModels: () => guessed,
      clearGuessedModels: () => { calls.cleared++; },
      pricedModel: priced,
      refreshPricing: async (o) => { calls.refresh.push(o); return { status }; },
    },
  };
}

test("the worker refreshes rates on its own, within the hour when a turn had to guess", async () => {
  const zai = [];
  const refreshZai = async (o) => { zai.push(o); return { status: "fresh" }; };
  let corrected = 0;
  const correct = async () => { corrected++; return { rows: 0 }; };

  let f = fakeClaude();
  await refreshRatesAndCorrect({ providers: [f.provider], refreshZai, correct, ratesChanged: () => false });
  assert.equal(f.calls.refresh[0].ttlMs, 12 * 3600e3, "twelve-hourly when nothing was guessed");
  assert.equal(zai[0].ttlMs, 12 * 3600e3);
  assert.equal(corrected, 0, "nothing learned, nothing to correct");

  f = fakeClaude({ guessed: ["claude-opus-5-5"] });
  await refreshRatesAndCorrect({ providers: [f.provider], refreshZai, correct, ratesChanged: () => false });
  assert.equal(f.calls.refresh[0].ttlMs, 3600e3, "an Anthropic guess refreshes Anthropic's rates within the hour");
  assert.equal(zai[1].ttlMs, 12 * 3600e3, "and leaves z.ai on its usual schedule");
  assert.equal(f.calls.cleared, 1, "guesses are forgotten once handled");

  f = fakeClaude({ guessed: ["glm-9"] });
  await refreshRatesAndCorrect({ providers: [f.provider], refreshZai, correct, ratesChanged: () => false });
  assert.equal(zai[2].ttlMs, 3600e3, "a GLM guess refreshes z.ai's rates within the hour");
  assert.equal(f.calls.refresh[0].ttlMs, 12 * 3600e3);
});

test("the worker prices stored estimates when rates were learned, or when a guess is already priceable", async () => {
  const refreshZai = async () => ({ status: "fresh" });
  let corrected = 0;
  const correct = async () => { corrected++; return { rows: 1 }; };
  await refreshRatesAndCorrect({ providers: [fakeClaude({ status: "updated" }).provider], refreshZai, correct, ratesChanged: () => false });
  assert.equal(corrected, 1, "new rates arrived");
  await refreshRatesAndCorrect({ providers: [fakeClaude({ guessed: ["m"], priced: () => true }).provider], refreshZai, correct, ratesChanged: () => false });
  assert.equal(corrected, 2, "another process already learned the rate");
  await refreshRatesAndCorrect({ providers: [fakeClaude({ guessed: ["m"], priced: () => false }).provider], refreshZai, correct, ratesChanged: () => false });
  assert.equal(corrected, 2, "still unknown: nothing to re-read");
  const failing = fakeClaude({ status: "updated" });
  failing.provider.refreshPricing = async () => { throw new Error("offline"); };
  await refreshRatesAndCorrect({ providers: [failing.provider], refreshZai: async () => { throw new Error("offline"); }, correct, ratesChanged: () => false });
  assert.equal(corrected, 2, "a failed refresh learns nothing and throws nothing");
});

// Whoever fetched new rates, the correction happens: the dashboard refetches on every start and
// corrects nothing, and after it the worker and sync find the cache fresh and learn nothing.
test("rates changed by another process are corrected against once, and only when they changed", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-rates-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = (rates, extra = {}) => fs.writeFileSync(path.join(dir, "pricing-claude.json"), JSON.stringify({ fetchedAt: 1, etag: "a", ...extra, rates }));
  cache({ "claude-opus-5-5": { input: 4, output: 20 } });
  assert.equal(ratesChangedSinceCorrection(dir), true, "never corrected: due");

  const seen = [];
  const correct = async (p) => { seen.push(p.id); return { priced: 0 }; };
  const providers = [
    { id: "claude", pricedModel: () => true, transcriptId: (f) => f },
    { id: "codex", pricedModel: () => true, transcriptId: (f) => f },
    { id: "cursor", pricedModel: () => true },
  ];
  await correctAll(providers, { correct, dir });
  assert.deepEqual(seen, ["claude", "codex"], "every provider whose rows can be re-read");
  assert.equal(ratesChangedSinceCorrection(dir), false);

  cache({ "claude-opus-5-5": { input: 4, output: 20 } }, { fetchedAt: 2, attemptedAt: 2, etag: "b" });
  assert.equal(ratesChangedSinceCorrection(dir), false, "a refetch of the same rates is not a change");
  cache({ "claude-opus-5-5": { input: 4, output: 20 }, "claude-future-9": { input: 1, output: 5 } });
  assert.equal(ratesChangedSinceCorrection(dir), true, "a new model is");
  fs.writeFileSync(path.join(dir, "pricing-zai.json"), JSON.stringify({ rates: {} }));

  await correctAll(providers, { correct: async () => { throw new Error("locked"); }, dir });
  assert.equal(ratesChangedSinceCorrection(dir), true, "a failed correction is tried again");
  await correctAll(providers, { correct, dir });
  assert.equal(ratesChangedSinceCorrection(dir), false);
});

test("the worker corrects every provider when the cached rates changed, though it learned nothing itself", async () => {
  const seen = [];
  const correct = async (p) => { seen.push(p.id); return { priced: 0 }; };
  const f = fakeClaude();
  await refreshRatesAndCorrect({ providers: [f.provider], refreshZai: async () => ({ status: "fresh" }), correct, ratesChanged: () => true });
  assert.deepEqual(seen, ["claude"]);
  assert.equal(f.calls.cleared, 1);
});

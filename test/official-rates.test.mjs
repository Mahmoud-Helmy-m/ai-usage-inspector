import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as openai from "../src/providers/codex/remote-pricing.mjs";
import * as cursor from "../src/providers/cursor/remote-pricing.mjs";
import * as codexPrices from "../src/providers/codex/pricing.mjs";
import * as cursorPrices from "../src/providers/cursor/pricing.mjs";
import * as codex from "../src/providers/codex/index.mjs";
import * as cursorProvider from "../src/providers/cursor/index.mjs";
import { refreshRatesAndCorrect } from "../src/worker.mjs";
import { correctEstimatedCosts, storesOf } from "../src/lib/estimates.mjs";
import { ingestTranscript } from "../src/lib/ingest.mjs";
import { workspaceFile } from "../src/lib/paths.mjs";
import { recordInstall, repairDue } from "../src/lib/scan-state.mjs";
import { upsertSession } from "../src/lib/store.mjs";

// Trimmed official Standard pricing excerpt, 2026-09-27.
const PAGE = `
### Standard pricing data

<a id="standard"></a>

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |
| gpt-6-sol | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $15.00 |
| gpt-6-luna | $0.10 | $0.01 | $0.125 | $0.50 | $0.20 | $0.02 | $0.25 | $0.75 |
| gpt-5.6-sol | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $30.00 |
| gpt-5.6-terra | $2.00 | $0.20 | $2.50 | $12.00 | $4.00 | $0.40 | $5.00 | $18.00 |
| gpt-5.6-luna | $0.20 | $0.02 | $0.25 | $1.20 | $0.40 | $0.04 | $0.50 | $1.80 |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |
| gpt-5.5-pro (<272K context length) | $30.00 | - | - | $180.00 | $60.00 | - | - | $270.00 |
| gpt-5.4 (<272K context length) | $2.50 | $0.25 | - | $15.00 | $5.00 | $0.50 | - | $22.50 |
| gpt-5.4-mini | $0.75 | $0.075 | - | $4.50 | - | - | - | - |
| gpt-5.4-nano | $0.20 | $0.02 | - | $1.25 | - | - | - | - |
| gpt-5.4-pro (<272K context length) | $30.00 | - | - | $180.00 | $60.00 | - | - | $270.00 |
`;
const CURSOR_PAGE = `
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| [Claude 4.6 Sonnet](url) | Anthropic | $3 | $3.75 | $0.3 | $15 | |
| [GPT-5.5](url) | OpenAI | $5 | - | $0.5 | $30 | |
| [Composer 2.5](url) | Cursor | $0.5 | - | $0.05 | $2.5 | |
`;
const response = (text) => ({ ok: true, status: 200, text: async () => text, headers: { get: () => "v1" } });
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-official-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test("OpenAI parses only Standard, including tiers, cache writes and explicit no-discount cells", () => {
  const other = ["Batch", "Flex", "Fast"].map((name) => PAGE.replace("Standard", name).replaceAll("gpt-", `${name.toLowerCase()}-`).replaceAll("$10.00", "$999.00")).join("\n");
  const competing = PAGE.replace("Standard", "Batch").replaceAll("$10.00", "$999.00");
  const rates = openai.parsePricingMarkdown(competing + other + PAGE + other + competing);
  assert.equal(Object.keys(rates).length, 12);
  assert.deepEqual(rates["gpt-6-astra"], { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50,
    long: { input: 20, cachedInput: 2, cacheWrite: 25, output: 75, threshold: 272000 } });
  assert.equal(rates["gpt-6-luna"].cacheWrite, .125);
  assert.equal(rates["gpt-5.5"].long.threshold, 272000);
  assert.equal(openai.parsePricingMarkdown(PAGE.replaceAll("272K", "300K"))["gpt-5.5"].long.threshold, 300000);
  assert.equal(rates["gpt-5.4-mini"].long, null);
  assert.equal(rates["gpt-5.5-pro"].cachedInput, 30);
  assert.equal(rates["gpt-5.5-pro"].long.cachedInput, 60);
  assert.equal(rates["gpt-5.5-pro"].cacheWrite, null);
  assert.deepEqual(openai.parsePricingMarkdown(PAGE.replaceAll("|", "  |")), rates);
  for (const [id, rate] of Object.entries(rates)) {
    const built = codexPrices.modelInfo(id);
    for (const key of ["input", "cachedInput", "output", "cacheWrite", "long"]) assert.deepEqual(built[key], rate[key], `${id}: ${key}`);
    assert.equal(built.contextMax, /mini|nano/.test(id) ? 400000 : 1050000);
  }
  codexPrices.clearGuessedModels();
  assert.equal(codexPrices.costOf("gpt-5.5-pro", { cached: 1000000 }).cacheRead, 30);
  assert.equal(codexPrices.costOf("gpt-5.5-pro", { cached: 1000000 }, { long: true }).cacheRead, 60);
  assert.equal(codexPrices.costOf("gpt-5.5-pro", { cached: 1 }).source, "priced");
  assert.deepEqual(codexPrices.guessedModels(), []);
  assert.equal(codexPrices.modelInfo("gpt-5.3-codex").contextMax, 400000);
});

test("OpenAI supplements only missing ids after official success and records both sources", async (t) => {
  const file = path.join(temp(t), "rates.json");
  const calls = [];
  const result = await openai.refreshPricing({ file, now: 100000000, fetchImpl: async (url) => {
    calls.push(url);
    if (url === openai.PRICING_URL) return response(PAGE);
    return { ok: true, json: async () => ({ openai: { models: {
      "gpt-6-astra": { cost: { input: 999, output: 999 } },
      "codex-auto-review": { cost: { input: 2, output: 10, cache_read: .2 } },
    } } }) };
  } });
  assert.equal(openai.PRICING_URL, "https://developers.openai.com/api/docs/pricing.md");
  assert.deepEqual(calls, [openai.PRICING_URL, "https://models.dev/api.json"]);
  assert.equal(result.rates["gpt-6-astra"].input, 10);
  assert.equal(result.rates["gpt-6-astra"].source, "openai");
  assert.equal(result.rates["codex-auto-review"].source, "models.dev");
  const cache = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(cache.sources, { openai: openai.PRICING_URL, "models.dev": openai.MODELS_URL });
  assert.equal(cache.attemptedAt, 100000000);
  assert.equal(cache.schema, 3);
  fs.writeFileSync(file, JSON.stringify({ ...cache, schema: 2 }));
  assert.equal(openai.readCachedRates(file), null);
});

for (const [name, remote, page] of [["OpenAI", openai, PAGE], ["Cursor", cursor, CURSOR_PAGE]]) {
  test(`${name} refresh: ttl, timeout, etag, 304, unchanged, provider options and offline flag`, async (t) => {
    const file = path.join(temp(t), "rates.json");
    let calls = 0;
    const timeout = t.mock.method(AbortSignal, "timeout");
    const fetchImpl = async (url, opts) => {
      if (url === openai.MODELS_URL) throw Error("secondary offline");
      calls++;
      assert.ok(opts.signal instanceof AbortSignal);
      assert.equal(opts.headers.accept, name === "Cursor" ? "text/plain, */*" : "text/markdown, text/plain, */*");
      if (calls > 1) assert.equal(opts.headers["if-none-match"], "v1");
      return response(page);
    };
    const options = { file, now: 100000000, timeoutMs: 1234, fetchImpl };
    assert.equal((await remote.refreshPricing(options)).status, "updated");
    assert.equal(timeout.mock.calls[0].arguments[0], 1234);
    assert.equal((await remote.refreshPricing({ ...options, now: options.now + 11 * 3600000 })).status, "fresh");
    assert.equal(calls, 1);
    assert.equal((await remote.refreshPricing({ ...options, now: options.now + 12 * 3600000 })).status, "unchanged");
    assert.equal((await remote.refreshPricing({ ...options, ttlMs: 0, fetchImpl: async (url, opts) => {
      assert.equal(opts.headers["if-none-match"], "v1");
      return { status: 304 };
    } })).status, "not-modified");
    const provider = name === "OpenAI" ? codex : cursorProvider;
    assert.equal((await provider.refreshPricing({ ...options, ttlMs: 0 })).status, "unchanged");
    assert.equal(calls, 3, "provider passes injected options to remote");
    assert.equal((await remote.refreshPricing({ file, ttlMs: 0 })).status, "no-fetch");
    if (name === "Cursor") assert.equal(cursorPrices.modelInfo("claude-4.6-sonnet").cacheWrite, 3.75);
  });
  for (const [status, fetchImpl] of [
    ["offline", async () => { throw Error("offline"); }],
    ["http-503", async () => ({ status: 503, ok: false })],
    ["read-error", async () => ({ ...response(page), text: async () => { throw Error("read"); } })],
    ["parse-thin", async () => response(page.split("\n").filter((line) => !line.startsWith("| ") || line.includes("Model") || line.includes("---") || line.includes("gpt-6-astra") || line.includes("GPT-5.5")).join("\n"))],
  ]) test(`${name} ${status} preserves cache and backs off, without secondary-only replacement`, async (t) => {
    const file = path.join(temp(t), "rates.json");
    const rates = remote.parsePricingMarkdown(page);
    fs.writeFileSync(file, JSON.stringify({ schema: remote.CACHE_SCHEMA, rates, fetchedAt: 1, etag: "old" }));
    let calls = 0;
    const options = { file, now: 100000000, fetchImpl: async (url) => {
      calls++;
      assert.equal(url, remote.PRICING_URL);
      return fetchImpl();
    } };
    assert.equal((await remote.refreshPricing(options)).status, status);
    assert.deepEqual(remote.readCachedRates(file), rates);
    assert.equal(JSON.parse(fs.readFileSync(file)).attemptedAt, options.now);
    assert.equal((await remote.refreshPricing({ ...options, now: options.now + 3599999 })).status, "backoff");
    assert.equal(calls, 1);
    assert.equal((await remote.refreshPricing({ ...options, now: options.now + 3600000 })).status, status);
    assert.equal((await remote.refreshPricing({ ...options, ttlMs: 0 })).status, status);
  });
}

test("pricing diffs include removed models, cache-write and long-tier changes", () => {
  const rate = openai.parsePricingMarkdown(PAGE)["gpt-6-astra"];
  for (const key of ["input", "cachedInput", "cacheWrite", "output", "threshold"]) {
    assert.equal(openai.diffRates({ a: rate }, { a: { ...rate, long: { ...rate.long, [key]: 999 } } })[0].type, "changed");
  }
  for (const remote of [openai, cursor]) {
    for (const key of ["cachedInput", "cacheWrite", "cachedGuessed"]) assert.equal(remote.diffRates({ a: rate }, { a: { ...rate, [key]: 999 } })[0].type, "changed");
    assert.deepEqual(remote.diffRates({ a: rate }, { b: rate }).map((c) => c.type), ["removed", "added"]);
  }
  assert.equal(cursor.parsePricingMarkdown(CURSOR_PAGE)["claude-4.6-sonnet"].cacheWrite, 3.75);
});

function rollout(file, cwd, model, requests) {
  let input = 0, cached = 0, output = 0;
  const events = [
    { type: "session_meta", payload: { id: "official-session", cwd } },
    { type: "turn_context", payload: { model, cwd } },
    { type: "event_msg", timestamp: "2026-09-27T00:00:00Z", payload: { type: "user_message", message: "synthetic" } },
  ];
  for (const request of requests) {
    input += request.input; cached += request.cached || 0; output += request.output || 0;
    events.push({ type: "event_msg", timestamp: "2026-09-27T00:00:01Z", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output },
      ...(!request.missing ? { last_token_usage: request.last || { input_tokens: request.input, cached_input_tokens: request.cached || 0, output_tokens: request.output || 0 } } : {}),
    } } });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map(JSON.stringify).join("\n"));
  return codex.buildTurns(file)[0];
}

for (const [label, model, requests, expected] of [
  ["300K long", "gpt-5.5", [{ input: 300000, cached: 100000, output: 1000 }], 2.145],
  ["200K short", "gpt-5.5", [{ input: 200000, cached: 100000, output: 1000 }], .58],
  ["threshold is exclusive", "gpt-5.5", [{ input: 272000, output: 1000 }], 1.39],
  ["mixed requests", "gpt-5.5", [{ input: 200000, output: 1000 }, { input: 300000, output: 1000 }], 4.075],
  ["no long tier", "gpt-5.4-mini", [{ input: 300000, output: 1000 }], .2295],
  ["missing requests", "gpt-5.5", [{ input: 300000, output: 1000, missing: true }], 1.53],
  ["partial requests", "gpt-5.5", [{ input: 300000, output: 1000 }, { input: 200000, output: 1000, missing: true }], 4.075],
  ["smaller request sum", "gpt-5.5", [{ input: 400000, output: 2000, last: { input_tokens: 300000, output_tokens: 1000 } }], 3.575],
  ["oversized request", "gpt-5.5", [{ input: 200000, output: 1000, last: { input_tokens: 300000, output_tokens: 1000 } }], 1.03],
  ["duplicate event", "gpt-5.5", [{ input: 300000, output: 1000 }, { input: 0, last: { input_tokens: 300000, output_tokens: 1000 } }], 3.045],
  // Codex repeats a token_count whose totals did not move; counted again, it would fit the
  // later long request's tokens and push that request into the short-priced remainder.
  ["repeated event before a long request", "gpt-5.5", [{ input: 100000, output: 1000 }, { input: 0, last: { input_tokens: 100000, output_tokens: 1000 } }, { input: 300000, output: 1000 }], 3.575],
]) test(`Codex costing: ${label}, cumulative totals preserved`, (t) => {
  const row = rollout(path.join(temp(t), "r.jsonl"), null, model, requests);
  near(row.cost.total, expected);
  assert.equal(row.cost.cacheWrite, 0);
  assert.equal(row.usage.input + row.usage.cacheRead, requests.reduce((sum, r) => sum + r.input, 0));
  assert.equal(row.usage.output, requests.reduce((sum, r) => sum + (r.output || 0), 0));
});

for (const prices of [codexPrices, cursorPrices]) test("guess tracking ignores empty/synthetic usage and includes guessed cache rates", () => {
  prices.clearGuessedModels();
  for (const id of ["unknown", "<synthetic>"]) prices.costOf(id, { input: 1 });
  prices.costOf("future-guess-7", { input: 0 });
  assert.deepEqual(prices.guessedModels(), []);
  prices.costOf("future-guess-7", { input: 1 });
  assert.deepEqual(prices.guessedModels(), ["future-guess-7"]);
  assert.equal(prices.pricedModel("future-guess-7"), false);
  prices.applyRemoteRates({ "future-cache-7": { input: 2, output: 10 } });
  prices.clearGuessedModels();
  prices.costOf("future-cache-7", { input: 1 });
  assert.deepEqual(prices.guessedModels(), []);
  prices.costOf("future-cache-7", { cached: 1 });
  assert.deepEqual(prices.guessedModels(), ["future-cache-7"]);
  assert.equal(prices.pricedModel("future-cache-7"), false);
  prices.applyRemoteRates({ "future-cache-7": { input: 2, cachedInput: .3, output: 10 } });
  assert.equal(prices.pricedModel("future-cache-7"), true);
  prices.clearGuessedModels();
  assert.deepEqual(prices.guessedModels(), []);
  prices.applyRemoteRates({ "zero-cache-guess-7": { input: 0, output: 1 } });
  assert.equal(prices.costOf("zero-cache-guess-7", { cached: 1 }).source, "estimated");
  assert.deepEqual(prices.guessedModels(), ["zero-cache-guess-7"]);
  prices.clearGuessedModels();
});

test("worker refreshes all providers, shortens Codex and shared GLM guesses, corrects and clears", async () => {
  for (const [guessed, status, expected] of [[[], "fresh", 0], [["gpt-future"], "fresh", 1], [[], "updated", 2]]) {
    const calls = [], corrected = [], cleared = [];
    const providers = ["codex", "claude", "cursor", "opencode"].map((id) => ({
      id, guessedModels: () => id === "codex" ? guessed : id === "opencode" ? ["GLM-future"] : [],
      clearGuessedModels: () => cleared.push(id), pricedModel: () => true,
      ...(id === "codex" || id === "claude" ? { transcriptId: (p) => p } : {}),
    }));
    const refreshers = Object.fromEntries(["codex", "claude", "cursor", "zai"].map((id) => [id, async (opts) => {
      calls.push([id, opts]); return { status: id === "codex" ? status : "fresh" };
    }]));
    await refreshRatesAndCorrect({ providers, refreshers, correct: async (p) => corrected.push(p.id), ratesChanged: () => false });
    assert.equal(calls.length, 4);
    assert.equal(calls.find(([id]) => id === "codex")[1].ttlMs, guessed.length ? 3600000 : 12 * 3600000);
    assert.equal(calls.find(([id]) => id === "zai")[1].ttlMs, 3600000);
    assert.equal(calls.find(([id]) => id === "cursor")[1].ttlMs, 12 * 3600000);
    assert.equal(corrected.length, expected);
    if (expected) assert.ok(corrected.includes("codex"));
    assert.equal(cleared.length, 4);
  }
});

test("Codex estimated rollout corrects exactly once; stores are found through payload.cwd", async (t) => {
  const dir = temp(t);
  process.env.CODEX_HOME = path.join(dir, "codex");
  const provider = await import(`../src/providers/codex/index.mjs?e2e=${Date.now()}`);
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  const file = path.join(process.env.CODEX_HOME, "sessions", "rollout-future-e2e-7.jsonl");
  const model = "gpt-future-e2e-7";
  rollout(file, project, model, [{ input: 100000, cached: 20000, output: 10000 }]);
  await ingestTranscript(provider, { transcriptPath: file, opts: {} });
  const store = workspaceFile(project);
  const read = () => fs.readFileSync(store, "utf8").trim().split("\n").map(JSON.parse)[0];
  assert.equal(read().provider, "codex");
  assert.equal(read().cost.source, "estimated");
  assert.deepEqual(storesOf([{ transcriptPath: file }]), [store]);
  const contextOnly = path.join(dir, "context.jsonl");
  fs.writeFileSync(contextOnly, JSON.stringify({ type: "turn_context", payload: { cwd: project } }));
  assert.deepEqual(storesOf([{ transcriptPath: contextOnly }]), [store]);
  codexPrices.applyRemoteRates({ [model]: { input: 4, cachedInput: 1, output: 20 } });
  const result = await correctEstimatedCosts(provider);
  assert.equal(result.priced, 1);
  assert.equal(result.reread, 1);
  assert.equal(read().cost.total, .54);
  assert.equal(read().cost.source, "priced");
  assert.equal((await correctEstimatedCosts(provider)).priced, 0);
});

test("an upgrade from epoch 6 requests Codex and Claude, not Cursor; repair preserves an already-priced amount", async (t) => {
  const dir = temp(t), file = path.join(dir, "scan.json");
  fs.writeFileSync(file, JSON.stringify({ installedRepairEpoch: 6, providers: {} }));
  await recordInstall({ file, upgrading: true, providerIds: ["codex", "claude", "cursor"] });
  assert.equal(repairDue("codex", { file }), 9);
  assert.equal(repairDue("claude", { file }), 9);
  assert.equal(repairDue("cursor", { file }), null);
  const row = rollout(path.join(dir, "r.jsonl"), dir, "gpt-5.5", [{ input: 300000, output: 1000 }]);
  const store = path.join(dir, "store.ndjson");
  await upsertSession(store, row.sessionId, [{ ...row, cost: { ...row.cost, total: 1.53 } }]);
  await upsertSession(store, row.sessionId, [row]);
  assert.equal(JSON.parse(fs.readFileSync(store, "utf8").trim()).cost.total, 1.53);
});

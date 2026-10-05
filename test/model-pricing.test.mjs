import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import * as remote from "../src/lib/vendors/modelsdev/remote-pricing.mjs";
import { lookup } from "../src/lib/vendors/modelsdev/pricing.mjs";
import * as claudePrices from "../src/providers/claude/pricing.mjs";
import * as claudeRemote from "../src/providers/claude/remote-pricing.mjs";
import * as codexPrices from "../src/providers/codex/pricing.mjs";
import * as codexRemote from "../src/providers/codex/remote-pricing.mjs";
import * as claude from "../src/providers/claude/index.mjs";
import * as codex from "../src/providers/codex/index.mjs";
import { vendorOf } from "../src/lib/vendors/index.mjs";
import { addCost, zeroCost } from "../src/lib/pricing-core.mjs";
import { upsertSession } from "../src/lib/store.mjs";
import { ingestTranscript, copyViewerSidecars, VIEWER_VERSION, VIEWER_SIDECARS } from "../src/lib/ingest.mjs";
import { correctAll, correctEstimatedCosts, correctable, ratesDigest, ratesChangedSinceCorrection } from "../src/lib/estimates.mjs";
import { recordInstall, repairDue } from "../src/lib/scan-state.mjs";
import { refreshRatesAndCorrect } from "../src/worker.mjs";
import { readUnpriced, writeUnpriced } from "../src/lib/unpriced.mjs";

const HOUR = 3600000;
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-prices-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const readRows = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const jsonl = (file, rows) => fs.writeFileSync(file, rows.map(JSON.stringify).join("\n"));
const entry = (input = 1, output = 4, extra = {}) => ({ cost: { input, output, cache_read: .1, cache_write: 1.25, ...extra }, limit: { context: 262144 } });
const DATA = { moonshotai: { models: { "kimi-k2": entry(), "kimi-correction-test": entry() } },
  deepseek: { models: { "deepseek-v3": entry() } }, openai: { models: { "codex-community-test": entry() } } };
const response = (data = DATA) => ({ ok: true, status: 200, json: async () => data, headers: { get: () => "v1" } });
function cache(t, data = DATA) {
  const file = remote.CACHE_FILE;
  const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
  t.after(() => { if (old) fs.writeFileSync(file, old); else fs.rmSync(file, { force: true }); });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ rates: remote.parseModelsDev(data), fetchedAt: Date.now() }));
  return file;
}
const FAST_PAGE = `
### Model pricing
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
### Fast mode pricing
| Model | Input | Output |
| --- | --- | --- |
| Claude Opus 5.5 | $8 / MTok | $40 / MTok |
| Claude Opus 5 / Claude Opus 4.8 | $10 / MTok | $50 / MTok |
### Batch pricing
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`;

test("Claude fast table splits A / B names without bogus ids or overriding standard prices", async (t) => {
  const rates = claudeRemote.parsePricingMarkdown(FAST_PAGE);
  assert.deepEqual(Object.keys(rates), ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
  assert.deepEqual(rates["claude-opus-5-5"], { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: .2, fast: { input: 8, output: 40 } });
  for (const id of ["claude-opus-5", "claude-opus-4-8"]) assert.deepEqual(rates[id].fast, { input: 10, output: 50 });
  const fastFirst = FAST_PAGE.slice(FAST_PAGE.indexOf("### Fast"), FAST_PAGE.indexOf("### Batch")) + FAST_PAGE;
  assert.deepEqual(claudeRemote.parsePricingMarkdown(fastFirst), rates);
  const file = path.join(temp(t), "claude.json");
  await claudeRemote.refreshPricing({ file, fetchImpl: async () => ({ ok: true, text: async () => FAST_PAGE, headers: { get: () => null } }) });
  assert.deepEqual(claudeRemote.readCachedRates(file), rates);
  assert.equal(claudeRemote.diffRates(rates, { ...rates, "claude-opus-5": { ...rates["claude-opus-5"], fast: { input: 12, output: 60 } } })[0].type, "changed");
});

test("Claude built-in fast prices scale all caches, including Opus 5.5's 0.05x hit", () => {
  const cost = claudePrices.costOf("claude-opus-5-5", { speed: "fast", input_tokens: 1e6, output_tokens: 1e6,
    cache_read_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } });
  assert.equal(cost.input, 8); assert.equal(cost.output, 40); assert.equal(cost.cacheRead, .4);
  assert.equal(cost.cacheWrite, 26); assert.equal(cost.source, "priced");
  assert.equal(cost.rates, 5); assert.equal(cost.supersedes, 5);
  for (const id of ["claude-opus-5", "claude-opus-4-8"]) {
    const c = claudePrices.costOf(id, { speed: "fast", input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 });
    assert.equal(c.input, 10); assert.equal(c.output, 50); assert.equal(c.cacheRead, 1);
  }
});

test("fetched Claude fast rates retain standard cache ratios and built-in fast rules survive refresh", () => {
  claudePrices.applyRemoteRates({ "claude-fast-test": { input: 2, output: 10, cacheRead: .04, cacheWrite5m: 3, cacheWrite1h: 5, fast: { input: 6, output: 30 } } });
  const c = claudePrices.costOf("claude-fast-test", { speed: "fast", input_tokens: 1e6, cache_read_input_tokens: 1e6,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } });
  assert.equal(c.input, 6); assert.equal(c.cacheRead, .12); assert.equal(c.cacheWrite, 24);
  claudePrices.applyRemoteRates(claudeRemote.parsePricingMarkdown(FAST_PAGE));
  claudePrices.applyRemoteRates({ "claude-opus-4-6": { input: 5, output: 25 } });
  assert.equal(claudePrices.modelInfo("claude-opus-5-5").fast.input, 8);
  assert.equal(claudePrices.modelInfo("claude-opus-4-6").fastStandard, true);
});

test("unknown fast premium is estimated; Opus 4.6 fast is standard priced; standard speed has no new supersedes", () => {
  const unknown = claudePrices.costOf("claude-sonnet-4-6", { speed: "fast", input_tokens: 1e6 });
  assert.equal(unknown.input, 3); assert.equal(unknown.source, "estimated"); assert.equal(unknown.supersedes, undefined);
  const standard = claudePrices.costOf("claude-opus-4-6", { speed: "fast", input_tokens: 1e6 });
  assert.equal(standard.input, 5); assert.equal(standard.source, "priced");
  for (const speed of [undefined, "standard"]) {
    const c = claudePrices.costOf("claude-opus-5-5", { speed, input_tokens: 1e6, output_tokens: 1e6 });
    assert.equal(c.input, 4); assert.equal(c.output, 20); assert.equal(c.source, "priced"); assert.equal(c.supersedes, undefined);
  }
});

test("supersedes 5 replaces stored standard-priced fast usage and preserves standard-speed costs", async (t) => {
  const file = path.join(temp(t), "store.ndjson");
  const usage = { input: 1e6 }, row = { id: "t", sessionId: "s", provider: "claude", usage };
  const old = { ...claudePrices.costOf("claude-opus-5-5", { input_tokens: 1e6 }), rates: 4 };
  await upsertSession(file, "s", [{ ...row, cost: old }]);
  const fast = claudePrices.costOf("claude-opus-5-5", { input_tokens: 1e6, speed: "fast" });
  await upsertSession(file, "s", [{ ...row, cost: fast }]);
  assert.equal(readRows(file)[0].cost.total, 8);
  await upsertSession(file, "s", [{ ...row, cost: { ...old, total: 123 } }]);
  assert.equal(readRows(file)[0].cost.total, 8);
});

test("epoch 9 requests Claude only when upgrading from epoch 8", async (t) => {
  const file = path.join(temp(t), "scan.json");
  fs.writeFileSync(file, JSON.stringify({ installedRepairEpoch: 8, providers: {} }));
  await recordInstall({ file, upgrading: true, providerIds: ["claude", "codex", "cursor"] });
  assert.equal(repairDue("claude", { file }), 9);
  assert.equal(repairDue("codex", { file }), null); assert.equal(repairDue("cursor", { file }), null);
});

test("Bedrock exact platform price wins with regional uplift, Anthropic window and no fast premium", (t) => {
  cache(t, { "amazon-bedrock": { models: {
    "us.anthropic.claude-opus-4-7": entry(5.5, 27.5, { cache_read: .55, cache_write: 6.875 }),
    "global.anthropic.claude-opus-4-7": entry(5, 25, { cache_read: .5, cache_write: 6.25 }),
  } } });
  for (const [region, input] of [["us", 5.5], ["global", 5]]) {
    const id = `${region}.anthropic.claude-opus-4-7`;
    const c = claudePrices.costOf(id, { speed: "fast", input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 });
    assert.equal(c.input, input); assert.equal(c.output, input * 5); near(c.cacheWrite, input * 1.25); near(c.cacheRead, input * .1);
    assert.equal(c.source, "priced"); assert.equal(c.rateSource, "models.dev"); assert.equal(c.supersedes, undefined);
    assert.equal(vendorOf(id), "anthropic"); assert.equal(claudePrices.contextMax(id), 1e6);
  }
});

test("Bedrock and Vertex normalize regions, versions and snapshots to priced Anthropic fallback, never fast", (t) => {
  cache(t, {});
  for (const [id, normalized, input, context] of [
    ...["us", "eu", "apac", "jp", "au", "global", "us-gov"].map((r) => [`${r}.anthropic.claude-opus-4-8`, "claude-opus-4-8", 5, 1e6]),
    ["anthropic.claude-opus-4-6-v1", "claude-opus-4-6", 5, 1e6],
    ["eu.anthropic.claude-opus-4-5-20251101-v1:0", "claude-opus-4-5", 5, 200000],
    ["claude-opus-4-1@20250805", "claude-opus-4-1", 15, 200000],
    ["claude-opus-5-5@20260928", "claude-opus-5-5", 4, 1e6],
  ]) {
    assert.equal(claudePrices.normalize(id), normalized);
    const c = claudePrices.costOf(id, { speed: "fast", input_tokens: 1e6 });
    assert.equal(c.input, input); assert.equal(c.source, "priced"); assert.notEqual(c.supersedes, 5);
    assert.equal(vendorOf(id), "anthropic"); assert.equal(claudePrices.contextMax(id), context);
  }
});

for (const provider of ["google-vertex-anthropic", "google-vertex"]) test(`Vertex exact entry under ${provider} wins`, (t) => {
  const id = "claude-opus-5-5@20260928";
  cache(t, { [provider]: { models: { [id]: entry(4.5, 22.5) } } });
  const c = claudePrices.costOf(id, { speed: "fast", input_tokens: 1e6 });
  assert.equal(c.input, 4.5); assert.equal(c.source, "priced"); assert.equal(c.rateSource, "models.dev");
  assert.equal(claudePrices.contextMax(id), 1e6);
});

test("models.dev trims providers and fields, validates prices and drops malformed tiers", () => {
  const all = Object.fromEntries(remote.PROVIDERS.map((id) => [id, { models: { valid: entry(1, 4, { tiers: [{ input: 999 }] }), bad: entry(-1), nan: entry(NaN) }, env: ["SECRET"] }]));
  for (const id of ["alibaba-token-plan", "minimax-coding-plan", "alibaba-coding-plan", "iflowcn", "zai-coding-plan", "reseller"]) all[id] = { models: { valid: entry(0, 0) } };
  const r = remote.parseModelsDev(all);
  assert.deepEqual(Object.keys(r), remote.PROVIDERS);
  for (const models of Object.values(r)) assert.deepEqual(models, { valid: { input: 1, output: 4, cacheRead: .1, cacheWrite: 1.25, contextMax: 262144 } });
  assert.deepEqual(remote.parseModelsDev(null), {});
});

test("models.dev refresh: TTL, timeout, ETag, 304, unchanged and offline flag", async (t) => {
  const file = path.join(temp(t), "pricing-modelsdev.json"), now = 100000000;
  let calls = 0;
  const timeout = t.mock.method(AbortSignal, "timeout");
  const fetchImpl = async (url, options) => {
    assert.equal(url, remote.PRICING_URL); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.accept, "application/json");
    if (calls++) assert.equal(options.headers["if-none-match"], "v1");
    return response();
  };
  const opts = { file, now, timeoutMs: 1234, fetchImpl };
  assert.equal((await remote.refreshPricing(opts)).status, "updated");
  assert.equal(timeout.mock.calls[0].arguments[0], 1234);
  assert.equal((await remote.refreshPricing({ ...opts, now: now + 12 * HOUR - 1 })).status, "fresh"); assert.equal(calls, 1);
  assert.equal((await remote.refreshPricing({ ...opts, now: now + 12 * HOUR })).status, "unchanged");
  assert.equal((await remote.refreshPricing({ ...opts, ttlMs: 0, fetchImpl: async (_url, options) => {
    assert.equal(options.headers["if-none-match"], "v1"); return { status: 304 };
  } })).status, "not-modified");
  assert.equal((await remote.refreshPricing({ file, ttlMs: 0 })).status, "no-fetch");
  assert.deepEqual(remote.readCachedRates(file), remote.parseModelsDev(DATA));
});

for (const [status, fetchImpl] of [
  ["offline", async () => { throw Error("timeout"); }],
  ["http-503", async () => ({ status: 503 })],
  ["read-error", async () => ({ ...response(), json: async () => { throw Error("body"); } })],
  ["parse-thin", async () => response({ moonshotai: { models: { only: entry() } } })],
]) test(`models.dev ${status} preserves cache and uses one-hour backoff`, async (t) => {
  const file = path.join(temp(t), "cache.json"), now = 100000000;
  await remote.refreshPricing({ file, now: 1, fetchImpl: async () => response() });
  const rates = remote.readCachedRates(file);
  let calls = 0;
  const opts = { file, now, fetchImpl: async () => { calls++; return fetchImpl(); } };
  assert.equal((await remote.refreshPricing(opts)).status, status);
  assert.equal((await remote.refreshPricing({ ...opts, now: now + HOUR - 1 })).status, "backoff"); assert.equal(calls, 1);
  assert.equal((await remote.refreshPricing({ ...opts, now: now + HOUR })).status, status);
  assert.deepEqual(remote.readCachedRates(file), rates);
  assert.equal((await remote.refreshPricing({ ...opts, ttlMs: 0 })).status, status);
});

test("models.dev rejects a large table collapsing to three rows and tolerates unwritable caches", async (t) => {
  const dir = temp(t), file = path.join(dir, "rates.json");
  const data = { moonshotai: { models: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`kimi-${i}`, entry()])) } };
  await remote.refreshPricing({ file, fetchImpl: async () => response(data) });
  const thin = { moonshotai: { models: Object.fromEntries(Object.entries(data.moonshotai.models).slice(0, 3)) } };
  assert.equal((await remote.refreshPricing({ file, ttlMs: 0, fetchImpl: async () => response(thin) })).status, "parse-thin");
  assert.equal((await remote.refreshPricing({ file: dir, fetchImpl: async () => response() })).status, "updated");
});

for (const [id, provider] of [["kimi-k2", "moonshotai"], ["deepseek-v3", "deepseek"], ["qwen3", "alibaba"], ["qwq-32b", "alibaba"],
  ["MiniMax-M2.7", "minimax"], ["grok-4", "xai"], ["gemini-3", "google"], ["mistral-large", "mistral"],
  ["devstral-small", "mistral"], ["codestral", "mistral"], ["magistral", "mistral"], ["command-r", "cohere"], ["llama-4", "llama"],
  ["moonshotai/kimi-k2", "openrouter"]]) test(`first-party lookup: ${id} uses ${provider}, case-insensitively, in both agents`, (t) => {
  cache(t, { [provider]: { models: { [id]: entry() } }, reseller: { models: { [id]: entry(99, 99) } } });
  assert.equal(lookup(id.toUpperCase()).provider, provider);
  for (const prices of [claudePrices, codexPrices]) {
    const c = prices === claudePrices ? prices.costOf(id.toUpperCase(), { input_tokens: 1e6, output_tokens: 1e6 }) : prices.costOf(id.toUpperCase(), { input: 1e6, output: 1e6 });
    assert.equal(c.total, 5); assert.equal(c.source, "priced"); assert.equal(c.rateSource, "models.dev");
    assert.equal(prices.pricedModel(id), true); assert.equal(prices.contextMax(id), 262144);
  }
  assert.equal(vendorOf(id), provider === "openrouter" ? "moonshotai" : provider);
});

test("a reseller-only model stays estimated and an OpenRouter id requires an exact entry", (t) => {
  cache(t, { "minimax-coding-plan": { models: { "minimax-unpublished": entry(0, 0) } }, moonshotai: DATA.moonshotai });
  for (const id of ["minimax-unpublished", "moonshotai/kimi-k2"]) {
    assert.equal(lookup(id), null);
    assert.equal(claudePrices.costOf(id, { input_tokens: 10 }).source, "estimated");
    assert.equal(codexPrices.costOf(id, { input: 10 }).source, "estimated");
  }
});

test("models.dev recovers from malformed cache contents without throwing", async (t) => {
  const file = path.join(temp(t), "rates.json");
  for (const contents of ["broken", "null", JSON.stringify({ rates: { openai: null } })]) {
    fs.writeFileSync(file, contents);
    assert.equal((await remote.refreshPricing({ file, fetchImpl: async () => response() })).status, "updated");
  }
});

test("platform and foreign dated guesses retain the exact id needed for a later lookup", (t) => {
  cache(t, {});
  for (const prices of [claudePrices, codexPrices]) {
    prices.clearGuessedModels();
    for (const id of ["us.anthropic.claude-future-v1:0", "claude-future@20260928", "kimi-future-20260928", "moonshotai/kimi-unpublished"]) {
      if (prices === claudePrices) prices.costOf(id, { input_tokens: 1 });
      else prices.costOf(id, { input: 1 });
      assert.ok(prices.guessedModels().includes(id), id);
    }
    prices.clearGuessedModels();
  }
});

test("OpenAI shared-only ids identify the vendor and keep missing cache prices estimated", (t) => {
  cache(t, { openai: { models: { "gpt-shared-only-test": { cost: { input: 2, output: 10 } } } } });
  assert.equal(vendorOf("gpt-shared-only-test"), "openai");
  assert.equal(codexPrices.costOf("gpt-shared-only-test", { input: 1e6 }).source, "priced");
  const c = codexPrices.costOf("gpt-shared-only-test", { cached: 1e6 });
  assert.equal(c.cacheRead, .2); assert.equal(c.source, "estimated"); assert.equal(c.rateSource, "models.dev");
  codexPrices.clearGuessedModels();
});

test("OpenAI official built-in prices take precedence over a models.dev supplement", () => {
  codexPrices.applyRemoteRates({ "chat-latest": { input: 999, output: 999, cachedInput: 999, source: "models.dev" } });
  const c = codexPrices.costOf("chat-latest", { input: 1e6 });
  assert.equal(c.input, 5); assert.equal(c.rateSource, undefined);
});

test("a shared OpenAI cache refresh fixes an old guessed supplement even without an official refresh", (t) => {
  cache(t, { openai: { models: { "gpt-community-new-cache": entry(2, 10) } } });
  codexPrices.applyRemoteRates({ "gpt-community-new-cache": { input: 2, output: 10, source: "models.dev" } });
  for (const id of ["gpt-community-new-cache", "gpt-community-new-cache-2026-09-28"]) {
    assert.equal(codexPrices.pricedModel(id), true);
    const c = codexPrices.costOf(id, { cached: 1e6 });
    assert.equal(c.cacheRead, .1); assert.equal(c.source, "priced"); assert.equal(c.rateSource, "models.dev");
    assert.equal(vendorOf(id), "openai");
  }
});

test("Codex reuses the shared OpenAI cache without downloading api.json and retains provenance", async (t) => {
  const dir = temp(t), modelsFile = cache(t);
  const page = `### Standard pricing data\n| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |\n`
    + ["gpt-6-astra", "test-a", "test-b"].map((id) => `| ${id} | $10 | $1 | $12.5 | $50 | - | - | - | - |`).join("\n");
  const calls = [];
  const r = await codexRemote.refreshPricing({ file: path.join(dir, "codex.json"), modelsFile, fetchImpl: async (url) => {
    calls.push(url); return { ok: true, text: async () => page, headers: { get: () => null } };
  } });
  assert.deepEqual(calls, [codexRemote.PRICING_URL]);
  assert.equal(r.rates["codex-community-test"].source, "models.dev");
  codexPrices.applyRemoteRates({ "codex-community-test": r.rates["codex-community-test"] });
  assert.equal(codexPrices.costOf("codex-community-test", { input: 1e6 }).rateSource, "models.dev");
  assert.equal(codexPrices.costOf("gpt-6-astra", { input: 1e6 }).rateSource, undefined);
});

function claudeTranscript(file, cwd, model, usage = { input_tokens: 1000, output_tokens: 1000 }) {
  jsonl(file, [
    { type: "user", uuid: "u", sessionId: "s", cwd, timestamp: "2026-09-28T00:00:00Z", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a", parentUuid: "u", sessionId: "s", cwd, timestamp: "2026-09-28T00:00:01Z", message: {
      id: "m", role: "assistant", model, usage, content: [{ type: "text", text: "ok" }] } },
  ]);
}
function codexTranscript(file, cwd, model, model_provider) {
  jsonl(file, [
    { type: "session_meta", payload: { id: "s", cwd, model_provider } },
    { type: "turn_context", payload: { model } },
    { type: "event_msg", timestamp: "2026-09-28T00:00:00Z", payload: { type: "user_message", message: "hi" } },
    { type: "event_msg", timestamp: "2026-09-28T00:00:01Z", payload: { type: "token_count", info: {
      total_token_usage: { input_tokens: 2000, cached_input_tokens: 1000, output_tokens: 1000 },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 500 },
    } } },
  ]);
}

test("Claude transcript carries fast usage and supersedes into the stored row", async (t) => {
  const dir = temp(t), file = path.join(dir, "fast.jsonl");
  claudeTranscript(file, dir, "claude-opus-5-5", { speed: "fast", input_tokens: 1e6, cache_read_input_tokens: 1e6 });
  await ingestTranscript(claude, { transcriptPath: file, cwd: dir });
  const row = readRows(path.join(dir, ".ai-usage", "usage.ndjson"))[0];
  assert.equal(row.cost.total, 8.4); assert.equal(row.cost.supersedes, 5); assert.equal(row.cost.rates, 5);
});

test("models.dev rateSource survives addCost and both agents' stored rows; agent context wins", async (t) => {
  cache(t);
  assert.equal(addCost(zeroCost(), { ...zeroCost(), rateSource: "models.dev" }).rateSource, "models.dev");
  assert.equal(addCost({ ...zeroCost(), rateSource: "models.dev" }, zeroCost()).rateSource, "models.dev");
  for (const provider of [claude, codex]) {
    const dir = temp(t), file = path.join(dir, "source.jsonl");
    if (provider === claude) claudeTranscript(file, dir, "kimi-k2");
    else codexTranscript(file, dir, "kimi-k2", "moonshot");
    await ingestTranscript(provider, { transcriptPath: file, cwd: dir });
    const row = readRows(path.join(dir, ".ai-usage", "usage.ndjson"))[0];
    assert.equal(row.cost.rateSource, "models.dev"); assert.equal(row.cost.source, "priced");
    assert.equal(row.contextMax, 262144); assert.equal(row.vendor, "moonshotai");
    if (provider === codex) {
      const records = readRows(file); records[3].payload.info.model_context_window = 123456;
      jsonl(file, records); assert.equal(codex.buildTurns(file)[0].contextMax, 123456);
    }
  }
});

test("estimated Kimi becomes priced end to end after cache appears, and correction runs once", async (t) => {
  const cacheFile = cache(t, {}), dir = temp(t), file = path.join(dir, "kimi-correction.jsonl");
  fs.rmSync(cacheFile);
  claudeTranscript(file, dir, "kimi-correction-test");
  const ref = { transcriptPath: file, cwd: dir };
  await ingestTranscript(claude, ref);
  const store = path.join(dir, ".ai-usage", "usage.ndjson"), state = path.dirname(cacheFile);
  assert.equal(readRows(store)[0].cost.source, "estimated");
  assert.equal(correctable(readRows(store)[0], claude.pricedModel), false);
  const correct = (provider) => correctEstimatedCosts(provider, { transcripts: [ref] });
  await correctAll([claude], { correct, dir: state });
  assert.equal(ratesChangedSinceCorrection(state), false);
  await remote.refreshPricing({ file: cacheFile, fetchImpl: async () => response() });
  assert.equal(ratesChangedSinceCorrection(state), true);
  assert.equal(claude.pricedModel("kimi-correction-test"), true);
  assert.equal(correctable(readRows(store)[0], claude.pricedModel), true);
  const result = await correctAll([claude], { correct, dir: state });
  assert.equal(result.claude.priced, 1); assert.equal(result.claude.reread, 1);
  const row = readRows(store)[0];
  assert.equal(row.cost.source, "priced"); assert.equal(row.cost.rateSource, "models.dev"); near(row.cost.total, .005);
  assert.equal(ratesChangedSinceCorrection(state), false);
  assert.equal((await correctAll([claude], { correct, dir: state })).claude.reread, 0);
});

for (const local of ["ollama", "lmstudio", "oss"]) test(`Codex ${local} metadata makes every request and remainder zero priced, never guessed`, async (t) => {
  const dir = temp(t), file = path.join(dir, "local.jsonl");
  codexPrices.clearGuessedModels();
  codexTranscript(file, dir, "local-unpublished", local);
  await ingestTranscript(codex, { transcriptPath: file, cwd: dir });
  const row = readRows(path.join(dir, ".ai-usage", "usage.ndjson"))[0];
  assert.equal(row.cost.total, 0); assert.equal(row.cost.source, "priced"); assert.equal(row.cost.rateSource, "local");
  assert.deepEqual(codexPrices.guessedModels(), []);
});

test("worker remembers unpriceable models for 12h, new guesses still get 1h, failures never count", async (t) => {
  const dir = temp(t), unpricedFile = path.join(dir, "unpriced.json"), now = 100000000;
  let ids = ["codex-auto-review"], status = "updated";
  const calls = [];
  const provider = { id: "codex", guessedModels: () => ids, pricedModel: () => false };
  const refreshers = Object.fromEntries(["codex", "modelsdev", "zai"].map((id) => [id, async (opts) => { calls.push([id, opts.ttlMs]); return { status }; }]));
  const run = async (at) => { calls.length = 0; await refreshRatesAndCorrect({ providers: [provider], refreshers, unpricedFile, now: at, ratesChanged: () => false }); };
  await run(now); assert.equal(calls.find(([id]) => id === "codex")[1], HOUR);
  assert.equal(readUnpriced(unpricedFile)["codex:codex-auto-review"], now);
  status = "fresh";
  await run(now + HOUR); assert.equal(calls.find(([id]) => id === "codex")[1], 12 * HOUR);
  assert.equal(calls.find(([id]) => id === "modelsdev")[1], 12 * HOUR);
  assert.equal(readUnpriced(unpricedFile)["codex:codex-auto-review"], now, "fresh runs must not slide the expiry forever");
  ids.push("gpt-reserve"); await run(now + 2 * HOUR); assert.equal(calls.find(([id]) => id === "codex")[1], HOUR);
  await run(now + 12 * HOUR); assert.equal(calls.find(([id]) => id === "codex")[1], HOUR);
  ids = ["gpt-never-checked"]; status = "offline"; await run(now + 13 * HOUR);
  assert.equal(readUnpriced(unpricedFile)["codex:gpt-never-checked"], undefined);
});

test("unpriced.json is excluded from rate fingerprints and file failures are harmless", (t) => {
  const dir = temp(t), file = path.join(dir, "unpriced.json"), digest = ratesDigest(dir);
  writeUnpriced({ "codex:gpt-reserve": 123 }, file);
  assert.equal(ratesDigest(dir), digest);
  fs.writeFileSync(path.join(dir, "pricing-modelsdev.json"), JSON.stringify({ rates: DATA }));
  assert.notEqual(ratesDigest(dir), digest);
  fs.writeFileSync(file, "corrupt"); assert.deepEqual(readUnpriced(file), {});
  assert.doesNotThrow(() => writeUnpriced({}, dir));
});

for (const status of ["fresh", "updated", "unchanged", "not-modified"]) test(`worker records ${status} checks against the model's responsible source`, async (t) => {
  const unpricedFile = path.join(temp(t), "unpriced.json");
  const provider = { id: "claude", guessedModels: () => ["kimi-unlisted", "glm-unlisted"], pricedModel: () => false };
  const calls = [];
  const refreshers = Object.fromEntries(["claude", "modelsdev", "zai"].map((id) => [id, async (opts) => {
    calls.push([id, opts.ttlMs]); return { status: id === "claude" ? "offline" : status };
  }]));
  await refreshRatesAndCorrect({ providers: [provider], refreshers, unpricedFile, now: 100000000, ratesChanged: () => false });
  assert.deepEqual(readUnpriced(unpricedFile), { "claude:kimi-unlisted": 100000000, "claude:glm-unlisted": 100000000 });
  calls.length = 0;
  await refreshRatesAndCorrect({ providers: [provider], refreshers, unpricedFile, now: 100000000 + HOUR, ratesChanged: () => false });
  assert.ok(calls.every(([, ttl]) => ttl === 12 * HOUR));
});

test("models.dev refresh is wired into install, sync and a self-contained viewer sidecar", async (t) => {
  const dir = temp(t); copyViewerSidecars(dir);
  assert.ok(Number(VIEWER_VERSION) >= 38, "the bundle that ships the models.dev sidecar or later");
  assert.equal(new Set(VIEWER_SIDECARS.map(([, name]) => name)).size, VIEWER_SIDECARS.length);
  const mod = await import(pathToFileURL(path.join(dir, "remote-pricing-modelsdev.mjs")));
  assert.equal((await mod.refreshPricing({ file: path.join(dir, "cache.json") })).status, "no-fetch");
  for (const file of ["install.mjs", "src/sync.mjs"]) assert.match(fs.readFileSync(file, "utf8"), /await refreshModelsDevPricing\(\{ timeoutMs: 5_000 \}\)/);
  assert.match(fs.readFileSync("viewer/server.mjs", "utf8"), /label: "models.dev", mod: await loadPricing\("\.\/remote-pricing-modelsdev.mjs"/);
});

// models.dev lists one cache-write price; Claude's 1h writes cost 2x input, not 1.25x.
test("Claude on Bedrock keeps Anthropic's 1h cache-write and hit ratios on the platform price", (t) => {
  cache(t, { "amazon-bedrock": { models: { "us.anthropic.claude-opus-5-5": entry(4.4, 22, { cache_read: .44, cache_write: 5.5 }) } } });
  const c = claudePrices.costOf("us.anthropic.claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6,
    cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } });
  near(c.cacheWrite, 4.4 * 2);
  near(c.cacheRead, 4.4 * .05, "Opus 5.5 hits are 0.05x input, not models.dev's 0.1x");
  assert.equal(c.source, "priced");
});

test("another lab's model with no published cache-hit price bills hits at input, estimated", (t) => {
  cache(t, { moonshotai: { models: { "kimi-nocache-9": { cost: { input: 1, output: 4 }, limit: { context: 262144 } } } } });
  const hit = claudePrices.costOf("kimi-nocache-9", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0 });
  assert.equal(hit.cacheRead, 1);
  assert.equal(hit.source, "estimated");
  assert.equal(claudePrices.costOf("kimi-nocache-9", { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }).source, "priced");
  const codexHit = codexPrices.costOf("kimi-nocache-9", { input: 0, cached: 1e6, output: 0 });
  assert.equal(codexHit.cacheRead, 1);
  assert.equal(codexHit.source, "estimated");
});

test("a row naming two models outside the fast table becomes no id at all", () => {
  const rates = claudeRemote.parsePricingMarkdown([
    "### Model pricing", "| Model | Input | Output |", "| --- | --- | --- |",
    "| Claude Opus 5 / Claude Opus 4.8 | $5 / MTok | $25 / MTok |",
  ].join("\n"));
  assert.deepEqual(Object.keys(rates), []);
});

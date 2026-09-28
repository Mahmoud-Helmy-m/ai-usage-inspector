import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as zai from "../src/lib/vendors/zai/pricing.mjs";
import * as remote from "../src/lib/vendors/zai/remote-pricing.mjs";
import { costOf, RATES_REVISION } from "../src/providers/claude/pricing.mjs";
import { buildTurns } from "../src/providers/claude/transcript.mjs";
import { vendorOf } from "../src/lib/vendors/index.mjs";
import { applyFieldSelection } from "../src/lib/config.mjs";
import { upsertSession } from "../src/lib/store.mjs";
import { recordInstall, repairDue, REPAIR_EPOCH } from "../src/lib/scan-state.mjs";
import { VIEWER_SIDECARS, copyViewerSidecars } from "../src/lib/ingest.mjs";

const M = 1_000_000;
const usage = { input_tokens: M, output_tokens: 200_000, cache_read_input_tokens: 2 * M, cache_creation_input_tokens: 100_000 };
const entries = [
  ["glm-5.3", 1.4, .26, 4.4, M], ["glm-5.3-flash", .15, .03, .50, M],
  ["glm-5.3-flashx", .37, .075, 1.25, M], ["glm-5.2", 1.4, .26, 4.4, null],
  ["glm-5.1", 1.4, .26, 4.4, 200000], ["glm-5", 1, .2, 3.2, 200000],
  ["glm-4.7", .6, .11, 2.2, 200000], ["glm-4.7-flashx", .07, .01, .4, 200000],
  ["glm-4.7-flash", 0, 0, 0, 200000], ["glm-4.6", .6, .11, 2.2, 200000],
  ["glm-4.6v", .3, .05, .9, null], ["glm-4.6v-flashx", .04, .004, .4, null],
  ["glm-4.6v-flash", 0, 0, 0, null], ["glm-4.5", .6, .11, 2.2, null],
  ["glm-4.5-x", 2.2, .45, 8.9, null], ["glm-4.5-air", .2, .03, 1.1, null],
  ["glm-4.5-airx", 1.1, .22, 4.5, null], ["glm-4.5-flash", 0, 0, 0, null],
  ["glm-4.5v", .6, .11, 1.8, null], ["glm-4-32b-0414-128k", .1, null, .1, 128000],
];
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-zai-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function transcript(t, model, counts = usage) {
  const file = path.join(temp(t), "s.jsonl");
  fs.writeFileSync(file, [
    { type: "user", uuid: "u", sessionId: "s", timestamp: "2026-09-01T00:00:00Z", message: { content: "synthetic" } },
    { type: "assistant", timestamp: "2026-09-01T00:00:01Z", message: { id: "a", model, usage: counts, content: [], stop_reason: "end_turn" } },
  ].map(JSON.stringify).join("\n"));
  return buildTurns(file)[0];
}

test("zai: every published model has exact rates and only known windows", () => {
  for (const [id, input, cacheRead, output, contextMax] of entries) {
    assert.deepEqual(zai.modelInfo(id), { input, cacheRead, output, contextMax, cacheWrite5m: 0, cacheWrite1h: 0, windowKnown: contextMax !== null }, id);
    const cost = costOf(id, { ...usage, cache_read_input_tokens: cacheRead === null ? 0 : 2 * M });
    assert.equal(cost.source, "priced", id);
    assert.ok(Math.abs(cost.total - (input + .2 * output + 2 * (cacheRead || 0))) < 1e-10, id);
  }
});
test("zai: Claude GLM example costs 1.26 and records vendor without changing agent", (t) => {
  const row = transcript(t, "glm-4.6");
  assert.equal(row.cost.total, 1.26);
  assert.equal(row.cost.source, "priced");
  assert.equal(row.vendor, "z.ai");
  assert.equal(row.provider, "claude");
  assert.equal(row.contextMax, 200000);
});
test("zai: mixed case ids price and size exactly", (t) => {
  const row = transcript(t, "GLM-5.3-Flash", { input_tokens: 100000, output_tokens: 100 });
  assert.equal(row.model, "GLM-5.3-Flash");
  assert.equal(row.cost.source, "priced");
  assert.equal(row.cost.total, .01505);
  assert.equal(row.contextMax, M);
  assert.equal(row.contextFillPct, 10);
  assert.equal(row.vendor, "z.ai");
});
test("zai: free models and both cache write lifetimes cost zero", () => {
  for (const id of ["glm-4.7-flash", "glm-4.6v-flash", "glm-4.5-flash"]) {
    assert.equal(costOf(id, usage).total, 0);
    assert.equal(costOf(id, usage).source, "priced");
  }
  const cost = costOf("glm-5.3", { ...usage, cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M } });
  assert.equal(cost.cacheWrite, 0);
});
test("zai: unknown-window GLM rows store null/null even above one million", (t) => {
  for (const [id, , , , window] of entries.filter((e) => e[4] === null)) {
    const row = transcript(t, id);
    assert.equal(row.contextMax, window, id);
    assert.equal(row.contextFillPct, null, id);
    assert.equal(row.contextTokens, 3100000);
  }
});
test("zai: unknown GLM keeps explicit Claude estimate and null window", (t) => {
  const row = transcript(t, "GLM-999-unknown");
  assert.equal(row.vendor, "z.ai");
  assert.equal(row.cost.source, "estimated");
  assert.equal(row.cost.estimatedRate, true);
  assert.equal(row.cost.total, 11.625);
  assert.equal(row.cost.supersedes, undefined);
  assert.equal(row.contextMax, null);
  assert.equal(row.contextFillPct, null);
});
test("zai: a dash is an unavailable cache rate, never free caching", () => {
  assert.equal(costOf("glm-4-32b-0414-128k", { input_tokens: M }).source, "priced");
  const cost = costOf("glm-4-32b-0414-128k", { cache_read_input_tokens: M });
  assert.equal(cost.cacheRead, .1);
  assert.equal(cost.source, "estimated");
  assert.equal(cost.estimatedRate, true);
});

// The shape docs.z.ai actually serves at pricing.md: escaped dollars, no /MTok suffix, dashes for a
// model with no cache pricing at all. Taken from the live page on 2026-09-27.
const LIVE_PAGE = String.raw`
| Model          | Input  | Cached Input | Cached Input Storage | Output |
| :------------- | :----- | :----------- | :------------------- | :----- |
| GLM-5.3-Flash  | \$0.15 | \$0.03       | Limited-time Free    | \$0.50 |
| GLM-4.6        | \$0.6  | \$0.11       | Limited-time Free    | \$2.2  |
| GLM-4.7-Flash  | Free   | Free         | Free                 | Free   |
| GLM-4-32B-0414-128K | \$0.1  | -            | -                    | \$0.1  |
`;

test("the pricing page z.ai serves parses: escaped prices, no suffix, and dashes for a model without caching", () => {
  assert.ok(remote.PRICING_URL.endsWith(".md"), "the page path itself answers with HTML, which parses to nothing");
  const rates = remote.parsePricingMarkdown(LIVE_PAGE);
  assert.deepEqual(rates["glm-4.6"], { input: 0.6, cacheRead: 0.11, output: 2.2, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.deepEqual(rates["glm-5.3-flash"], { input: 0.15, cacheRead: 0.03, output: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.deepEqual(rates["glm-4.7-flash"], { input: 0, cacheRead: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  // A dash in both cache columns: no write charge, and a read the page cannot state.
  assert.deepEqual(rates["glm-4-32b-0414-128k"], { input: 0.1, cacheRead: null, output: 0.1, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.equal(Object.keys(rates).length, 4);
});

const PAGE = `
| Model | Input | Cached Input | Cached Input Storage | Output |
| --- | --- | --- | --- | --- |
| GLM-4.6 | $0.6/MTok | $0.11/MTok | Limited-time Free | $2.2/MTok |
| **GLM-5.3-Flash** | $0.15 / MTok | $0.03/MTok | Free | $0.50/MTok |
| GLM-4.7-Flash | Free | Free | Limited-time Free | Free |
| GLM-4-32b-0414-128k | $0.1/MTok | — | Free | $0.1/MTok |
| GLM-4.6 | $99/MTok | $99/MTok | Free | $99/MTok |
| GLM-bad | $1/MTok | missing | Free | $2/MTok |
| GLM-partial | $1/MTok | Free | $2/MTok |
| GLM-negative | $-1/MTok | Free | Free | $2/MTok |
| GLM-malformed | $1.2.3/MTok | Free | Free | $2/MTok |
| GLM-storage | $1/MTok | Free | unknown | $2/MTok |

| Model | Input | Output |
| --- | --- | --- |
| GLM-batch | $1/MTok | $2/MTok |
`;
const response = (text = PAGE) => ({ ok: true, status: 200, text: async () => text, headers: { get: () => "v1" } });
test("zai: canonical markdown parses Free, storage, dash and rejects malformed rows", () => {
  const rates = remote.parsePricingMarkdown(PAGE);
  assert.equal(Object.keys(rates).length, 4);
  assert.deepEqual(rates["glm-4.6"], { input: .6, cacheRead: .11, output: 2.2, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.equal(rates["glm-4.7-flash"].output, 0);
  assert.equal(rates["glm-4-32b-0414-128k"].cacheRead, null);
});
test("zai: remote merge preserves windows, complete prices and previous overrides", () => {
  const original = { ...zai.modelInfo("glm-5.3") };
  zai.applyRemoteRates({ "GLM-5.3": { input: 2, output: 5, cacheRead: .3, cacheWrite5m: .4, cacheWrite1h: .4 } });
  assert.equal(zai.modelInfo("glm-5.3").input, 2);
  assert.equal(zai.knownContextMax("glm-5.3"), M);
  for (const bad of [{ input: 9, output: 9 }, { ...original, cacheWrite5m: undefined }, { ...original, cacheWrite1h: -1 }, { ...original, input: NaN }, { ...original, cacheRead: -1 }, { ...original, output: "2" }]) {
    zai.applyRemoteRates({ "glm-5.3": bad });
    assert.equal(zai.modelInfo("glm-5.3").input, 2);
  }
  zai.applyRemoteRates({ "glm-5.3": original, "glm-future-test": { ...original, contextMax: M } });
  assert.equal(zai.knownContextMax("glm-future-test"), null, "remote windows are ignored");
  assert.equal(costOf("glm-future-test", usage).source, "priced");
});
test("zai: refresh updated/fresh/unchanged/304 retains rates, etag and timeout", async (t) => {
  const file = path.join(temp(t), "pricing.json");
  let calls = 0;
  const timeout = t.mock.method(AbortSignal, "timeout");
  const fetchImpl = async (url, opts) => {
    calls++;
    assert.equal(url, remote.PRICING_URL);
    assert.ok(opts.signal instanceof AbortSignal);
    if (calls > 1) assert.equal(opts.headers["if-none-match"], "v1");
    return response();
  };
  assert.equal((await remote.refreshPricing({ file, now: 100000000, fetchImpl })).status, "updated");
  assert.equal((await remote.refreshPricing({ file, now: 100000001, fetchImpl })).status, "fresh");
  assert.equal(calls, 1);
  assert.equal(timeout.mock.calls[0].arguments[0], 10000);
  assert.equal((await remote.refreshPricing({ file, now: 100000002, ttlMs: 0, fetchImpl })).status, "unchanged");
  assert.equal((await remote.refreshPricing({ file, now: 100000003, ttlMs: 0, fetchImpl: async () => ({ status: 304 }) })).status, "not-modified");
  assert.equal(remote.readCachedRates(file)["glm-4.6"].input, .6);
  assert.equal(JSON.parse(fs.readFileSync(file)).fetchedAt, 100000003);
  assert.equal(path.basename(remote.CACHE_FILE), "pricing-zai.json");
});
for (const [status, fetchImpl] of [
  ["offline", async () => { throw Error("offline"); }],
  ["http-503", async () => ({ ok: false, status: 503 })],
  ["read-error", async () => ({ ...response(), text: async () => { throw Error("read"); } })],
  ["parse-thin", async () => response("redesigned")],
]) test(`zai: ${status} retains cache and backs off one hour`, async (t) => {
  const file = path.join(temp(t), "pricing.json");
  const rates = remote.parsePricingMarkdown(PAGE);
  fs.writeFileSync(file, JSON.stringify({ rates, fetchedAt: 1 }));
  const now = 100000000;
  const first = await remote.refreshPricing({ file, now, fetchImpl });
  assert.equal(first.status, status);
  assert.deepEqual(first.rates, rates);
  assert.equal(JSON.parse(fs.readFileSync(file)).attemptedAt, now);
  const opts = { file, now: now + 60000, fetchImpl };
  assert.equal((await remote.refreshPricing(opts)).status, "backoff");
  assert.equal((await remote.refreshPricing({ ...opts, now: now + 3600001 })).status, status);
  assert.equal((await remote.refreshPricing({ ...opts, now: now + 3600002, ttlMs: 0 })).status, status);
});
test("zai: partial successful refresh retains omitted previously cached models", async (t) => {
  const file = path.join(temp(t), "pricing.json");
  const extra = { input: 8, output: 9, cacheRead: 1, cacheWrite5m: 0, cacheWrite1h: 0 };
  fs.writeFileSync(file, JSON.stringify({ rates: { "glm-previous": extra } }));
  const result = await zai.refreshPricing({ file, ttlMs: 0, fetchImpl: async () => response() });
  assert.equal(result.status, "updated");
  assert.deepEqual(result.rates["glm-previous"], extra);
  assert.equal(zai.modelInfo("glm-previous").input, 8);
});
test("zai: no-refresh blocks every real fetch and imports stay offline", async (t) => {
  const dir = temp(t);
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error("unexpected fetch"); };
  try {
    for (const [i, mod] of [remote, zai,
      await import("../src/providers/claude/remote-pricing.mjs"),
      await import("../src/providers/codex/remote-pricing.mjs"),
      await import("../src/providers/cursor/remote-pricing.mjs")].entries()) {
      assert.equal((await mod.refreshPricing({ file: path.join(dir, `${i}.json`), ttlMs: 0 })).status, "no-fetch");
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
  const flag = process.env.AI_USAGE_NO_PRICING_REFRESH;
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { calls++; throw Error("import tried network"); };
  process.env.AI_USAGE_NO_PRICING_REFRESH = "0";
  try {
    await import(`../src/lib/vendors/zai/pricing.mjs?offline=${Date.now()}`);
    await import(`../src/providers/claude/transcript.mjs?offline=${Date.now()}`);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = fetch; process.env.AI_USAGE_NO_PRICING_REFRESH = flag; }
});
test("zai: vendor distinguishes models, unknowns and strips recursively with meta", (t) => {
  for (const [id, vendor] of [["GLM-999", "z.ai"], ["zai/GLM-5.3-Flash", "z.ai"], ["claude-opus-5", "anthropic"], ["claude-haiku-4-5-20251001", "anthropic"], ["gpt-5.5", "openai"], ["gpt-unknown", null], ["claude-unknown", null], [null, null]]) assert.equal(vendorOf(id), vendor, id);
  for (const [id, vendor] of [["claude-opus-5", "anthropic"], ["gpt-5.5", "openai"], ["unlisted", null]]) assert.equal(transcript(t, id).vendor, vendor);
  const row = { ...transcript(t, "glm-5.3"), subagents: [{ vendor: "z.ai", subagents: [{ vendor: "openai" }] }] };
  assert.equal(applyFieldSelection(row, {}).vendor, "z.ai");
  const stripped = applyFieldSelection(row, { meta: false });
  assert.equal("vendor" in stripped, false);
  assert.equal("vendor" in stripped.subagents[0], false);
  assert.equal("vendor" in stripped.subagents[0].subagents[0], false);
});
test("zai: revision and supersedes repair stale GLM exactly once", async (t) => {
  const file = path.join(temp(t), "rows.ndjson");
  const fresh = transcript(t, "glm-4.6");
  assert.equal(fresh.cost.rates, RATES_REVISION);
  assert.ok(fresh.cost.rates >= 3, "at or after the revision that corrected GLM");
  assert.equal(fresh.cost.supersedes, 3);
  await upsertSession(file, "s", [{ ...fresh, cost: { total: 11.625, source: "estimated", rates: 2 } }]);
  await upsertSession(file, "s", [fresh]);
  const read = () => JSON.parse(fs.readFileSync(file, "utf8").trim());
  assert.equal(read().cost.total, 1.26);
  assert.equal(read().cost.source, "priced");
  await upsertSession(file, "s", [{ ...fresh, cost: { ...fresh.cost, total: 2 } }]);
  assert.equal(read().cost.total, 1.26);
});
test("zai: upgrade through epoch 6 repairs GLM agents and later epochs add Codex", async (t) => {
  const file = path.join(temp(t), "scan.json");
  const affected = ["claude", "cursor", "opencode", "cline", "roo", "kilo"];
  fs.writeFileSync(file, JSON.stringify({ installedRepairEpoch: 5, providers: {} }));
  assert.equal(REPAIR_EPOCH, 9);
  await recordInstall({ file, upgrading: true, providerIds: [...affected, "codex", "future"] });
  for (const id of [...affected, "codex"]) assert.equal(repairDue(id, { file }), REPAIR_EPOCH, id);
  for (const id of ["future"]) assert.equal(repairDue(id, { file }), null, id);
});
test("zai: interactive refresh wiring and standalone viewer include the vendor", async (t) => {
  assert.ok(VIEWER_SIDECARS.some(([from, to]) => from === "lib/vendors/zai/remote-pricing.mjs" && to === "remote-pricing-zai.mjs"));
  const dir = temp(t);
  copyViewerSidecars(dir);
  assert.ok(fs.existsSync(path.join(dir, "remote-pricing-zai.mjs")));
  for (const file of ["install.mjs", "src/sync.mjs"]) assert.match(fs.readFileSync(file, "utf8"), /await refreshZaiPricing\(\{ timeoutMs: 5_000 \}\)/);
  assert.match(fs.readFileSync("viewer/server.mjs", "utf8"), /label: "z.ai", mod: await loadPricing\("\.\/remote-pricing-zai.mjs"/);
});


test("zai: orphaned unknown GLM context loses old guesses without repricing", async (t) => {
  const { repairStoredContext } = await import("../src/providers/claude/index.mjs");
  const file = path.join(temp(t), "rows.ndjson");
  const row = { provider: "claude", id: "old", model: "glm-5.2", contextTokens: 500000,
    contextMax: 1000000, contextFillPct: 50, cost: { total: 11.625, source: "estimated" } };
  fs.writeFileSync(file, JSON.stringify(row) + "\n");
  assert.equal(await repairStoredContext([file]), 1);
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.contextMax, null);
  assert.equal(after.contextFillPct, null);
  assert.deepEqual(after.cost, row.cost);
  assert.equal(await repairStoredContext([file]), 0);
});

import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyEndpoint, settingsEndpoint, readServiceTier, normalizeServiceTier } from "../src/lib/hook-pricing.mjs";
import * as codex from "../src/providers/codex/index.mjs";
import * as claude from "../src/providers/claude/index.mjs";
import * as cp from "../src/providers/codex/pricing.mjs";
import * as ap from "../src/providers/claude/pricing.mjs";
import * as openai from "../src/providers/codex/remote-pricing.mjs";
import * as models from "../src/lib/vendors/modelsdev/remote-pricing.mjs";
import { ingest, ingestTranscript } from "../src/lib/ingest.mjs";
import { preserveStoredFields } from "../src/lib/config.mjs";
import { correctable } from "../src/lib/estimates.mjs";
import { runLauncher } from "../src/record.mjs";
import { processEnvelope } from "../src/worker.mjs";

const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-pricing-limits-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
const jsonl = (file, rows) => write(file, rows.map(JSON.stringify).join("\n"));
const rows = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const store = (dir) => path.join(dir, ".ai-usage", "usage.ndjson");
// Settings in effect before the test turns ran: a sweep trusts only settings older than the turn.
const OLD = new Date("2026-01-01T00:00:00Z");
const settings = (dir, value, local = false, when = OLD) => {
  const file = path.join(dir, ".claude", `settings${local ? ".local" : ""}.json`);
  write(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: value } }));
  fs.utimesSync(file, when, when);
};
const hook = (file, cwd) => JSON.stringify({ transcript_path: file, cwd, session_id: "s" });

function rollout(file, cwd, model = "gpt-6-astra", sizes = [1000, 2000], cached = 0) {
  let total = 0;
  jsonl(file, [{ type: "session_meta", payload: { id: "s", cwd } }, ...sizes.flatMap((size, i) => {
    total += size;
    return [
      { type: "turn_context", payload: { model, turn_id: `t${i}` } },
      { type: "event_msg", timestamp: `2026-09-28T00:00:0${i}Z`, payload: { type: "user_message", message: "hi" } },
      { type: "event_msg", payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: total, cached_input_tokens: cached * (i + 1), output_tokens: (i + 1) * 10 },
        last_token_usage: { input_tokens: size, cached_input_tokens: cached, output_tokens: 10 },
      } } },
    ];
  })]);
}
function transcript(file, cwd, model = "qwen-local:tag", sizes = [1000, 2000], cached = 0, writes = 0) {
  jsonl(file, sizes.flatMap((size, i) => [
    { type: "user", uuid: `u${i}`, sessionId: "s", cwd, timestamp: `2026-09-28T00:00:0${i}Z`, message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: `a${i}`, sessionId: "s", cwd, message: { id: `m${i}`, role: "assistant", model,
      usage: { input_tokens: size, output_tokens: 10, cache_read_input_tokens: cached, cache_creation_input_tokens: writes }, content: [] } },
  ]));
}
function cache(t, data) {
  const file = models.CACHE_FILE, previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
  t.after(() => { if (previous) fs.writeFileSync(file, previous); else fs.rmSync(file, { force: true }); });
  write(file, JSON.stringify({ rates: models.parseModelsDev(data) }));
}

test("TOML tier reader takes the first top-level string and ignores profiles and comments", (t) => {
  const file = path.join(temp(t), "config.toml");
  write(file, '# service_tier = "flex"\n service_tier = "priority" # current\nservice_tier = "flex"\n[profiles.work]\nservice_tier = "fast"');
  assert.equal(readServiceTier(file), "priority");
  write(file, '[profiles.work]\nservice_tier = "fast"');
  assert.equal(readServiceTier(file), null);
  write(file, "service_tier = 'flex'\n[other]");
  assert.equal(readServiceTier(file), "flex");
  assert.equal(readServiceTier(path.join(file, "missing")), null);
});

for (const [value, expected] of [["priority", "fast"], ["fast", "fast"], ["flex", "flex"], ["default", "standard"],
  ["auto", "standard"], [null, "standard"], ["unknown", "standard"]]) {
  test(`Codex tier normalizes ${value} to ${expected}`, () => assert.equal(normalizeServiceTier(value), expected));
}

const HEADER = "| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |\n";
const table = (name, text) => `### ${name} pricing data\n\n${HEADER}${text}\n`;
const STANDARD = table("Standard", "| gpt-6-astra | $10 | $1 | $12.5 | $50 | $20 | $2 | $25 | $75 |\n| gpt-5.5 (<272K context length) | $5 | $0.5 | - | $30 | $10 | $1 | - | $45 |\n| gpt-4o-2024-05-13 | $2 | - | - | $6 | - | - | - | - |");
const FAST = table("Fast", "| gpt-6-astra | $20 | $2 | $25 | $100 | $40 | $4 | $50 | $150 |\n| gpt-5.5 (<272K context length) | $12.5 | $1.25 | - | $75 | - | - | - | - |\n| gpt-4o-2024-05-13 | $8.75 | - | - | $26.25 | - | - | - | - |");
const FLEX = table("Flex", "| gpt-6-astra | $5 | $0.5 | $6.25 | $25 | $10 | $1 | $12.5 | $37.5 |\n| gpt-5.5 (<272K context length) | $2.5 | $0.25 | - | $15 | $5 | $0.5 | - | $22.5 |");

test("OpenAI Fast/Flex share Standard row parsing, suffixes and dash cells; Batch is ignored", () => {
  const standard = openai.parsePricingMarkdown(STANDARD);
  const rates = openai.parsePricingMarkdown(FAST + FLEX + STANDARD + table("Batch", "| bogus | $1 | $1 | $1 | $1 | - | - | - | - |"));
  assert.deepEqual(Object.keys(rates), Object.keys(standard));
  for (const [id, rate] of Object.entries(rates)) {
    const { fast, flex, ...base } = rate;
    assert.deepEqual(base, standard[id]);
  }
  assert.deepEqual(rates["gpt-6-astra"].fast, { input: 20, cachedInput: 2, cacheWrite: 25, output: 100,
    long: { input: 40, cachedInput: 4, cacheWrite: 50, output: 150, threshold: 272000 } });
  assert.equal(rates["gpt-5.5"].fast.long, null);
  assert.equal(rates["gpt-5.5"].flex.long.threshold, 272000);
  assert.equal(rates["gpt-5.5"].flex.cacheWrite, null);
  assert.equal(rates["gpt-4o-2024-05-13"].fast.cachedInput, 8.75);
  assert.equal(rates["gpt-4o-2024-05-13"].flex, undefined);
  assert.deepEqual(openai.parsePricingMarkdown(STANDARD + FAST + FLEX), rates);
});

test("Codex schema rejects pre-service-tier caches and diff includes both nested service tiers", async (t) => {
  const file = path.join(temp(t), "cache.json");
  write(file, JSON.stringify({ schema: 3, rates: openai.parsePricingMarkdown(STANDARD) }));
  assert.equal(openai.readCachedRates(file), null);
  const rates = openai.parsePricingMarkdown(STANDARD + FAST + FLEX);
  for (const service of ["fast", "flex"]) {
    const next = structuredClone(rates); next["gpt-6-astra"][service].long.cacheWrite++;
    assert.equal(openai.diffRates(rates, next)[0].type, "changed");
    next["gpt-6-astra"][service] = undefined;
    assert.equal(openai.diffRates(rates, next).length, 1);
  }
  await openai.refreshPricing({ file, fetchImpl: async (url) => url === openai.PRICING_URL
    ? { ok: true, text: async () => STANDARD + FAST + FLEX, headers: { get: () => null } } : { ok: false } });
  assert.deepEqual(openai.readCachedRates(file), Object.fromEntries(Object.entries(rates).map(([id, r]) => [id, { ...r, source: "openai" }])));
});

for (const [model, serviceTier, short, long] of [
  ["gpt-6-astra", "fast", [20, 2, 100], [40, 4, 150]],
  ["gpt-6-astra", "flex", [5, .5, 25], [10, 1, 37.5]],
  ["gpt-6-sol", "fast", [4, .4, 20], [8, .8, 30]],
  ["gpt-5.6-sol", "fast", [8, .8, 40], [16, 1.6, 60]],
  ["gpt-5.5", "fast", [12.5, 1.25, 75], [12.5, 1.25, 75]],
  ["gpt-5.5", "flex", [2.5, .25, 15], [5, .5, 22.5]],
]) test(`Codex ${model} ${serviceTier} uses its short and long rates`, () => {
  for (const [isLong, values] of [[false, short], [true, long]]) {
    const c = cp.costOf(model, { input: 1e6, cached: 1e6, output: 1e6 }, { serviceTier, long: isLong });
    assert.deepEqual([c.input, c.cacheRead, c.output], values); assert.equal(c.source, "priced");
  }
});

test("Codex fetched service rates override built-ins and missing service prices are estimated Standard", () => {
  cp.applyRemoteRates({ "gpt-service-test": { input: 3, cachedInput: .3, output: 15,
    fast: { input: 9, cachedInput: .9, output: 45, long: { input: 18, cachedInput: 1.8, output: 60, threshold: 100 } },
    flex: { input: 1, cachedInput: .1, output: 5 } } });
  assert.equal(cp.costOf("gpt-service-test", { input: 1e6 }, { serviceTier: "fast", long: true }).total, 18);
  assert.equal(cp.costOf("gpt-service-test", { input: 1e6 }, { serviceTier: "flex" }).total, 1);
  for (const serviceTier of ["fast", "flex"]) {
    const c = cp.costOf("gpt-5.4-mini", { input: 1e6 }, { serviceTier });
    assert.equal(c.total, .75); assert.equal(c.source, "estimated");
    assert.equal(cp.costOf("gpt-5.4-mini", {}, { serviceTier }).source, "priced");
  }
  cp.clearGuessedModels();
});

test("Codex hook stamps only the last turn; sweep never reads the live config", async (t) => {
  const dir = temp(t), file = path.join(dir, "rollout.jsonl");
  process.env.CODEX_HOME = path.join(dir, "codex");
  write(path.join(process.env.CODEX_HOME, "config.toml"), 'service_tier = "priority"');
  rollout(file, dir);
  assert.ok(codex.buildTurns(file).every((r) => r.serviceTier === null));
  await ingest(codex, hook(file, dir));
  const saved = rows(store(dir));
  assert.equal(saved[0].serviceTier, null); assert.equal(saved[1].serviceTier, "fast");
  near(saved[0].cost.total, .01 + .0005); near(saved[1].cost.total, .04 + .001);
});

test("stored Codex tier feeds sweep repricing and changed token counts after config switches", async (t) => {
  const dir = temp(t), file = path.join(dir, "rollout.jsonl");
  rollout(file, dir);
  await ingest(codex, hook(file, dir), { serviceTier: "flex" });
  rollout(file, dir, "gpt-6-astra", [1000, 300000]);
  await ingestTranscript(codex, { transcriptPath: file });
  let saved = rows(store(dir));
  assert.equal(saved[1].serviceTier, "flex"); near(saved[1].cost.total, 3 + .000375);
  const previous = process.env.AI_USAGE_REPRICE;
  try {
    process.env.AI_USAGE_REPRICE = "1";
    await ingestTranscript(codex, { transcriptPath: file });
    saved = rows(store(dir));
    assert.equal(saved[1].serviceTier, "flex"); near(saved[1].cost.total, 3 + .000375);
  } finally { if (previous === undefined) delete process.env.AI_USAGE_REPRICE; else process.env.AI_USAGE_REPRICE = previous; }
});

for (const [value, expected] of [
  [undefined, "anthropic"], ["", "anthropic"], ["https://api.anthropic.com/v1", "anthropic"],
  ["http://localhost:11434", "local"], ["http://foo.localhost", "local"], ["http://127.93.2.1", "local"],
  ["http://0.0.0.0", "local"], ["http://host.docker.internal:1234", "local"], ["http://10.255.0.1", "local"],
  ["http://172.16.0.1", "local"], ["http://172.31.255.254", "local"], ["http://192.168.1.1", "local"],
  ["http://169.254.0.1", "local"], ["http://[::1]:8080", "local"], ["http://[0:0:0:0:0:0:0:1]", "local"],
  ["http://[fc00::1]", "local"], ["http://[fdff:abcd::1]", "local"],
  ["http://172.15.255.255", "remote"], ["http://172.32.0.1", "remote"], ["http://192.169.1.1", "remote"],
  ["http://169.253.1.1", "remote"], ["https://api.example.com", "remote"], ["http://localhost.example.com", "remote"],
  ["https://api.anthropic.com.example.com", "remote"], ["http://[2001:db8::1]", "remote"],
  ["http://[fe80::1]", "remote"], ["bad URL", "remote"],
]) test(`endpoint classifier: ${value} is ${expected}`, () => assert.equal(classifyEndpoint(value), expected));

test("endpoint settings use project local, project, then global; absent differs from empty", (t) => {
  const dir = temp(t), project = path.join(dir, "project"), home = path.join(dir, "home");
  assert.equal(settingsEndpoint(project, home), null);
  settings(home, "https://api.example.com");
  assert.equal(settingsEndpoint(project, home), "remote");
  settings(project, "http://localhost");
  assert.equal(settingsEndpoint(project, home), "local");
  settings(project, "", true);
  assert.equal(settingsEndpoint(project, home), "anthropic");
  write(path.join(project, ".claude", "settings.local.json"), "invalid JSON");
  assert.equal(settingsEndpoint(project, home), "local");
});

test("Claude local endpoint costs zero without guesses or estimate correction; colon tag alone is not local", () => {
  ap.clearGuessedModels();
  const usage = { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6, speed: "fast" };
  const c = ap.costOf("unpublished:tag", usage, { endpoint: "local" });
  assert.equal(c.total, 0); assert.equal(c.source, "priced"); assert.equal(c.rateSource, "local");
  assert.deepEqual(ap.guessedModels(), []);
  assert.equal(correctable({ endpoint: "local", usage: { input: 1e6 }, cost: c, model: "unpublished:tag" }, () => true), false);
  assert.equal(ap.costOf("unpublished:tag", usage).source, "estimated");
  for (const endpoint of ["anthropic", "remote"]) assert.equal(ap.costOf("claude-sonnet-4-6", usage, { endpoint }).input, 3);
  ap.clearGuessedModels();
});

test("Claude hook env stamps only the last turn; sweep uses settings and ignores process env", async (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  transcript(file, dir);
  process.env.ANTHROPIC_BASE_URL = "http://localhost:11434";
  await ingest(claude, hook(file, dir));
  const saved = rows(store(dir));
  assert.equal(saved[0].endpoint, undefined); assert.equal(saved[0].cost.source, "estimated");
  assert.equal(saved[1].endpoint, "local"); assert.equal(saved[1].cost.total, 0);
  const fresh = claude.buildTurns(file);
  assert.ok(fresh.every((r) => r.endpoint === undefined));
  settings(dir, "https://api.example.com");
  assert.ok(claude.buildTurns(file).every((r) => r.endpoint === "remote"));
});

test("Claude settings-local fallback prices every sweep turn at zero and survives missing settings", async (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  transcript(file, dir); settings(dir, "http://10.0.0.2", true);
  ap.clearGuessedModels();
  await ingest(claude, hook(file, dir));
  assert.ok(rows(store(dir)).every((r) => r.endpoint === "local" && r.cost.rateSource === "local" && r.cost.source === "priced"));
  assert.deepEqual(ap.guessedModels(), []);
  fs.rmSync(path.join(dir, ".claude", "settings.local.json"));
  transcript(file, dir, "qwen-local:tag", [3000, 4000]);
  await ingestTranscript(claude, { transcriptPath: file });
  assert.ok(rows(store(dir)).every((r) => r.endpoint === "local" && r.cost.total === 0 && r.cost.source === "priced"));
  assert.deepEqual(ap.guessedModels(), []);
});

test("new local endpoint evidence replaces an old priced amount", async (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  transcript(file, dir, "claude-sonnet-4-6", [1000]);
  await ingestTranscript(claude, { transcriptPath: file });
  assert.ok(rows(store(dir))[0].cost.total > 0);
  settings(dir, "http://localhost");
  await ingestTranscript(claude, { transcriptPath: file });
  assert.equal(rows(store(dir))[0].cost.total, 0);
});

test("stored billing classifications survive blank rereads independently of field toggles", () => {
  const previous = { serviceTier: "fast", endpoint: "local" };
  assert.deepEqual(preserveStoredFields({ serviceTier: null }, previous, {}), previous);
  assert.deepEqual(preserveStoredFields({}, previous, { meta: false }), previous);
});

test("spool captures Codex tier and Claude classification before worker drain, never endpoint secrets", async (t) => {
  const dir = temp(t), spool = path.join(dir, "spool"), file = path.join(dir, "s.jsonl");
  process.env.CODEX_HOME = path.join(dir, "codex");
  const config = path.join(process.env.CODEX_HOME, "config.toml");
  rollout(file, dir);
  write(config, 'service_tier = "priority"');
  await runLauncher({ provider: "codex", input: hook(file, dir), cwd: dir, dir: spool, spawnWorker: false });
  write(config, 'service_tier = "flex"');
  const first = fs.readdirSync(spool)[0];
  const envelope = JSON.parse(fs.readFileSync(path.join(spool, first), "utf8"));
  assert.deepEqual(envelope.pricing, { serviceTier: "fast" });
  await processEnvelope(envelope);
  assert.equal(rows(store(dir)).at(-1).serviceTier, "fast");
  fs.rmSync(path.join(spool, first));
  transcript(file, dir);
  process.env.ANTHROPIC_BASE_URL = "http://user:secret-key@localhost:11434/v1?token=secret-token";
  await runLauncher({ provider: "claude", input: hook(file, dir), cwd: dir, dir: spool, spawnWorker: false });
  delete process.env.ANTHROPIC_BASE_URL;
  const text = fs.readFileSync(path.join(spool, fs.readdirSync(spool)[0]), "utf8");
  assert.doesNotMatch(text, /localhost|secret-key|secret-token|11434/);
  assert.deepEqual(JSON.parse(text).pricing, { endpoint: "local" });
  await processEnvelope(JSON.parse(text));
  assert.equal(rows(store(dir)).filter((r) => r.provider === "claude").at(-1).cost.total, 0);
});

const MODEL = "qwen-context-test";
const TIERS = { alibaba: { models: { [MODEL]: { cost: { input: 1.5, output: 7.5, cache_read: .15, cache_write: 2,
  tiers: [
    { input: 4.5, output: 22.5, cache_read: .45, cache_write: 6, tier: { type: "context", size: 128000 } },
    { input: 999, output: 999, tier: { type: "batch", size: 100 } },
    { input: 2.7, output: 13.5, tier: { type: "context", size: 32000 } },
    { input: -1, output: 2, tier: { type: "context", size: 50 } },
  ] } } } } };

test("models.dev retains sorted valid context tiers and drops other types and unrelated fields", () => {
  const tiers = models.parseModelsDev(TIERS).alibaba[MODEL].tiers;
  assert.deepEqual(tiers, [
    { size: 32000, input: 2.7, output: 13.5, cacheRead: null, cacheWrite: null },
    { size: 128000, input: 4.5, output: 22.5, cacheRead: .45, cacheWrite: 6 },
  ]);
  const next = structuredClone(TIERS); next.alibaba.models[MODEL].cost.tiers[0].input++;
  assert.equal(models.diffRates(models.parseModelsDev(TIERS), models.parseModelsDev(next))[0].type, "changed");
});

for (const [size, rate] of [[31999, 1.5], [32000, 1.5], [32001, 2.7], [127999, 2.7], [128000, 2.7], [128001, 4.5]]) {
  for (const provider of [claude, codex]) test(`${provider.id} request context ${size} selects exclusive tier rate ${rate}`, (t) => {
    cache(t, TIERS);
    const dir = temp(t), file = path.join(dir, "s.jsonl");
    if (provider === claude) transcript(file, dir, MODEL, [size - 20], 10, 10);
    else rollout(file, dir, MODEL, [size], 10);
    const c = provider.buildTurns(file)[0].cost;
    near(c.input, (size - (provider === claude ? 20 : 10)) * rate / 1e6);
    near(c.output, 10 * rate * 5 / 1e6);
    near(c.cacheRead, 10 * (rate === 2.7 ? rate : rate / 10) / 1e6);
    if (provider === claude) near(c.cacheWrite, 10 * (rate === 1.5 ? 2 : rate === 2.7 ? 2.7 : 6) / 1e6);
    assert.equal(c.source, rate === 2.7 ? "estimated" : "priced");
  });
}

test("both agents price separate requests, never the turn's summed prompt tokens", (t) => {
  cache(t, TIERS);
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  transcript(file, dir, MODEL, [20000, 20000]);
  const entries = rows(file); entries.splice(2, 1); jsonl(file, entries);
  near(claude.buildTurns(file)[0].cost.total, (40000 * 1.5 + 20 * 7.5) / 1e6);
  rollout(file, dir, MODEL, [20000, 20000]);
  const events = rows(file); events.splice(4, 2); jsonl(file, events);
  near(codex.buildTurns(file)[0].cost.total, (40000 * 1.5 + 20 * 7.5) / 1e6);
});

test("context tier without cache hits stays priced when only inputs or cache writes are used", (t) => {
  cache(t, TIERS);
  const c = ap.costOf(MODEL, { input_tokens: 30000, cache_creation_input_tokens: 3000 });
  assert.equal(c.source, "priced"); near(c.cacheWrite, 3000 * 2.7 / 1e6);
  const d = cp.costOf(MODEL, { input: 33000 }, { promptSize: 33000 });
  assert.equal(d.source, "priced"); near(d.total, 33000 * 2.7 / 1e6);
});

test("an empty Claude local turn still records priced local provenance", (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  transcript(file, dir, "unpublished:tag", [0]);
  jsonl(file, rows(file).slice(0, 1));
  settings(dir, "http://localhost");
  const c = claude.buildTurns(file)[0].cost;
  assert.equal(c.total, 0); assert.equal(c.source, "priced"); assert.equal(c.rateSource, "local");
});

test("Claude local endpoint covers subagent and nested subagent costs without guesses", (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl"), sub = path.join(dir, "s", "subagents");
  transcript(file, dir, "unpublished:tag", [1000]);
  const entries = rows(file);
  entries[1].message.content = [{ type: "tool_use", id: "launch", name: "Agent", input: {} }];
  jsonl(file, entries);
  transcript(path.join(sub, "agent-a.jsonl"), dir, "other-local:tag", [2000]);
  const agent = rows(path.join(sub, "agent-a.jsonl"));
  agent[1].message.content = [{ type: "tool_use", id: "child", name: "Agent", input: {} }];
  jsonl(path.join(sub, "agent-a.jsonl"), agent);
  write(path.join(sub, "agent-a.meta.json"), JSON.stringify({ toolUseId: "launch" }));
  transcript(path.join(sub, "agent-b.jsonl"), dir, "nested-local:tag", [3000]);
  write(path.join(sub, "agent-b.meta.json"), JSON.stringify({ toolUseId: "child" }));
  settings(dir, "http://localhost");
  ap.clearGuessedModels();
  const r = claude.buildTurns(file)[0];
  assert.equal(r.usage.input, 6000);
  for (const row of [r, r.subagents[0], r.subagents[0].subagents[0]]) {
    assert.equal(row.cost.total, 0); assert.equal(row.cost.source, "priced"); assert.equal(row.cost.rateSource, "local");
  }
  assert.deepEqual(ap.guessedModels(), []);
});

test("stored endpoint wins over changed settings during explicit repricing", async (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  transcript(file, dir, "unpublished:tag", [1000]);
  await ingest(claude, hook(file, dir), { endpoint: "local" });
  settings(dir, "https://api.anthropic.com");
  const previous = process.env.AI_USAGE_REPRICE;
  try {
    process.env.AI_USAGE_REPRICE = "1";
    await ingestTranscript(claude, { transcriptPath: file });
    const r = rows(store(dir))[0];
    assert.equal(r.endpoint, "local"); assert.equal(r.cost.total, 0); assert.equal(r.cost.rateSource, "local");
  } finally { if (previous === undefined) delete process.env.AI_USAGE_REPRICE; else process.env.AI_USAGE_REPRICE = previous; }
});

test("fetched dated OpenAI model uses its own Fast price and explicit no-discount cache cells", () => {
  cp.applyRemoteRates(openai.parsePricingMarkdown(STANDARD + FAST));
  const c = cp.costOf("gpt-4o-2024-05-13", { input: 1e6, cached: 1e6, output: 1e6 }, { serviceTier: "fast" });
  assert.equal(c.input, 8.75); assert.equal(c.cacheRead, 8.75); assert.equal(c.output, 26.25);
  assert.equal(c.source, "priced"); assert.equal(cp.knownModel("gpt-4o-2024-05-13"), true);
});

test("Codex turn tier prices every short and long request plus its unaccounted remainder", (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  rollout(file, dir, "gpt-6-astra", [20000, 300000]);
  const events = rows(file); events.splice(4, 2);
  events.push({ type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: 321000, output_tokens: 21 },
  } } });
  jsonl(file, events);
  const turns = codex.buildTurns(file, { hookPricing: { serviceTier: "fast" } });
  assert.equal(turns.length, 1); near(turns[0].cost.total, 12.4226);
});

test("Claude settings classification follows each turn cwd while stored metadata follows session home", async (t) => {
  const dir = temp(t), other = path.join(dir, "other"), file = path.join(dir, "s.jsonl");
  transcript(file, dir, "unpublished:tag");
  settings(dir, "http://localhost"); settings(other, "https://api.example.com");
  const entries = rows(file); entries[2].cwd = other; entries[3].cwd = other; jsonl(file, entries);
  await ingestTranscript(claude, { transcriptPath: file });
  let saved = rows(store(dir));
  assert.equal(saved[0].endpoint, "local"); assert.equal(saved[1].endpoint, "remote");
  fs.rmSync(path.join(dir, ".claude", "settings.json")); fs.rmSync(path.join(other, ".claude", "settings.json"));
  entries[3].message.usage.input_tokens++; jsonl(file, entries);
  await ingestTranscript(claude, { transcriptPath: file, cwd: other });
  saved = rows(store(dir));
  assert.equal(saved[0].endpoint, "local"); assert.equal(saved[1].endpoint, "remote");
  assert.equal(fs.existsSync(store(other)), false);
});

test("Codex standalone models.dev supplement retains and prices context tiers without shared cache", (t) => {
  cache(t, {});
  const rates = openai.parseModelsDev({ openai: { models: { "gpt-context-supplement": TIERS.alibaba.models[MODEL] } } });
  assert.deepEqual(rates["gpt-context-supplement"].tiers, models.parseModelsDev(TIERS).alibaba[MODEL].tiers);
  cp.applyRemoteRates({ "gpt-context-supplement": { ...rates["gpt-context-supplement"], source: "models.dev" } });
  const c = cp.costOf("gpt-context-supplement", { input: 33000, cached: 10 }, { promptSize: 33010 });
  near(c.input, 33000 * 2.7 / 1e6); near(c.cacheRead, 10 * 2.7 / 1e6); assert.equal(c.source, "estimated");
  cp.clearGuessedModels();
});

test("Codex shared-cache supplement retains context tiers across its own cache refresh", async (t) => {
  const dir = temp(t), file = path.join(dir, "prices.json"), modelsFile = path.join(dir, "models.json");
  const rates = models.parseModelsDev({ openai: { models: { "gpt-shared-tiers": TIERS.alibaba.models[MODEL] } } });
  write(modelsFile, JSON.stringify({ rates, fetchedAt: Date.now() }));
  const result = await openai.refreshPricing({ file, modelsFile, fetchImpl: async () => ({
    ok: true, text: async () => STANDARD, headers: { get: () => null },
  }) });
  assert.deepEqual(result.rates["gpt-shared-tiers"].tiers, rates.openai["gpt-shared-tiers"].tiers);
});

test("legacy queued Codex hook cannot infer its tier from today's config", async (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  process.env.CODEX_HOME = path.join(dir, "codex");
  write(path.join(process.env.CODEX_HOME, "config.toml"), 'service_tier = "fast"');
  rollout(file, dir);
  await processEnvelope({ provider: "codex", cwd: dir, raw: hook(file, dir) });
  assert.ok(rows(store(dir)).every((r) => r.serviceTier === null));
});

test("Claude context prompt size uses cache lifetime breakdown when creation total is absent", (t) => {
  cache(t, TIERS);
  const c = ap.costOf(MODEL, { input_tokens: 30000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 1001 } });
  near(c.input, 30000 * 2.7 / 1e6); near(c.cacheWrite, 2001 * 2.7 / 1e6); assert.equal(c.source, "priced");
});

test("Claude platform context tier uses its own missing-cache rules instead of base Anthropic ratios", (t) => {
  const model = "us.anthropic.claude-opus-5-5";
  cache(t, { "amazon-bedrock": { models: { [model]: TIERS.alibaba.models[MODEL] } } });
  const c = ap.costOf(model, { input_tokens: 32001, cache_read_input_tokens: 10, cache_creation_input_tokens: 10 });
  near(c.input, 32001 * 2.7 / 1e6); near(c.cacheWrite, 10 * 2.7 / 1e6); near(c.cacheRead, 10 * 2.7 / 1e6);
  assert.equal(c.source, "estimated");
});

test("Codex shared OpenAI context tier missing hits uses tier input instead of the base 10-percent guess", (t) => {
  const model = "gpt-context-shared-new";
  cache(t, { openai: { models: { [model]: TIERS.alibaba.models[MODEL] } } });
  const c = cp.costOf(model, { input: 32001, cached: 10 }, { promptSize: 32011 });
  near(c.input, 32001 * 2.7 / 1e6); near(c.cacheRead, 10 * 2.7 / 1e6); assert.equal(c.source, "estimated");
  cp.clearGuessedModels();
});

// Pointing Claude Code at a local model today says nothing about the turns before it: a sweep
// or repair that took today's settings as history would turn every API cost into $0.
test("settings changed after a turn ran are not evidence for it; the stored cost stands", async (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  transcript(file, dir, "claude-sonnet-4-6", [1000]);
  await ingestTranscript(claude, { transcriptPath: file });
  const priced = rows(store(dir))[0].cost.total;
  assert.ok(priced > 0);
  settings(dir, "http://localhost", false, new Date());
  await ingestTranscript(claude, { transcriptPath: file });
  const [row] = rows(store(dir));
  assert.equal(row.endpoint, undefined);
  assert.equal(row.cost.total, priced);
  assert.equal(settingsEndpoint(dir, path.join(dir, "home"), Date.parse("2026-09-28T00:00:00Z")), null);
  assert.equal(settingsEndpoint(dir, path.join(dir, "home")), "local", "the hook records the turn that just ended, so today's settings apply");
});

// ---- Evidence from history: Codex's own log database, and Anthropic's request ids.
import { tierFromTags, threadTiers, tierAt, closeTierLog } from "../src/providers/codex/service-tiers.mjs";

const sqliteReady = !!process.getBuiltinModule?.("node:sqlite");
const needsSqlite = { skip: sqliteReady ? false : "node:sqlite needs Node >= 22.5" };
// A logs_2.sqlite shaped like Codex's: one feedback_tags entry per turn, logged as it starts.
function tierLog(t, entries, extra = []) {
  t.after(closeTierLog); // before temp(t): the open database must be closed before its folder goes
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const file = path.join(temp(t), "logs_2.sqlite");
  const db = new DatabaseSync(file);
  db.exec("create table logs (id integer primary key autoincrement, ts integer not null, ts_nanos integer not null, level text not null, target text not null, feedback_log_body text, thread_id text)");
  const add = db.prepare("insert into logs (ts, ts_nanos, level, target, feedback_log_body, thread_id) values (?, ?, 'INFO', ?, ?, ?)");
  for (const [iso, tier, thread = "s", target = "feedback_tags"] of [...entries, ...extra]) {
    const ms = Date.parse(iso);
    add.run(Math.floor(ms / 1000), (ms % 1000) * 1e6, target, `{"model":"x","service_tier":${tier === null ? "null" : `"${tier}"`},"token_budget":1}`, thread);
  }
  db.close();
  return file;
}

test("feedback tags name the tier; anything else names none", () => {
  assert.equal(tierFromTags('{"service_tier":"priority"}'), "fast");
  assert.equal(tierFromTags('{"service_tier":"fast"}'), "fast");
  assert.equal(tierFromTags('{"service_tier":"flex"}'), "flex");
  assert.equal(tierFromTags('{"service_tier":"default"}'), "standard");
  assert.equal(tierFromTags('{"service_tier":null}'), null);
  assert.equal(tierFromTags('service_tier: Some("fast")'), null, "only the tags form is read");
  assert.equal(tierFromTags(undefined), null);
});

test("a turn takes the entry logged before the next turn started, not the next turn's", () => {
  const entries = [{ at: 1000, tier: "standard" }, { at: 3000, tier: "fast" }];
  assert.equal(tierAt(entries, { endMs: 2500, nextStartMs: 3000 }), "standard", "the next turn's entry at its start is excluded");
  assert.equal(tierAt(entries, { endMs: 3100, nextStartMs: null }), "fast");
  assert.equal(tierAt(entries, { endMs: 500, nextStartMs: 900 }), null, "nothing logged yet");
  assert.equal(tierAt(entries, {}), null);
});

test("Codex turns the hook never saw take their tier from Codex's log", needsSqlite, (t) => {
  const dir = temp(t), file = path.join(dir, "r.jsonl");
  rollout(file, dir, "gpt-6-astra", [1000, 2000]);
  const log = tierLog(t, [["2026-09-28T00:00:00Z", "default"], ["2026-09-28T00:00:01Z", "priority"]],
    [["2026-09-28T00:00:01Z", "flex", "other-thread"], ["2026-09-28T00:00:01Z", "flex", "s", "codex_core::session::handlers"]]);
  const [first, second] = codex.buildTurns(file, { tierLogFile: log });
  assert.equal(first.serviceTier, "standard");
  assert.equal(second.serviceTier, "fast", "priority is fast; other threads and other targets are ignored");
  near(second.cost.total, cp.costOf("gpt-6-astra", { input: 2000, output: 10 }, { serviceTier: "fast" }).total);
});

test("the hook's reading and a stored tier outrank the log", needsSqlite, (t) => {
  const dir = temp(t), file = path.join(dir, "r.jsonl");
  rollout(file, dir, "gpt-6-astra", [1000, 2000]);
  const log = tierLog(t, [["2026-09-28T00:00:00Z", "priority"], ["2026-09-28T00:00:01Z", "priority"]]);
  const turns = codex.buildTurns(file, { tierLogFile: log, hookPricing: { serviceTier: "standard" },
    pricingForTurn: (row) => (row.id === "s:0" ? { serviceTier: "flex" } : {}) });
  assert.deepEqual(turns.map((r) => [r.id, r.serviceTier]), [["s:0", "flex"], ["s:1", "standard"]]);
});

test("a missing, empty or foreign log database gives no tier and never throws", needsSqlite, (t) => {
  const dir = temp(t), file = path.join(dir, "r.jsonl");
  rollout(file, dir, "gpt-6-astra", [1000]);
  assert.equal(codex.buildTurns(file, { tierLogFile: path.join(dir, "absent.sqlite") })[0].serviceTier, null);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const foreign = path.join(dir, "foreign.sqlite");
  new DatabaseSync(foreign).close();
  closeTierLog();
  assert.deepEqual(threadTiers("s", { file: foreign }), []);
  fs.writeFileSync(path.join(dir, "junk.sqlite"), "not a database");
  closeTierLog();
  assert.deepEqual(threadTiers("s", { file: path.join(dir, "junk.sqlite") }), []);
  closeTierLog();
});

test("a tier read from the log is kept after Codex prunes it", needsSqlite, async (t) => {
  const dir = temp(t), file = path.join(dir, "r.jsonl");
  rollout(file, dir, "gpt-6-astra", [1000]);
  const log = tierLog(t, [["2026-09-28T00:00:00Z", "priority"]]);
  process.env.CODEX_HOME = path.dirname(log);
  await ingestTranscript(codex, { transcriptPath: file });
  assert.equal(rows(store(dir))[0].serviceTier, "fast");
  closeTierLog();
  fs.rmSync(log);
  await ingestTranscript(codex, { transcriptPath: file });
  assert.equal(rows(store(dir))[0].serviceTier, "fast");
});

const REQ = "req_011CZabcdefghijklmnopqrstu";
function claudeWithRequest(file, cwd, requestId, sid = "s") {
  jsonl(file, [
    { type: "user", uuid: "u0", sessionId: sid, cwd, timestamp: "2026-09-28T00:00:00Z", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a0", sessionId: sid, cwd, ...(requestId ? { requestId } : {}),
      message: { id: "msg_01ABCDEFGHIJKLMNOPQRSTUV", role: "assistant", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } },
  ]);
}

test("an Anthropic request id proves the API was used, over a local hook reading or settings", (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  claudeWithRequest(file, dir, REQ);
  settings(dir, "http://localhost:11434");
  const [row] = claude.buildTurns(file, { hookPricing: { endpoint: "local" } });
  assert.equal(row.endpoint, "anthropic");
  assert.ok(row.cost.total > 0);
  assert.equal(row.cost.rateSource, undefined);
  for (const id of [null, "req_short", "request-123", "req_" + "a".repeat(10)]) {
    claudeWithRequest(file, dir, id);
    assert.equal(claude.buildTurns(file, { hookPricing: { endpoint: "local" } })[0].endpoint, "local", `no proof: ${id}`);
  }
});

test("a subagent run's request id is proof for its turn", (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl"), sub = path.join(dir, "s", "subagents");
  jsonl(file, [
    { type: "user", uuid: "u0", sessionId: "s", cwd: dir, timestamp: "2026-09-28T00:00:00Z", message: { role: "user", content: "hi" } },
    { type: "assistant", uuid: "a0", sessionId: "s", cwd: dir, timestamp: "2026-09-28T00:00:01Z",
      message: { id: "m0", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: {} }],
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ]);
  write(path.join(sub, "agent-a1.jsonl"), [
    { type: "user", agentId: "a1", isSidechain: true, timestamp: "2026-09-28T00:00:02Z", message: { content: "go" } },
    { type: "assistant", agentId: "a1", requestId: REQ, timestamp: "2026-09-28T00:00:03Z",
      message: { id: "s1", role: "assistant", model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 500, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ].map(JSON.stringify).join("\n"));
  write(path.join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "toolu_1", spawnDepth: 1 }));
  const [row] = claude.buildTurns(file, { hookPricing: { endpoint: "local" } });
  assert.equal(row.subagents.length, 1, "the run is attached");
  assert.equal(row.endpoint, "anthropic");
  assert.ok(row.subagents[0].cost.total > 0);
});

test("a turn stored as local and free takes its real price once proof arrives", async (t) => {
  const dir = temp(t), file = path.join(dir, "s.jsonl");
  claudeWithRequest(file, dir, null);
  await ingest(claude, hook(file, dir), { endpoint: "local" });
  assert.equal(rows(store(dir))[0].cost.total, 0);
  claudeWithRequest(file, dir, REQ);
  await ingestTranscript(claude, { transcriptPath: file });
  const [row] = rows(store(dir));
  assert.equal(row.endpoint, "anthropic");
  near(row.cost.total, ap.costOf("claude-sonnet-4-6", { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }).total);
});

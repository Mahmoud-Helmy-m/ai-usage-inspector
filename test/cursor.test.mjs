import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyRemoteRates as applyCursorRates } from "../src/providers/cursor/pricing.mjs";

// Cursor is read out of real SQLite, so these need node:sqlite (Node >= 22.5) —
// the same gate the provider itself degrades on.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}
const needsSqlite = { skip: DatabaseSync ? false : "node:sqlite unavailable (Node < 22.5)" };

const ENV_KEYS = ["APPDATA", "HOME", "USERPROFILE"];

/**
 * Point Cursor's data dir at a temp tree and populate it the way Cursor does:
 *   User/globalStorage/state.vscdb          cursorDiskKV(key,value)
 *   User/workspaceStorage/<hash>/state.vscdb ItemTable(key,value)
 *   User/workspaceStorage/<hash>/workspace.json
 */
async function fixture(t, { composers = {}, workspaceValue, globalRows } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-cursor-"));
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = root;
  t.after(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const store = await import("../src/providers/cursor/store.mjs");
  const base = store.cursorDataDir();
  const wsDir = path.join(base, "User", "workspaceStorage", "hash1");
  fs.mkdirSync(path.join(base, "User", "globalStorage"), { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "workspace.json"), JSON.stringify({ folder: "file:///k%3A/proj" }));

  const wdb = new DatabaseSync(path.join(wsDir, "state.vscdb"));
  wdb.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  wdb.prepare("INSERT INTO ItemTable VALUES (?,?)").run(
    "composer.composerData",
    workspaceValue !== undefined ? workspaceValue : JSON.stringify({ allComposers: Object.keys(composers).map((id) => ({ composerId: id })) }),
  );
  wdb.close();

  const gdb = new DatabaseSync(store.globalDbPath());
  gdb.exec(globalRows === null ? "CREATE TABLE wrong_table (a TEXT)" : "CREATE TABLE cursorDiskKV (key TEXT, value TEXT)");
  if (globalRows !== null) {
    const put = gdb.prepare("INSERT INTO cursorDiskKV VALUES (?,?)");
    for (const [id, c] of Object.entries(composers)) {
      put.run(`composerData:${id}`, JSON.stringify(c.meta));
      for (const b of c.bubbles) put.run(`bubbleId:${id}:${b.bubbleId}`, JSON.stringify(b));
    }
  }
  gdb.close();
  return { root, base };
}

const provider = () => import("../src/providers/cursor/index.mjs");

const composer = (bubbles, meta = {}) => ({
  meta: { createdAt: 1_700_000_000_000, lastUpdatedAt: 1_700_000_060_000, ...meta },
  bubbles,
});

test("Cursor composer names stamp every turn and missing or invalid names are null", needsSqlite, async (t) => {
  const names = ["Synthetic composer", "", "  ", null, 42, undefined];
  const bubbles = [
    { bubbleId: "u1", type: 1, text: "first" },
    { bubbleId: "a1", type: 2, text: "answer", tokenUsage: { inputTokens: 100, outputTokens: 10 } },
    { bubbleId: "u2", type: 1, text: "second" },
    { bubbleId: "a2", type: 2, text: "answer", tokenUsage: { inputTokens: 200, outputTokens: 20 } },
  ];
  await fixture(t, { composers: Object.fromEntries(names.map((name, i) => [`name-${i}`, composer(bubbles, { name })])) });
  const p = await provider();
  for (const [i, name] of names.entries()) {
    const turns = await p.buildTurns({ composerId: `name-${i}` });
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.equal(turn.sessionName, typeof name === "string" && name.trim() ? name : null);
      assert.equal(turn.sessionTitle, null);
    }
  }
});

test("exact per-bubble token usage is used and not marked estimated", needsSqlite, async (t) => {
  await fixture(t, {
    composers: {
      c1: composer([
        { bubbleId: "b1", type: 1, text: "the prompt" },
        {
          bubbleId: "b2",
          type: 2,
          text: "the answer",
          modelType: "claude-4-sonnet",
          tokenUsage: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 40 },
        },
      ]),
    },
  });

  const p = await provider();
  const found = await p.discoverTranscripts({ sinceMs: 0 });
  assert.equal(found.length, 1);
  assert.equal(found[0].transcriptPath.cwd, "k:/proj", "workspace folder URI decoded");

  const turns = await p.buildTurns(found[0].transcriptPath, found[0].opts);
  assert.equal(turns.length, 1);
  const turn = turns[0];
  assert.equal(turn.provider, "cursor");
  assert.equal(turn.prompt, "the prompt");
  assert.equal(turn.response, "the answer");
  assert.equal(turn.model, "claude-4-sonnet");
  assert.equal(turn.usage.input, 900);
  assert.equal(turn.usage.output, 120);
  assert.equal(turn.usage.cacheRead, 40);
  // Cursor publishes no cache-read rate, so the machine cache (if any) supplies a
  // guessed one and the cost is honestly an estimate. Pin a known rate first so
  // this asserts the token behaviour it is named for, not the ambient cache.
  applyCursorRates({ "claude-4-sonnet": { input: 3, cachedInput: 0.3, output: 15, cachedGuessed: false } });
  const priced = (await p.buildTurns(found[0].transcriptPath, found[0].opts))[0];
  assert.equal(priced.cost.source, "priced");
  assert.equal(priced.cost.estimated, undefined, "real counts must not be flagged estimated");

  // And with the rate itself a guess, the same exact tokens yield an estimate —
  // the tokens are still exact, so the reason has to be recorded separately.
  applyCursorRates({ "claude-4-sonnet": { input: 3, cachedInput: 0.3, output: 15, cachedGuessed: true } });
  const guessed = (await p.buildTurns(found[0].transcriptPath, found[0].opts))[0];
  assert.equal(guessed.usage.input, 900, "tokens are still the exact ones");
  assert.equal(guessed.cost.source, "estimated");
  assert.equal(guessed.cost.estimatedRate, true, "and it says the RATE was the guess");
});

test("missing token usage falls back to a flagged estimate", needsSqlite, async (t) => {
  const prompt = "x".repeat(400);
  await fixture(t, {
    composers: {
      c1: composer([
        { bubbleId: "b1", type: 1, text: prompt },
        { bubbleId: "b2", type: 2, text: "y".repeat(80) }, // no tokenUsage at all
      ]),
    },
  });

  const p = await provider();
  const found = await p.discoverTranscripts({ sinceMs: 0 });
  const turn = (await p.buildTurns(found[0].transcriptPath, found[0].opts))[0];
  assert.equal(turn.usage.input, 100, "~4 chars per token");
  assert.equal(turn.usage.output, 20);
  assert.equal(turn.cost.source, "estimated");
  assert.equal(turn.cost.estimated, true);
});

test("bubbles follow fullConversationHeadersOnly, not insertion order", needsSqlite, async (t) => {
  await fixture(t, {
    composers: {
      c1: composer(
        [
          // inserted out of order on purpose
          { bubbleId: "b3", type: 2, text: "second answer", tokenUsage: { inputTokens: 1, outputTokens: 1 } },
          { bubbleId: "b1", type: 1, text: "first" },
          { bubbleId: "b2", type: 2, text: "first answer", tokenUsage: { inputTokens: 1, outputTokens: 1 } },
          { bubbleId: "b0", type: 1, text: "second" },
        ],
        { fullConversationHeadersOnly: [{ bubbleId: "b1" }, { bubbleId: "b2" }, { bubbleId: "b0" }, { bubbleId: "b3" }] },
      ),
    },
  });

  const p = await provider();
  const found = await p.discoverTranscripts({ sinceMs: 0 });
  const turns = await p.buildTurns(found[0].transcriptPath, found[0].opts);
  assert.deepEqual(turns.map((x) => [x.prompt, x.response]), [
    ["first", "first answer"],
    ["second", "second answer"],
  ]);
});

test("sinceMs filters on the composer's lastUpdatedAt", needsSqlite, async (t) => {
  await fixture(t, {
    composers: {
      old: composer([{ bubbleId: "b1", type: 1, text: "old" }], { lastUpdatedAt: 1_000 }),
      fresh: composer([{ bubbleId: "b1", type: 1, text: "fresh" }], { lastUpdatedAt: 9_000_000_000_000 }),
    },
  });

  const p = await provider();
  assert.equal((await p.discoverTranscripts({ sinceMs: 0 })).length, 2);
  const recent = await p.discoverTranscripts({ sinceMs: 8_000_000_000_000 });
  assert.deepEqual(recent.map((x) => x.transcriptPath.composerId), ["fresh"]);
});

test("an unsupported global schema is reported, not silently empty", needsSqlite, async (t) => {
  await fixture(t, { composers: {}, globalRows: null }); // global DB lacks cursorDiskKV
  const p = await provider();
  const result = await p.discoverTranscriptsStatus({ sinceMs: 0 });
  assert.equal(result.status, "unsupported-schema");
  assert.match(result.detail, /cursorDiskKV/);
  assert.deepEqual(result.transcripts, []);
});

test("a workspace with unreadable composer JSON yields no transcripts but no throw", needsSqlite, async (t) => {
  await fixture(t, { composers: {}, workspaceValue: "not json at all" });
  const p = await provider();
  const result = await p.discoverTranscriptsStatus({ sinceMs: 0 });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.transcripts, []);
});


test("zai: Cursor preserves its rates with exact counts and adds vendor windows", needsSqlite, async (t) => {
  const ids = ["GLM-5.3-Flash", "glm-5.2", "glm-unknown"];
  const { costOf } = await import("../src/providers/cursor/pricing.mjs");
  await fixture(t, { composers: Object.fromEntries(ids.map((model, i) => [`glm-${i}`, composer([
    { bubbleId: "u", type: 1, text: "synthetic" },
    { bubbleId: "a", type: 2, text: "done", modelType: model, tokenUsage: { inputTokens: 10000, outputTokens: 100, cacheReadTokens: 100 } },
  ])])) });
  const p = await provider();
  for (const [i, model] of ids.entries()) {
    const [row] = await p.buildTurns({ composerId: `glm-${i}` });
    assert.equal(row.vendor, "z.ai");
    assert.equal(row.provider, "cursor");
    assert.equal(row.cost.total, costOf(model, { input: 10000, cached: 100, output: 100 }).total);
    assert.equal(row.contextMax, i === 0 ? 1000000 : null);
    assert.equal(row.contextFillPct, i === 0 ? 1 : null);
  }
  applyCursorRates({ "glm-5.3-flash": { input: 9, cachedInput: 2, output: 10 } });
  const [priced] = await p.buildTurns({ composerId: "glm-0" });
  assert.equal(priced.cost.total, .0912);
  assert.equal(priced.cost.source, "priced");
  assert.equal(priced.contextMax, 1000000, "a Cursor price override is not a known window");
});

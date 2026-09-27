import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

// The OpenCode provider reads SQLite via node:sqlite (Node >= 22.5). Skip the
// whole file on older Node so the suite stays green there, exactly as the
// provider degrades at runtime.
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}
const needsSqlite = { skip: DatabaseSync ? false : "node:sqlite unavailable (Node < 22.5)" };

// Build a throwaway <dir>/opencode/opencode.db and point XDG_DATA_HOME at <dir>
// so the provider resolves it. Returns the temp dir (caller restores env).
function makeDb(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-opencode-"));
  const dbDir = path.join(dir, "opencode");
  fs.mkdirSync(dbDir, { recursive: true });
  const db = new DatabaseSync(path.join(dbDir, "opencode.db"));
  db.exec(`
    CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, agent TEXT, model TEXT, title TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE session_input (session_id TEXT, prompt TEXT, time_created INTEGER);
  `);
  for (const s of rows.sessions || []) db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    s.id, s.parent_id ?? null, s.directory, s.agent ?? null, s.model, s.title, s.cost, s.tokens_input, s.tokens_output,
    s.tokens_reasoning, s.tokens_cache_read, s.tokens_cache_write, s.time_created, s.time_updated);
  for (const m of rows.messages || []) db.prepare("INSERT INTO message VALUES (?,?,?,?)").run(m.id, m.session_id, m.time_created, JSON.stringify(m.data));
  for (const p of rows.parts || []) db.prepare("INSERT INTO part VALUES (?,?,?,?)").run(p.message_id, p.session_id, p.time_created, JSON.stringify(p.data));
  db.close();
  return dir;
}

// Import the provider fresh with XDG_DATA_HOME pointed at `dir`.
async function withDataDir(dir, fn) {
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = dir;
  try {
    const mod = await import(`../src/providers/opencode/index.mjs?t=${Date.now()}${Math.random()}`);
    return await fn(mod);
  } finally {
    if (prev === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prev;
  }
}

const asst = (m, cost, tok) => ({ role: "assistant", modelID: m, cost, tokens: tok });
const asstP = (m, cost, tok, provider) => ({ role: "assistant", providerID: provider, modelID: m, cost, tokens: tok });
const textPart = (mid, sid, ts, t) => ({ message_id: mid, session_id: sid, time_created: ts, data: { type: "text", text: t } });
const stepFinish = (mid, sid, ts, input, cacheRead) => ({ message_id: mid, session_id: sid, time_created: ts, data: { type: "step-finish", tokens: { input, output: 1, reasoning: 0, cache: { read: cacheRead, write: 0 } } } });
const taskPart = (mid, sid, ts, metadata, tool = "task") => ({ message_id: mid, session_id: sid, time_created: ts, data: { type: "tool", tool, ...(metadata === undefined ? {} : { state: { metadata } }) } });

// Point XDG_CACHE_HOME at a throwaway opencode/models.json for a provider import.
function cacheDir(models) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-opencode-cache-"));
  const opencodeDir = path.join(dir, "opencode");
  fs.mkdirSync(opencodeDir, { recursive: true });
  fs.writeFileSync(path.join(opencodeDir, "models.json"), JSON.stringify(models));
  return dir;
}

// Import the provider fresh with XDG_DATA_HOME and (optionally) XDG_CACHE_HOME
// pointed at temp dirs.
async function withEnv({ data, cache }, fn) {
  const prevData = process.env.XDG_DATA_HOME;
  const prevCache = process.env.XDG_CACHE_HOME;
  if (data == null) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = data;
  if (cache == null) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = cache;
  try {
    const mod = await import(`../src/providers/opencode/index.mjs?t=${Date.now()}${Math.random()}`);
    return await fn(mod);
  } finally {
    if (prevData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevData;
    if (prevCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = prevCache;
  }
}

test("OpenCode titles name every turn and session rollup, with blank titles null", needsSqlite, async () => {
  const titles = ["Synthetic session", "", "  ", null];
  const sessions = titles.flatMap((title, i) => [true, false].map((perTurn) => ({
    id: `name-${i}-${perTurn}`, directory: "K:/synthetic", model: "gpt-5", title, cost: 0.03,
    tokens_input: 30, tokens_output: 3, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
    time_created: 1_700_000_000_000, time_updated: 1_700_000_001_000,
  })));
  const messages = sessions.filter((s) => s.id.endsWith("true")).flatMap((s) => [1, 2].flatMap((n) => [
    { id: `${s.id}-u${n}`, session_id: s.id, time_created: s.time_created + n * 10, data: { role: "user" } },
    { id: `${s.id}-a${n}`, session_id: s.id, time_created: s.time_created + n * 10 + 1, data: asst("gpt-5", 0.01, { input: 10, output: 1 }) },
  ]));
  const dir = makeDb({ sessions, messages });
  try {
    await withDataDir(dir, async (m) => {
      for (const session of sessions) {
        const turns = await m.buildTurns({ sessionId: session.id });
        assert.equal(turns.length, session.id.endsWith("true") ? 2 : 1);
        for (const turn of turns) {
          assert.equal(turn.sessionName, session.title?.trim() ? session.title : null);
          assert.equal(turn.sessionTitle, null);
        }
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode parses per-message turns with exact tokens and cost", needsSqlite, async () => {
  const t0 = Date.parse("2026-07-23T10:00:00Z");
  const dir = makeDb({
    sessions: [{ id: "sesA", directory: "K:/repo", model: '{"id":"claude-x"}', title: "A", cost: 0.05,
      tokens_input: 2000, tokens_output: 400, tokens_reasoning: 100, tokens_cache_read: 600, tokens_cache_write: 40,
      time_created: t0, time_updated: t0 + 60000 }],
    messages: [
      { id: "u1", session_id: "sesA", time_created: t0 + 1000, data: { role: "user" } },
      { id: "a1", session_id: "sesA", time_created: t0 + 2000, data: asst("claude-sonnet-4", 0.02, { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 20 } }) },
      { id: "u2", session_id: "sesA", time_created: t0 + 40000, data: { role: "user" } },
      { id: "a2", session_id: "sesA", time_created: t0 + 41000, data: asst("claude-sonnet-4", 0.03, { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 20 } }) },
    ],
    parts: [
      textPart("u1", "sesA", t0 + 1000, "first prompt"),
      textPart("a1", "sesA", t0 + 2000, "first answer"),
      { message_id: "a1", session_id: "sesA", time_created: t0 + 2500, data: { type: "tool", tool: "read" } },
      textPart("u2", "sesA", t0 + 40000, "second prompt"),
      textPart("a2", "sesA", t0 + 41000, "second answer"),
    ],
  });
  try {
    await withDataDir(dir, async (m) => {
      assert.equal(m.detect(), true);
      const disc = await m.discoverTranscripts({ sinceMs: 0 });
      assert.equal(disc.length, 1);
      const turns = await m.buildTurns(disc[0].transcriptPath, disc[0].opts);
      assert.equal(turns.length, 2);
      assert.deepEqual(turns.map((t) => [t.prompt, t.response, t.model]), [
        ["first prompt", "first answer", "claude-sonnet-4"],
        ["second prompt", "second answer", "claude-sonnet-4"],
      ]);
      assert.equal(turns[0].provider, "opencode");
      assert.equal(turns[0].cwd, "K:/repo");
      assert.equal(turns[0].cost.total, 0.02);
      assert.equal(turns[0].counts.toolCalls, 1);
      assert.deepEqual(turns[0].usage, { input: 1000, output: 200, reasoning: 50, cacheCreate: 20, cacheRead: 300, cacheCreate1h: 0, cacheCreate5m: 0, webSearch: 0, webFetch: 0 });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode falls back to a session-level record when messages lack usage", needsSqlite, async () => {
  const t0 = Date.parse("2026-07-23T09:00:00Z");
  const dir = makeDb({
    // model stored as a JSON string (as OpenCode really does) -> must be cleaned to the id
    sessions: [{ id: "sesB", directory: "K:/legacy", model: '{"id":"gemini-3-pro","providerID":"opencode"}', title: "Legacy chat", cost: 0.12,
      tokens_input: 5000, tokens_output: 800, tokens_reasoning: 0, tokens_cache_read: 1200, tokens_cache_write: 0,
      time_created: t0, time_updated: t0 + 50000 }],
    // no messages / parts at all
  });
  try {
    await withDataDir(dir, async (m) => {
      const disc = await m.discoverTranscripts({ sinceMs: 0 });
      const turns = await m.buildTurns(disc[0].transcriptPath, disc[0].opts);
      assert.equal(turns.length, 1);
      const r = turns[0];
      assert.equal(r.id, "sesB:0");
      assert.equal(r.model, "gemini-3-pro");
      assert.equal(r.prompt, "Legacy chat");
      assert.equal(r.cost.total, 0.12);
      assert.equal(r.usage.input, 5000);
      assert.equal(r.usage.cacheRead, 1200);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode uses rowid tiebreaks and cleans per-message object models", needsSqlite, async () => {
  const t0 = Date.parse("2026-07-23T11:00:00Z");
  const dir = makeDb({
    sessions: [{ id: "sesOrder", directory: "K:/order", model: "fallback", title: "Order", cost: 0.03,
      tokens_input: 30, tokens_output: 3, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
      time_created: t0, time_updated: t0 + 1 }],
    messages: [
      { id: "u1", session_id: "sesOrder", time_created: t0, data: { role: "user" } },
      { id: "a1", session_id: "sesOrder", time_created: t0, data: asst({ id: "object-model" }, 0.01, { input: 10, output: 1 }) },
      { id: "u2", session_id: "sesOrder", time_created: t0, data: { role: "user" } },
      { id: "a2", session_id: "sesOrder", time_created: t0, data: asst("string-model", 0.02, { input: 20, output: 2 }) },
    ],
    parts: [
      textPart("u1", "sesOrder", t0, "first"),
      textPart("a1", "sesOrder", t0, "answer one"),
      textPart("u2", "sesOrder", t0, "second"),
      textPart("a2", "sesOrder", t0, "answer two"),
    ],
  });
  try {
    await withDataDir(dir, async (m) => {
      const turns = await m.buildTurns({ sessionId: "sesOrder", cwd: "K:/order" });
      assert.deepEqual(turns.map((t) => [t.prompt, t.response, t.model]), [
        ["first", "answer one", "object-model"],
        ["second", "answer two", "string-model"],
      ]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode incomplete message usage emits identifiable session rollup", needsSqlite, async () => {
  const t0 = Date.parse("2026-07-23T12:00:00Z");
  const dir = makeDb({
    sessions: [{ id: "sesPartial", directory: "K:/partial", model: "provider-model", title: "Partial", cost: 0.00004,
      tokens_input: 300, tokens_output: 30, tokens_reasoning: 3, tokens_cache_read: 20, tokens_cache_write: 2,
      time_created: t0, time_updated: t0 + 1000 }],
    messages: [
      { id: "u1", session_id: "sesPartial", time_created: t0, data: { role: "user" } },
      { id: "a1", session_id: "sesPartial", time_created: t0 + 1, data: asst("provider-model", 0.01, { input: 100, output: 10 }) },
      { id: "u2", session_id: "sesPartial", time_created: t0 + 2, data: { role: "user" } },
      { id: "a2", session_id: "sesPartial", time_created: t0 + 3, data: { role: "assistant", modelID: "provider-model", cost: 0.02 } },
    ],
    parts: [textPart("u1", "sesPartial", t0, "first"), textPart("u2", "sesPartial", t0 + 2, "second")],
  });
  try {
    await withDataDir(dir, async (m) => {
      const turns = await m.buildTurns({ sessionId: "sesPartial", cwd: "K:/partial" });
      assert.equal(turns.length, 1);
      assert.equal(turns[0].quality, "session-rollup");
      assert.equal(turns[0].usage.input, 300);
      assert.equal(turns[0].cost.total, 0.00004);
      assert.equal(turns[0].cost.source, "provider");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode plugin install/uninstall is idempotent and marker-scoped", needsSqlite, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-opencode-home-"));
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const m = await import(`../src/providers/opencode/index.mjs?t=${Date.now()}h`);
    const pluginFile = path.join(home, ".config", "opencode", "plugins", "ai-usage-inspector.js");

    const r1 = m.install({ appPath: path.join(home, "app") });
    assert.equal(r1.action, "added");
    assert.equal(fs.existsSync(pluginFile), true);
    const body = fs.readFileSync(pluginFile, "utf8");
    assert.match(body, /session\.idle/);
    assert.match(body, /--provider/);
    assert.match(body, /ai-usage-inspector/);

    assert.equal(m.install({ appPath: path.join(home, "app") }).action, "exists");

    const u = m.uninstall();
    assert.equal(u.removed, 1);
    assert.equal(fs.existsSync(pluginFile), false);
    assert.equal(m.uninstall().removed, 0);
  } finally {
    if (prevUser === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("OpenCode context is the largest single request, not the summed turn", needsSqlite, async () => {
  const t0 = Date.parse("2026-08-20T10:00:00Z");
  const dir = makeDb({
    sessions: [{ id: "sesCtx", directory: "K:/ctx", model: "big-pickle", title: "Ctx", cost: 0.03,
      tokens_input: 180, tokens_output: 15, tokens_reasoning: 0, tokens_cache_read: 60, tokens_cache_write: 5,
      time_created: t0, time_updated: t0 + 1000 }],
    messages: [
      { id: "u1", session_id: "sesCtx", time_created: t0, data: { role: "user" } },
      { id: "a1", session_id: "sesCtx", time_created: t0 + 1, data: asstP("big-pickle", 0.01, { input: 100, output: 10, cache: { read: 40, write: 5 } }, "opencode") },
      { id: "a2", session_id: "sesCtx", time_created: t0 + 2, data: asstP("big-pickle", 0.02, { input: 80, output: 5, cache: { read: 20, write: 0 } }, "opencode") },
    ],
    parts: [
      textPart("u1", "sesCtx", t0, "grow the context"),
      stepFinish("a1", "sesCtx", t0 + 1, 50, 20),
      stepFinish("a1", "sesCtx", t0 + 1, 50, 20),
      stepFinish("a2", "sesCtx", t0 + 2, 80, 20),
    ],
  });
  const models = { opencode: { models: { "big-pickle": { limit: { context: 200000, output: 65536 } } } } };
  try {
    await withEnv({ data: dir, cache: cacheDir(models) }, async (m) => {
      const turns = await m.buildTurns({ sessionId: "sesCtx", cwd: "K:/ctx" });
      assert.equal(turns.length, 1);
      assert.equal(turns[0].usage.input, 180, "usage is still the turn total");
      assert.equal(turns[0].usage.cacheRead, 60);
      assert.equal(turns[0].contextTokens, 100, "context is the largest request, not the 240-strong sum");
      assert.equal(turns[0].contextMax, 200000);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode context window comes from models.json by provider and model", needsSqlite, async () => {
  const t0 = Date.parse("2026-08-20T11:00:00Z");
  const dir = makeDb({
    sessions: [{ id: "sesWin", directory: "K:/win", model: "union-alpha", title: "Win", cost: 0.01,
      tokens_input: 500, tokens_output: 10, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
      time_created: t0, time_updated: t0 + 10 }],
    messages: [
      { id: "u1", session_id: "sesWin", time_created: t0, data: { role: "user" } },
      { id: "a1", session_id: "sesWin", time_created: t0 + 1, data: asstP("union-alpha", 0.01, { input: 500, output: 10 }, "opencode") },
    ],
    parts: [textPart("u1", "sesWin", t0, "hello"), textPart("a1", "sesWin", t0 + 1, "hi")],
  });
  const models = { opencode: { models: { "union-alpha": { limit: { context: 262144, output: 131072 } } } } };
  try {
    await withEnv({ data: dir, cache: cacheDir(models) }, async (m) => {
      const turns = await m.buildTurns({ sessionId: "sesWin", cwd: "K:/win" });
      assert.equal(turns[0].contextMax, 262144, "window lookup uses providerID + modelID in models.json");
      assert.equal(turns[0].contextTokens, 500);
      assert.equal(turns[0].contextFillPct, 0.2);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode stores null window and null fill for a model it cannot size", needsSqlite, async () => {
  const t0 = Date.parse("2026-08-20T12:00:00Z");
  const dir = makeDb({
    sessions: [{ id: "sesNoWin", directory: "K:/nowin", model: "quantum-fusion-7", title: "NoWin", cost: 0.01,
      tokens_input: 300, tokens_output: 5, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
      time_created: t0, time_updated: t0 + 10 }],
    messages: [
      { id: "u1", session_id: "sesNoWin", time_created: t0, data: { role: "user" } },
      { id: "a1", session_id: "sesNoWin", time_created: t0 + 1, data: asstP("quantum-fusion-7", 0.01, { input: 300, output: 5 }, "acme") },
    ],
    parts: [textPart("u1", "sesNoWin", t0, "hello"), textPart("a1", "sesNoWin", t0 + 1, "hi")],
  });
  const models = { acme: { models: { "other-model": { limit: { context: 999 } } } } };
  try {
    await withEnv({ data: dir, cache: cacheDir(models) }, async (m) => {
      const turns = await m.buildTurns({ sessionId: "sesNoWin", cwd: "K:/nowin" });
      assert.equal(turns[0].contextTokens, 300);
      assert.equal(turns[0].contextMax, null, "unknown window is null, never a 0 that charts as a real 0%");
      assert.equal(turns[0].contextFillPct, null);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode links child sessions to their parent and names them in the parent turn", needsSqlite, async () => {
  const t0 = Date.parse("2026-08-20T13:00:00Z");
  const dir = makeDb({
    sessions: [
      { id: "parent", directory: "K:/p", model: "big-pickle", title: "Parent", cost: 0.01,
        tokens_input: 10, tokens_output: 2, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        time_created: t0, time_updated: t0 + 100 },
      { id: "child", parent_id: "parent", directory: "K:/p", agent: "reviewer", model: "big-pickle",
        title: "Child session - 2026-08-20T13:00:00.000Z", cost: 0.02,
        tokens_input: 5, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        time_created: t0, time_updated: t0 + 100 },
    ],
    messages: [
      { id: "pu1", session_id: "parent", time_created: t0, data: { role: "user" } },
      { id: "pa1", session_id: "parent", time_created: t0 + 1, data: asstP("big-pickle", 0.01, { input: 10, output: 2 }, "opencode") },
      { id: "cu1", session_id: "child", time_created: t0, data: { role: "user" } },
      { id: "ca1", session_id: "child", time_created: t0 + 1, data: asstP("big-pickle", 0.02, { input: 5, output: 1 }, "opencode") },
    ],
    parts: [
      textPart("pu1", "parent", t0, "delegate it"),
      textPart("pa1", "parent", t0 + 1, "done"),
      taskPart("pa1", "parent", t0 + 1, "child"),
      taskPart("pa1", "parent", t0 + 2),
      { message_id: "pa1", session_id: "parent", time_created: t0 + 3, data: { type: "tool", tool: "read" } },
      textPart("cu1", "child", t0, "review this"),
      textPart("ca1", "child", t0 + 1, "looks fine"),
    ],
  });
  try {
    await withEnv({ data: dir, cache: null }, async (m) => {
      const parentTurns = await m.buildTurns({ sessionId: "parent", cwd: "K:/p" });
      assert.equal(parentTurns.length, 1);
      assert.equal(parentTurns[0].parentSessionId, undefined, "the parent is not a child of anything");
      assert.equal(parentTurns[0].counts.subagentCalls, 2, "both task calls count, metadata or not");
      assert.equal(parentTurns[0].counts.toolCalls, 3);
      assert.deepEqual(parentTurns[0].spawnedAgents, ["child"]);

      const childTurns = await m.buildTurns({ sessionId: "child", cwd: "K:/p" });
      assert.equal(childTurns.length, 1);
      assert.equal(childTurns[0].sessionId, "child");
      assert.equal(childTurns[0].parentSessionId, "parent");
      assert.deepEqual(childTurns[0].agent, { kind: "subagent", nickname: "reviewer", path: null, depth: 1 });
      assert.equal(childTurns[0].sessionName, null, "the 'Child session -' placeholder is not a name");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode nested children carry their full parent-chain depth", needsSqlite, async () => {
  const t0 = Date.parse("2026-08-20T14:00:00Z");
  const dir = makeDb({
    sessions: [
      { id: "root", directory: "K:/p", model: "big-pickle", title: "Root", cost: 0.01,
        tokens_input: 1, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        time_created: t0, time_updated: t0 + 1 },
      { id: "mid", parent_id: "root", directory: "K:/p", agent: "one", model: "big-pickle", title: "Mid", cost: 0.01,
        tokens_input: 1, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        time_created: t0, time_updated: t0 + 1 },
      { id: "leaf", parent_id: "mid", directory: "K:/p", agent: "two", model: "big-pickle", title: "Leaf", cost: 0.01,
        tokens_input: 1, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
        time_created: t0, time_updated: t0 + 1 },
    ],
    messages: Array.from(new Set(["root", "mid", "leaf"])).flatMap((sid) => [
      { id: `${sid}-u`, session_id: sid, time_created: t0, data: { role: "user" } },
      { id: `${sid}-a`, session_id: sid, time_created: t0 + 1, data: asstP("big-pickle", 0.01, { input: 1, output: 1 }, "opencode") },
    ]),
    parts: ["root", "mid", "leaf"].flatMap((sid) => [textPart(`${sid}-u`, sid, t0, sid), textPart(`${sid}-a`, sid, t0 + 1, sid)]),
  });
  try {
    await withEnv({ data: dir, cache: null }, async (m) => {
      const root = (await m.buildTurns({ sessionId: "root" }))[0];
      const mid = (await m.buildTurns({ sessionId: "mid" }))[0];
      const leaf = (await m.buildTurns({ sessionId: "leaf" }))[0];
      assert.equal(root.parentSessionId, undefined);
      assert.equal(mid.agent.depth, 1, "child of a root session sits one below");
      assert.equal(leaf.agent.depth, 2, "a child of a child sits two below");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode rollup keeps messages' counts and the first user prompt", needsSqlite, async () => {
  const t0 = Date.parse("2026-08-20T15:00:00Z");
  const dir = makeDb({
    sessions: [{ id: "sesRoll", directory: "K:/roll", model: "big-pickle", title: "Roll", cost: 0.00004,
      tokens_input: 999, tokens_output: 30, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
      time_created: t0, time_updated: t0 + 1000 }],
    messages: [
      { id: "u1", session_id: "sesRoll", time_created: t0, data: { role: "user" } },
      { id: "a1", session_id: "sesRoll", time_created: t0 + 1, data: asstP("big-pickle", 0.01, { input: 100, output: 10 }, "opencode") },
      { id: "u2", session_id: "sesRoll", time_created: t0 + 2, data: { role: "user" } },
      { id: "a2", session_id: "sesRoll", time_created: t0 + 3, data: { role: "assistant", modelID: "big-pickle", cost: 0.02 } },
    ],
    parts: [
      textPart("u1", "sesRoll", t0, "start here"),
      textPart("a1", "sesRoll", t0 + 1, "first answer"),
      taskPart("a1", "sesRoll", t0 + 1, "child-1"),
      textPart("u2", "sesRoll", t0 + 2, "keep going"),
    ],
  });
  try {
    await withEnv({ data: dir, cache: null }, async (m) => {
      const turns = await m.buildTurns({ sessionId: "sesRoll", cwd: "K:/roll" });
      assert.equal(turns.length, 1, "one authoritative rollup, not a per-turn split");
      assert.equal(turns[0].quality, "session-rollup");
      assert.equal(turns[0].prompt, "start here", "the first user message's text is the prompt");
      assert.equal(turns[0].usage.input, 999, "token totals still come from the session row");
      assert.deepEqual(turns[0].counts, { apiCalls: 2, subagentCalls: 1, toolCalls: 1, thinkingBlocks: 0 });
      assert.equal(turns[0].contextTokens, 100, "the rollup still names the largest request present");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("OpenCode placeholder session titles are not names", needsSqlite, async () => {
  const t0 = Date.parse("2026-09-16T21:48:13Z");
  const titles = ["New session - 2026-09-16T21:48:13.390Z", "Child session - 2026-09-16T22:00:00.000Z", "Real name"];
  const sessions = titles.map((title, i) => ({
    id: `title-${i}`, directory: "K:/t", model: "big-pickle", title, cost: 0.01,
    tokens_input: 10, tokens_output: 1, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
    time_created: t0 + i, time_updated: t0 + i + 1,
  }));
  const dir = makeDb({
    sessions,
    messages: sessions.flatMap((s) => [
      { id: `${s.id}-u`, session_id: s.id, time_created: s.time_created, data: { role: "user" } },
      { id: `${s.id}-a`, session_id: s.id, time_created: s.time_created + 1, data: asstP("big-pickle", 0.01, { input: 10, output: 1 }, "opencode") },
    ]),
    parts: sessions.flatMap((s) => [textPart(`${s.id}-u`, s.id, s.time_created, s.title), textPart(`${s.id}-a`, s.id, s.time_created + 1, "x")]),
  });
  try {
    await withEnv({ data: dir, cache: null }, async (m) => {
      const byId = Object.fromEntries(sessions.map((s, i) => [s.id, i]));
      for (const s of sessions) {
        const turn = (await m.buildTurns({ sessionId: s.id }))[0];
        assert.equal(turn.sessionName, byId[s.id] === 2 ? "Real name" : null, `${s.title}`);
      }
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


const reviewSession = (id, extra = {}) => ({
  id, directory: os.tmpdir(), model: JSON.stringify({ id: "session-model", providerID: "fallback" }),
  title: "Review fixture", cost: 0.03, tokens_input: 1000, tokens_output: 3,
  tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
  time_created: 1700000000000, time_updated: 1700000000100, ...extra,
});
const reviewMessage = (id, sid, i, data) => ({ id, session_id: sid, time_created: 1700000000000 + i, data });

test("OpenCode peak identifiers stay with the first or strictly larger request in turns and rollups", needsSqlite, async (t) => {
  const cases = [
    { name: "missing first provider", requests: [[900, "big", null], [10, "small", "p"]], window: 8000 },
    { name: "missing later provider", requests: [[10, "small", "p"], [900, "big", null]], window: 8000 },
    { name: "missing peak model", requests: [[10, "small", "p"], [900, null, "q"]], window: 9000 },
    { name: "different providers", requests: [[10, "small", "p"], [900, "big", "q"]], window: 5000 },
    { name: "equal peaks keep first", requests: [[900, "small", "p"], [900, "big", "q"]], window: 1000 },
    { name: "zero first request is a peak", requests: [[0, "big", null], [0, "small", "p"]], window: 8000 },
    { name: "missing both peak ids", requests: [[10, "small", "p"], [900, null, null]], window: 7000 },
  ];
  const models = {
    p: { models: { small: { limit: { context: 1000 } }, big: { limit: { context: 2000 } } } },
    q: { models: { small: { limit: { context: 3000 } }, big: { limit: { context: 5000 } }, "session-model": { limit: { context: 9000 } } } },
    fallback: { models: { big: { limit: { context: 8000 } }, "session-model": { limit: { context: 7000 } } } },
  };
  const sessions = [], messages = [];
  for (const [i, c] of cases.entries()) for (const rollup of [false, true]) {
    const sid = `peak-${i}-${rollup}`;
    sessions.push(reviewSession(sid)); messages.push(reviewMessage(`${sid}-u`, sid, 0, { role: "user" }));
    c.requests.forEach(([input, model, provider], j) => messages.push(reviewMessage(`${sid}-a${j}`, sid, j + 1,
      asstP(model, .01, { input, output: 1 }, provider))));
    if (rollup) messages.push(reviewMessage(`${sid}-pending`, sid, 10, { role: "assistant" }));
  }
  const dir = makeDb({ sessions, messages }), cache = cacheDir(models);
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); });
  await withEnv({ data: dir, cache }, async (m) => {
    for (const [i, c] of cases.entries()) for (const rollup of [false, true]) {
      const [row] = await m.buildTurns({ sessionId: `peak-${i}-${rollup}` });
      assert.equal(row.quality, rollup ? "session-rollup" : undefined, c.name);
      assert.equal(row.contextTokens, Math.max(...c.requests.map(([n]) => n)), c.name);
      assert.equal(row.contextMax, c.window, `${c.name}, rollup=${rollup}`);
    }
  });
});

test("OpenCode windows use exact catalogue then known Claude table and never another provider", needsSqlite, async (t) => {
  const cases = [
    ["claude-opus-5", "exact", 123456], ["claude-opus-5", "alias", 1000000],
    ["claude-sonnet-4-5", "alias", 200000], ["claude-not-a-known-model", "alias", null],
    ["gpt-5", "alias", null], ["gemini-test", "alias", null], ["o3", "alias", null],
    ["unique-model", "alias", null], ["unique-model", "exact", 262144],
  ];
  const dir = makeDb({ sessions: cases.map((_, i) => reviewSession(`win-${i}`)), messages: cases.flatMap(([model, provider], i) => [
    reviewMessage(`u${i}`, `win-${i}`, 0, { role: "user" }),
    reviewMessage(`a${i}`, `win-${i}`, 1, asstP(model, .01, { input: 500, output: 1 }, provider)),
  ]) });
  const cache = cacheDir({ exact: { models: { "claude-opus-5": { limit: { context: 123456 } }, "unique-model": { limit: { context: 262144 } } } } });
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); });
  await withEnv({ data: dir, cache }, async (m) => {
    for (const [i, [model, provider, window]] of cases.entries()) {
      const [row] = await m.buildTurns({ sessionId: `win-${i}` });
      assert.equal(row.contextMax, window, `${provider}/${model}`);
      if (window === null) assert.equal(row.contextFillPct, null);
    }
  });
});

test("OpenCode request counts include every step while completeness counts messages", needsSqlite, async (t) => {
  const sessions = [reviewSession("complete"), reviewSession("rollup")];
  const messages = sessions.flatMap(({ id }) => [
    reviewMessage(`${id}-u`, id, 0, { role: "user" }),
    reviewMessage(`${id}-a`, id, 1, asstP("x", .01, { input: 100, output: 2 }, "p")),
    reviewMessage(`${id}-b`, id, 2, asstP("x", .02, { input: 5, output: 1 }, "p")),
    ...(id === "rollup" ? [reviewMessage(`${id}-pending`, id, 3, { role: "assistant" })] : []),
  ]);
  const parts = sessions.flatMap(({ id }) => [stepFinish(`${id}-a`, id, 1, 60, 0), stepFinish(`${id}-a`, id, 2, 40, 0),
    { message_id: `${id}-a`, session_id: id, time_created: 3, data: { type: "step-finish", tokens: { input: 0, output: 0 } } }]);
  const dir = makeDb({ sessions, messages, parts }); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await withDataDir(dir, async (m) => {
    const [complete] = await m.buildTurns({ sessionId: "complete" });
    assert.equal(complete.quality, undefined); assert.equal(complete.counts.apiCalls, 4);
    assert.equal(complete.usage.input, 105); assert.equal(complete.contextTokens, 60); assert.equal(complete.cost.total, .03);
    const [rollup] = await m.buildTurns({ sessionId: "rollup" });
    assert.equal(rollup.quality, "session-rollup"); assert.equal(rollup.counts.apiCalls, 5);
  });
});

test("OpenCode cyclic ancestry terminates and long ancestry stops at 64", needsSqlite, async (t) => {
  const sessions = [reviewSession("a", { parent_id: "b" }), reviewSession("b", { parent_id: "a" }),
    reviewSession("self", { parent_id: "self" }),
    ...Array.from({ length: 70 }, (_, i) => reviewSession(`chain-${i}`, { parent_id: i < 69 ? `chain-${i + 1}` : null }))];
  const dir = makeDb({ sessions }); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outFile = path.join(dir, "depth.stdout"), errFile = path.join(dir, "depth.stderr");
  const out = fs.openSync(outFile, "w"), err = fs.openSync(errFile, "w");
  let result;
  try {
    const module = new URL("../src/providers/opencode/transcript.mjs", import.meta.url).href;
    const code = `import { buildTurns } from ${JSON.stringify(module)}; console.log(JSON.stringify(await Promise.all(['a','self','chain-0'].map(async sessionId => (await buildTurns({sessionId}))[0].agent.depth))));`;
    result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, XDG_DATA_HOME: dir }, timeout: 5000, stdio: ["ignore", out, err],
    });
  } finally { fs.closeSync(out); fs.closeSync(err); }
  assert.ifError(result.error);
  assert.equal(result.status, 0, fs.readFileSync(errFile, "utf8"));
  assert.deepEqual(JSON.parse(fs.readFileSync(outFile, "utf8")), [2, 1, 64]);
});


test("zai: OpenCode preserves cost and prefers catalogue over vendor windows", needsSqlite, async (t) => {
  const cases = [["GLM-5.3-Flash", "exact", 500000], ["GLM-5.3-Flash", "zai", 1000000], ["glm-5.2", "zai", null], ["glm-unknown", "zai", null]];
  const dir = makeDb({ sessions: cases.map((_, i) => reviewSession(`glm-${i}`)), messages: cases.flatMap(([model, provider], i) => [
    reviewMessage(`u${i}`, `glm-${i}`, 0, { role: "user" }),
    reviewMessage(`a${i}`, `glm-${i}`, 1, asstP(model, 7.25, { input: 10000, output: 100 }, provider)),
  ]) });
  const cache = cacheDir({ exact: { models: { "GLM-5.3-Flash": { limit: { context: 500000 } } } } });
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cache, { recursive: true, force: true }); });
  await withEnv({ data: dir, cache }, async (m) => {
    for (const [i, [, , window]] of cases.entries()) {
      const [row] = await m.buildTurns({ sessionId: `glm-${i}` });
      assert.equal(row.provider, "opencode");
      assert.equal(row.vendor, "z.ai");
      assert.equal(row.cost.total, 7.25);
      assert.equal(row.cost.source, "provider");
      assert.equal(row.contextMax, window);
      assert.equal(row.contextFillPct, window ? Math.round(10000 / window * 1000) / 10 : null);
    }
  });
});

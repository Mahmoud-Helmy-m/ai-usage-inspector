// Parse a Claude Code transcript (+ its subagent transcripts) into per-prompt
// "turn" records. Zero dependencies.
//
// Key realities of the JSONL format this handles:
//  - One assistant message spans MULTIPLE lines (one per content block /
//    streaming checkpoint), all sharing message.id. Usage is repeated and grows
//    to a final value -> we dedupe by message.id and keep the final usage.
//  - Each subagent run lives in its own file under <session>/subagents/, beside
//    a sidecar agent-<id>.meta.json naming the tool call that launched it -> the
//    run belongs to the turn (or run) that made that call, is kept as a tree on
//    that turn, and its tokens/cost roll into the turn once.
//  - Subagents may run a different model -> cost is computed per message.
//  - The session's name is a `custom-title` line, written again as the session
//    goes on; the last one is current. An unnamed session gets `ai-title` lines.

import { vendorOf } from "../../lib/vendors/index.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { settingsEvidence } from "../../lib/hook-pricing.mjs";
import { costOf, contextMax, modelInfo, zeroCost, addCost } from "./pricing.mjs";
import { subagentsDir } from "../../lib/paths.mjs";

function readJsonl(file, strict = false) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (strict || err.code !== "ENOENT") throw err;
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* skip torn/partial line */
    }
  }
  return out;
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Cover the entire parse input, including membership and sidecars, so a
// background run that lands while the main file sits still is still noticed.
// Identity is each file's mtime and size, never its bytes: a sweep stamps every
// transcript on this machine, and hashing hundreds of megabytes of history to
// learn that nothing changed costs more than the whole scan. A file that stats
// but cannot be read is caught where it is actually read — the parse fails, the
// scan reports failure, and its watermark stays behind it.
export function transcriptSnapshot(transcriptPath) {
  const dir = subagentsDir(transcriptPath);
  let names = [], directory = null;
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".meta.json")).sort();
    directory = fs.statSync(dir);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  let mtimeMs = directory ? directory.mtimeMs : 0;
  const hash = createHash("sha256");
  hash.update(JSON.stringify([directory !== null, names]));
  for (const file of [transcriptPath, ...names.map((n) => path.join(dir, n))]) {
    const stat = fs.statSync(file);
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
    hash.update(JSON.stringify([file, stat.mtimeMs, stat.size]));
  }
  return { stamp: hash.digest("hex"), mtimeMs };
}

// Is this entry a genuine human prompt on the main thread?
function isHumanPrompt(e) {
  if (!e || e.type !== "user" || e.isSidechain === true) return false;
  if (e.isMeta) return false;
  if (e.toolUseResult !== undefined) return false; // tool result, not a prompt
  const c = e.message && e.message.content;
  if (typeof c === "string") return true;
  if (Array.isArray(c)) return !c.some((b) => b && b.type === "tool_result");
  return false;
}

function promptText(e) {
  const c = e.message && e.message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

// Group assistant entries by message.id, keeping the final usage (max
// output_tokens) and the union of content blocks across partial lines.
function collectAssistants(entries) {
  const byId = new Map();
  const order = [];
  for (const e of entries) {
    if (!e || e.type !== "assistant" || !e.message || !e.message.id) continue;
    const id = e.message.id;
    let g = byId.get(id);
    if (!g) {
      g = {
        id,
        model: e.message.model,
        promptId: e.promptId,
        blocks: [],
        usage: e.message.usage || null,
        bestOut: (e.message.usage && e.message.usage.output_tokens) || -1,
        stopReason: e.message.stop_reason || null,
        ts: e.timestamp,
        firstTs: e.timestamp, // timestamp of the first streamed line — never overwritten
        serviceTier: e.message.usage && e.message.usage.service_tier,
        speed: e.message.usage && e.message.usage.speed,
      };
      byId.set(id, g);
      order.push(id);
    }
    if (Array.isArray(e.message.content)) g.blocks.push(...e.message.content);
    const out = (e.message.usage && e.message.usage.output_tokens) || 0;
    // Keep the most complete usage (final streamed value / the one that stopped).
    if (e.message.usage && (e.message.stop_reason || out > g.bestOut)) {
      g.usage = e.message.usage;
      g.bestOut = out;
      g.stopReason = e.message.stop_reason || g.stopReason;
      g.serviceTier = e.message.usage.service_tier || g.serviceTier;
      g.speed = e.message.usage.speed || g.speed;
      g.ts = e.timestamp || g.ts;
    }
    if (e.promptId && !g.promptId) g.promptId = e.promptId;
    if (e.requestId && !g.requestId) g.requestId = e.requestId;
  }
  return order.map((id) => byId.get(id));
}

// Anthropic's API answers every request with a request id ("req_" and base62), which Claude
// Code records on the entry. A local server does not, so such an id proves the turn was sent
// to Anthropic and billed — even through a local proxy that forwards to it, and whatever
// today's settings say. Its absence proves nothing: other endpoints omit it too.
const ANTHROPIC_REQUEST = /^req_[A-Za-z0-9]{20,}$/;
const runTree = (run) => [...run.messages, ...run.children.flatMap(runTree)];
function provenAnthropic(t) {
  return t.main.concat(t.runs.flatMap(runTree)).some((m) => ANTHROPIC_REQUEST.test(m.requestId || ""));
}

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    reasoning: 0, // OpenAI reasoning tokens; always 0 for Claude
    cacheCreate: 0,
    cacheRead: 0,
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
}

function addUsageTokens(acc, u) {
  if (!u) return;
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheCreate += u.cache_creation_input_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  const cc = u.cache_creation || {};
  acc.cacheCreate1h += cc.ephemeral_1h_input_tokens || 0;
  acc.cacheCreate5m += cc.ephemeral_5m_input_tokens || 0;
  const st = u.server_tool_use || {};
  acc.webSearch += st.web_search_requests || 0;
  acc.webFetch += st.web_fetch_requests || 0;
}

function countBlocks(messages) {
  let toolCalls = 0;
  let thinking = 0;
  for (const m of messages) {
    for (const b of m.blocks) {
      if (!b) continue;
      if (b.type === "tool_use") toolCalls++;
      else if (b.type === "thinking") thinking++;
    }
  }
  return { toolCalls, thinking };
}

// Skills invoked during a turn = Skill tool_use blocks (input.skill / .command).
function collectSkills(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      if (!b || b.type !== "tool_use" || b.name !== "Skill" || !b.input) continue;
      const s = b.input.skill || b.input.command || b.input.name;
      if (s && !seen.has(String(s))) {
        seen.add(String(s));
        out.push(String(s));
      }
    }
  }
  return out;
}

function responseText(messages) {
  const parts = [];
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("");
}

function costFields(cost) {
  return {
    input: cost.input,
    output: cost.output,
    cacheWrite: cost.cacheWrite,
    cacheRead: cost.cacheRead,
    total: cost.total,
    source: cost.source || "priced",
    ...(cost.estimatedRate ? { estimatedRate: true } : {}),
    // Carried so a later correction to a model's rates can tell this cost was
    // worked out before it (see pricing.mjs, RATES_REVISION).
    ...(typeof cost.rates === "number" ? { rates: cost.rates } : {}),
    ...(typeof cost.supersedes === "number" ? { supersedes: cost.supersedes } : {}),
    ...(typeof cost.relabels === "number" ? { relabels: cost.relabels } : {}),
    ...(cost.rateSource ? { rateSource: cost.rateSource } : {}),
  };
}

// The last message a model produced. Claude Code closes a turn that hit an API
// error or was interrupted with a "<synthetic>" message: no model, no tokens.
// Naming the turn after it, or measuring its context from it, would hide the
// model that did the work and report the window empty.
const SYNTHETIC = "<synthetic>";
function lastReal(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].model !== SYNTHETIC) return messages[i];
  }
  return messages[messages.length - 1];
}

// How full one thread's context window was: the whole input of its last request
// against its model's window. The main thread and every subagent run are
// separate conversations with windows of their own, so each is measured on its
// own messages and never on another's.
function contextOf(messages, fallbackModel) {
  const last = lastReal(messages);
  const model = (last && last.model) || fallbackModel || "unknown";
  const u = (last && last.usage) || {};
  const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  let max = contextMax(model);
  // Unknown Claude windows retain their guess; unknown GLM windows stay null. A
  // request larger than the guess proves the guess wrong: Claude's only window
  // above 200k is 1M. Better that than a context reported several times full.
  if (max !== null && !modelInfo(model).windowKnown && used > max) max = 1_000_000;
  return {
    contextTokens: used,
    contextMax: max,
    contextFillPct: max ? Math.round((used / max) * 1000) / 10 : null,
  };
}

function eachToolUse(messages, fn) {
  for (const m of messages) {
    for (const b of m.blocks) if (b && b.type === "tool_use" && b.id) fn(b);
  }
}

// tool_use id -> the toolUseResult Claude Code recorded when that call returned.
function toolResults(entries, into = new Map()) {
  for (const e of entries) {
    if (!e || e.type !== "user" || !e.toolUseResult || typeof e.toolUseResult !== "object") continue;
    const c = e.message && e.message.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) if (b && b.type === "tool_result" && b.tool_use_id) into.set(b.tool_use_id, e.toolUseResult);
  }
  return into;
}

// One run per file in the subagents dir. The sidecar names the tool call that
// launched it; versions that wrote no sidecar leave only the promptId the run's
// entries carry.
function loadRuns(transcriptPath) {
  const dir = subagentsDir(transcriptPath);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return files.map((f) => {
    const entries = readJsonl(`${dir}/${f}`, true);
    const stem = f.slice(0, -".jsonl".length);
    const stamped = entries.filter((e) => e && e.timestamp);
    const tagged = entries.find((e) => e && e.agentId);
    const prompted = entries.find((e) => e && e.promptId);
    return {
      agentId: String((tagged && tagged.agentId) || stem.replace(/^agent-/, "")),
      promptId: (prompted && prompted.promptId) || null,
      meta: readJson(`${dir}/${stem}.meta.json`) || {},
      messages: collectAssistants(entries),
      results: toolResults(entries),
      ts: stamped.length ? stamped[0].timestamp : null,
      endTs: stamped.length ? stamped[stamped.length - 1].timestamp : null,
      children: [],
      call: {},
      result: {},
    };
  });
}

/**
 * Give every run exactly one place: the turn whose message made the call that
 * launched it, or the run whose message did. Its work is then counted once.
 * A run without a sidecar goes to the last turn of its prompt that did any work.
 * A slash command writes its command line, its output and the expanded prompt
 * as entries of one prompt, and handing the run to each of them counted its work
 * several times.
 */
function attachRuns(runs, turns, results) {
  if (!runs.length) return;
  const callTurn = new Map();
  const callRun = new Map();
  const calls = new Map();
  for (const t of turns) {
    eachToolUse(t.main, (b) => {
      callTurn.set(b.id, t);
      calls.set(b.id, b.input || {});
    });
  }
  for (const run of runs) {
    eachToolUse(run.messages, (b) => {
      callRun.set(b.id, run);
      calls.set(b.id, b.input || {});
    });
    for (const [id, r] of run.results) results.set(id, r);
  }
  for (const run of runs) {
    const launch = run.meta.toolUseId;
    if (launch) {
      run.call = calls.get(launch) || {};
      run.result = results.get(launch) || {};
    }
    const parent = launch ? callRun.get(launch) : null;
    if (launch && callTurn.has(launch)) {
      callTurn.get(launch).runs.push(run);
    } else if (parent && parent !== run) {
      parent.children.push(run);
    } else if (run.promptId) {
      const mine = turns.filter((t) => t.promptId === run.promptId);
      const owner = [...mine].reverse().find((t) => t.main.length) || mine[mine.length - 1];
      if (owner) owner.runs.push(run);
    }
  }
}

// A run's own share, with the runs it launched beneath it. `seen` spans the whole
// transcript, so a run can never be emitted — or counted — twice; `messages`
// collects every message of the tree for the owning turn's totals.
function runRecord(run, seen, messages, endpoint) {
  seen.add(run);
  messages.push(...run.messages);
  const usage = emptyTokens();
  let cost = endpoint === "local" ? costOf(null, null, { endpoint }) : zeroCost();
  for (const m of run.messages) {
    addUsageTokens(usage, m.usage);
    cost = addCost(cost, costOf(m.model, m.usage, { endpoint }));
  }
  const { toolCalls, thinking } = countBlocks(run.messages);
  const last = run.messages[run.messages.length - 1];
  const endTs = (last && last.ts) || run.endTs || run.ts;
  const subagents = [];
  for (const child of run.children) if (!seen.has(child)) subagents.push(runRecord(child, seen, messages, endpoint));
  return {
    agentId: run.agentId,
    agentType: run.meta.agentType || run.call.subagent_type || run.result.agentType || null,
    description: run.meta.description || run.call.description || null,
    background: Boolean(run.call.run_in_background || run.result.isAsync),
    status: run.result.status || null,
    model: (lastReal(run.messages) || {}).model || run.result.resolvedModel || null,
    vendor: vendorOf((lastReal(run.messages) || {}).model || run.result.resolvedModel),
    ts: run.ts,
    endTs,
    durationMs: run.ts && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(run.ts)) : 0,
    usage,
    cost: costFields(cost),
    ...contextOf(run.messages, run.result.resolvedModel),
    counts: { apiCalls: run.messages.length, toolCalls, thinkingBlocks: thinking },
    subagents,
  };
}

const countRuns = (runs) => runs.reduce((n, r) => n + 1 + countRuns(r.subagents), 0);

/**
 * Parse a transcript into an array of turn records (one per human prompt).
 * Returns [] if the file can't be read or has no human prompts.
 */
export function buildTurns(transcriptPath, opts = {}) {
  const entries = readJsonl(transcriptPath);
  if (!entries.length) return [];

  const assistants = collectAssistants(entries);
  const assistantById = new Map(assistants.map((a) => [a.id, a]));

  // Walk entries in order, segmenting at human prompts and attaching each
  // unique assistant message to the open turn.
  const turns = [];
  let cur = null;
  const consumed = new Set();
  // The transcript is named for its session, which is the one identifier both
  // the hook path and the backfill scan can always see — entry-level sessionId
  // is not guaranteed to be present.
  const fileSession = path.basename(String(transcriptPath || ""), ".jsonl") || null;
  // After /compact, Claude Code writes earlier prompts into the transcript again:
  // the same uuid under a new promptId, with none of the turn's work after it.
  // Opening a turn for the replay put an empty copy beside the real turn, and
  // the store kept whichever was written last — the empty one.
  const opened = new Set();
  // The name the user gave the session and the title Claude generated for it.
  const names = new Map();
  const titles = new Map();
  for (const e of entries) {
    if (e && e.type === "custom-title" && typeof e.customTitle === "string") {
      names.set(e.sessionId || fileSession, e.customTitle.trim() || null);
    } else if (e && e.type === "ai-title" && typeof e.aiTitle === "string") {
      titles.set(e.sessionId || fileSession, e.aiTitle.trim() || null);
    } else if (isHumanPrompt(e)) {
      if (e.uuid && opened.has(e.uuid)) continue;
      if (e.uuid) opened.add(e.uuid);
      cur = {
        promptEntry: e,
        promptId: e.promptId || null,
        session: e.sessionId || fileSession,
        index: turns.length,
        main: [],
        runs: [],
      };
      turns.push(cur);
    } else if (e && e.type === "assistant" && e.message && e.message.id && cur) {
      const id = e.message.id;
      if (!consumed.has(id) && assistantById.has(id)) {
        consumed.add(id);
        cur.main.push(assistantById.get(id));
      }
    }
  }

  attachRuns(loadRuns(transcriptPath), turns, toolResults(entries));
  // A branch or fork opens with entries written when it was made, followed by the
  // history it copied, whose timestamps are older. A prompt more than a minute older
  // than the transcript's first entry was copied from another session; anything
  // closer is clock skew between entries written together.
  const stamped = entries.find((e) => e && e.timestamp);
  const copiedBefore = stamped ? Date.parse(stamped.timestamp) - 60 * 1000 : null;
  const session = { seenRuns: new Set(), copiedBefore, transcriptFirstTs: stamped && Number.isFinite(Date.parse(stamped.timestamp)) ? stamped.timestamp : null };
  const identities = turns.map((t) => ({
    provider: "claude", sessionId: t.session, cwd: t.promptEntry.cwd,
    id: turnId(t),
    copied: copiedBefore !== null && Date.parse(t.promptEntry.timestamp) < copiedBefore,
  }));
  // Settings read now count only for turns that ran after every settings file last changed.
  const evidence = new Map();
  const endpointAt = (cwd, ts) => {
    if (!evidence.has(cwd)) evidence.set(cwd, settingsEvidence(cwd));
    const { endpoint, changedAt } = evidence.get(cwd);
    const at = Date.parse(ts);
    return endpoint && Number.isFinite(at) && changedAt <= at ? endpoint : null;
  };
  return turns.map((t, i) => finalizeTurn(t, { ...opts,
    // Proof from the responses first; then what an earlier read stored (a hook that saw this
    // turn end, if one did), the hook's reading now, and settings unchanged since the turn ran.
    // A stored value outranks a later hook: a hook firing again for a turn it already
    // recorded reads today's environment, which may not be the one the turn ran in.
    endpoint: (provenAnthropic(t) ? "anthropic" : null)
      || opts.pricingForTurn?.(identities[i], identities)?.endpoint
      || (i === turns.length - 1 ? opts.hookPricing?.endpoint : null)
      || endpointAt(t.promptEntry.cwd, t.promptEntry.timestamp),
  }, {
    ...session, name: names.get(t.session) || null, title: titles.get(t.session) || null,
  })).filter(Boolean);
}

function turnId(t) {
  const e = t.promptEntry;
  return e.uuid || (e.sessionId ? `${e.sessionId}:${e.promptId || e.timestamp}` : null)
    || `${t.session || "unknown"}:${e.promptId || e.timestamp}:${t.index}`;
}

function finalizeTurn(t, opts, session) {
  const endpoint = opts.endpoint;
  const e = t.promptEntry;
  const main = t.main;
  const runMessages = [];
  const subagents = [];
  for (const run of t.runs) {
    if (!session.seenRuns.has(run)) subagents.push(runRecord(run, session.seenRuns, runMessages, endpoint));
  }

  // Token totals: the main thread plus every run beneath this turn, each once.
  const tokens = emptyTokens();
  let cost = endpoint === "local" ? costOf(null, null, { endpoint }) : zeroCost();
  for (const m of main.concat(runMessages)) {
    addUsageTokens(tokens, m.usage);
    cost = addCost(cost, costOf(m.model, m.usage, { endpoint }));
  }

  const last = main[main.length - 1];
  const real = lastReal(main);
  const model = (real && real.model) || (e.message && e.message.model) || "unknown";
  // The turn's context is its main thread's alone; its runs report their own.
  const context = contextOf(main, model);

  const { toolCalls, thinking } = countBlocks(main);
  const skills = collectSkills(main);
  const prompt = promptText(e);
  const response = responseText(main);
  const startTs = e.timestamp;
  const endTs = (last && last.ts) || startTs;
  const durationMs =
    startTs && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(startTs)) : 0;
  // Latency to the first assistant message (transcript-granularity TTFT).
  const firstAsstTs = main[0] && (main[0].firstTs || main[0].ts);
  const firstResponseMs =
    startTs && firstAsstTs ? Math.max(0, Date.parse(firstAsstTs) - Date.parse(startTs)) : 0;

  return {
    id: turnId(t),
    // Only for the one shape an older version could not identify: no uuid and no
    // entry-level session, which it stored as "undefined:<promptId or ts>". The
    // store uses this to replace that row instead of leaving it beside this one.
    ...(!e.uuid && !e.sessionId ? { legacyId: `undefined:${e.promptId || startTs}` } : {}),
    provider: "claude",
    ...(endpoint ? { endpoint } : {}),
    transcriptFirstTs: session.transcriptFirstTs,
    branchResolution: "unresolved",
    // A compaction summary is written as a user turn ("This session is being
    // continued from a previous conversation...") but nobody typed it. It still
    // opens a real turn — the work that follows has to hang off something — so
    // keep the segment and mark it, rather than folding its usage into whatever
    // the human happened to type before the compaction.
    synthetic: e.isCompactSummary ? "compact-summary" : undefined,
    // Copied into this transcript by a branch or fork; the store keeps it with the
    // session it came from when that session is stored too.
    ...(session.copiedBefore !== null && Date.parse(startTs) < session.copiedBefore ? { copied: true } : {}),
    sessionId: e.sessionId || t.session || null,
    sessionName: session.name,
    sessionTitle: session.title,
    cwd: e.cwd,
    slug: e.slug || null,
    gitBranch: e.gitBranch || null,
    cliVersion: e.version || null,
    entrypoint: e.entrypoint || null,
    ts: startTs,
    endTs,
    durationMs,
    firstResponseMs,
    prompt,
    promptChars: prompt.length,
    response,
    responseChars: response.length,
    model,
    vendor: vendorOf(model),
    serviceTier: (real && real.serviceTier) || null,
    speed: (real && real.speed) || null,
    permissionMode: e.permissionMode || "default",
    effortLevel: opts.effortLevel || null,
    skills,
    usage: tokens,
    ...context,
    counts: {
      apiCalls: main.length,
      subagentCalls: countRuns(subagents),
      toolCalls,
      thinkingBlocks: thinking,
    },
    ...(subagents.length ? { subagents } : {}),
    cost: costFields(cost),
    schema: 2,
  };
}

// Parse one Cline-family task (Cline / Roo Code / Kilo Code — Roo and Kilo are
// forks of Cline and share this on-disk format) into per-prompt turn records.
// Zero third-party deps.
//
// A task dir holds:
//   ui_messages.json              array of display messages. Token usage lives
//                                 in { type:"say", say:"api_req_started" } whose
//                                 `text` is a JSON string:
//                                   { tokensIn, tokensOut, cacheWrites,
//                                     cacheReads, cost, apiProtocol, ... }
//                                 The initial user prompt is the first
//                                 { say:"text" }; later user input is
//                                 { say:"user_feedback" }.
//   api_conversation_history.json raw provider messages. The model + workspace
//                                 dir are only here, inside each user message's
//                                 <environment_details>:
//                                   <model>google/gemini-2.5-pro</model>
//                                   # Current Workspace Directory (k:/proj) Files
//
// One user prompt drives an agentic loop of many model calls, so we segment at
// user messages and SUM every api_req_started in between — one record per user
// prompt, with counts.apiCalls = number of model calls (matching how the Claude
// and Codex providers aggregate a turn).
import { vendorOf } from "../../lib/vendors/index.mjs";
import { isGlm, knownContextMax as zaiContextMax } from "../../lib/vendors/zai/pricing.mjs";
import fs from "node:fs";
import path from "node:path";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function isoOrNull(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toISOString();
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Pull the text out of an api_conversation_history message's content, which is
// either a string or an array of { type:"text", text } (and other) blocks.
function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
    .join("\n");
}

// Model + workspace dir come only from the <environment_details> that Cline
// appends to each user message. The model can change mid-task, so keep the last
// seen; the workspace dir is stable, so keep the first.
function metaFromHistory(history) {
  let model = null;
  let cwd = null;
  if (!Array.isArray(history)) return { model, cwd };
  for (const m of history) {
    if (!m || m.role !== "user") continue;
    const text = messageText(m.content);
    const mm = text.match(/<model>([^<]+)<\/model>/);
    if (mm) model = mm[1].trim();
    if (!cwd) {
      const cm = text.match(/Current (?:Workspace|Working) Directory \(([^)]+)\)/);
      if (cm) cwd = cm[1].trim();
    }
  }
  return { model, cwd };
}

// api_req_started.text -> normalized usage, or null when it carries no tokens.
function reqUsage(text) {
  let d = null;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object") return null;
  const input = num(d.tokensIn ?? d.inputTokens);
  const output = num(d.tokensOut ?? d.outputTokens);
  const cacheWrite = num(d.cacheWrites ?? d.cacheWrite);
  const cacheRead = num(d.cacheReads ?? d.cacheRead);
  const cost = num(d.cost);
  if (!(input || output || cacheWrite || cacheRead || cost)) return null;
  return { input, output, cacheWrite, cacheRead, cost, model: d.model || d.modelId || null };
}

// A message begins a new user turn.
function isUserMessage(m) {
  if (!m) return false;
  if (m.say === "user_feedback") return true;
  return m.say === "text" && m.__firstText === true;
}

/**
 * Parse a task into turn records. `ref` is the opaque transcript reference:
 * { taskId, dir, cwd }. `opts.provider` is the provider id (cline/roo/kilo) so
 * every record is tagged with the tool it came from.
 */
export function buildTurns(ref, opts = {}) {
  const provider = opts.provider || (ref && ref.provider) || "cline";
  const dir = ref && ref.dir;
  const taskId = (ref && ref.taskId) || (dir && path.basename(dir)) || null;
  if (!dir || !taskId) return [];

  const messages = readJson(path.join(dir, "ui_messages.json"));
  if (!Array.isArray(messages) || !messages.length) return [];

  const { model, cwd: histCwd } = metaFromHistory(readJson(path.join(dir, "api_conversation_history.json")));
  const cwd = (ref && ref.cwd) || opts.cwd || histCwd || null;

  // Mark the first say:"text" as the task prompt (later say:"text" are assistant).
  let seenText = false;
  for (const m of messages) {
    if (m && m.say === "text") {
      m.__firstText = !seenText;
      seenText = true;
    }
  }

  // Segment at user messages; sum every api_req in between.
  const turns = [];
  let cur = null;
  for (const m of messages) {
    if (isUserMessage(m)) {
      cur = { prompt: typeof m.text === "string" ? m.text : "", response: "", ts: num(m.ts), endTs: num(m.ts), usage: null, cost: 0, apiCalls: 0, toolCalls: 0, model: null, peakCtx: 0 };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (num(m.ts)) cur.endTs = num(m.ts);
    if (m.type === "ask" && m.ask === "tool") cur.toolCalls++;
    if (m.say === "text") cur.response += typeof m.text === "string" ? m.text : "";
    if (m.say === "api_req_started") {
      const u = reqUsage(m.text);
      if (u) {
        cur.usage = cur.usage || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
        cur.usage.input += u.input;
        cur.usage.output += u.output;
        cur.usage.cacheWrite += u.cacheWrite;
        cur.usage.cacheRead += u.cacheRead;
        cur.cost += u.cost;
        cur.apiCalls++;
        cur.model = cur.model || u.model;
        // Each agentic api_req resends the growing context, so tokensIn is
        // per-call (not cumulative). Sum feeds usage/cost totals; the largest
        // single call is the real peak context fill.
        cur.peakCtx = Math.max(cur.peakCtx, u.input + u.cacheRead);
      }
    }
  }

  // Number turns by their position in the FULL turn list, before filtering. Using
  // the filtered index would renumber every later record once an earlier turn
  // gains usage on a rescan, so ids must not shift as a task grows.
  const usable = turns.map((t, ordinal) => ({ t, ordinal })).filter(({ t }) => t.usage);
  if (!usable.length) return [];
  return usable.map(({ t, ordinal }) =>
    finalizeTurn(t, { provider, taskId, cwd, model: t.model || model, index: ordinal }),
  );
}

function finalizeTurn(t, ctx) {
  const u = t.usage;
  const usage = {
    input: num(u.input),
    output: num(u.output),
    reasoning: 0,
    cacheCreate: num(u.cacheWrite),
    cacheRead: num(u.cacheRead),
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const ctxTokens = t.peakCtx || usage.input + usage.cacheRead;
  const ctxMax = contextMax(ctx.model);
  const ts = isoOrNull(t.ts);
  const endTs = isoOrNull(t.endTs) || ts;
  return {
    id: `${ctx.taskId}:${ctx.index}`,
    provider: ctx.provider,
    sessionId: ctx.taskId,
    cwd: ctx.cwd,
    slug: null,
    gitBranch: null,
    cliVersion: null,
    entrypoint: ctx.provider,
    ts,
    endTs,
    durationMs: ts && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(ts)) : 0,
    firstResponseMs: 0,
    prompt: t.prompt || "",
    promptChars: (t.prompt || "").length,
    response: t.response || "",
    responseChars: (t.response || "").length,
    model: ctx.model || null,
    vendor: vendorOf(ctx.model),
    serviceTier: null,
    speed: null,
    permissionMode: "default",
    effortLevel: null,
    skills: [],
    usage,
    contextTokens: ctxTokens,
    contextMax: ctxMax,
    contextFillPct: ctxMax ? Math.round((ctxTokens / ctxMax) * 1000) / 10 : null,
    counts: { apiCalls: t.apiCalls, subagentCalls: 0, toolCalls: t.toolCalls, thinkingBlocks: 0 },
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: t.cost, source: "provider" },
    schema: 2,
  };
}

// Small context-window lookup by model substring; unknown windows stay null.
function contextMax(model) {
  const m = String(model || "").toLowerCase();
  if (isGlm(m)) return zaiContextMax(m);
  if (/gemini|gpt-4\.1|o[0-9]/.test(m)) return 1_000_000;
  if (/claude|sonnet|opus|haiku/.test(m)) return 200_000;
  if (/gpt-4o|gpt-4|gpt-5/.test(m)) return 128_000;
  return null;
}

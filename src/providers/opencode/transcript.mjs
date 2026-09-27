// Parse one OpenCode session into per-prompt turn records matching the shared
// schema. Zero third-party deps (SQLite via store.mjs).
//
// Realities handled:
//  - Cost + tokens are real (OpenCode computes and stores them), so nothing is
//    estimated. Per-assistant-message `data` JSON carries
//      { providerID, modelID, cost, tokens:{ input, output, reasoning, cache:{ read, write } } }
//    accessed defensively (field aliases) so schema drift degrades, not breaks.
//  - One assistant message can hold several model requests; each request ends in
//    a part of type "step-finish" carrying that request's own tokens. Context
//    fill is the LARGEST single request's input + cache read, not the summed
//    turn — an agentic loop resends a growing context, so the sum would overstate
//    the peak a window is actually filled.
//  - When per-message data isn't usable (older build / parts absent), we fall
//    back to ONE session-level record built from the authoritative `session`
//    table columns (tokens_*, cost, model) — correct totals, coarser grain, with
//    the counts that the existing messages explain and the first user prompt.
//  - OpenCode stores a single total cost per message, not an input/output split,
//    so the record's cost breakdown carries `total` with zeroed components.
//  - A subagent run is a child session whose parent_id names its parent. Its
//    rows carry parentSessionId + agent; the parent's task-tool parts name the
//    children it spawned. Each session stays its own record (as for Codex).
import { vendorOf } from "../../lib/vendors/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSession, parentChainDepth } from "./store.mjs";
import { isGlm, knownContextMax as zaiContextMax } from "../../lib/vendors/zai/pricing.mjs";
import { knownContextMax } from "../claude/pricing.mjs";

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

// Assistant message.data -> normalized usage, or null when no tokens present.
function msgUsage(data) {
  const tok = data && data.tokens;
  if (!tok || typeof tok !== "object") return null;
  const cache = tok.cache && typeof tok.cache === "object" ? tok.cache : {};
  const input = num(tok.input ?? tok.inputTokens);
  const output = num(tok.output ?? tok.outputTokens);
  const reasoning = num(tok.reasoning ?? tok.reasoningTokens);
  const cacheRead = num(cache.read ?? tok.cacheRead ?? tok.cache_read);
  const cacheWrite = num(cache.write ?? tok.cacheWrite ?? tok.cache_write);
  if (!(input || output || reasoning || cacheRead || cacheWrite)) return null;
  return { input, output, reasoning, cacheRead, cacheWrite };
}

const roleOf = (data) => (data && (data.role || data.type)) || null;
const modelOf = (data) => (data && (data.modelID || data.model || data.modelId)) || null;
const providerOf = (data) => (data && (data.providerID || data.providerId || data.provider)) || null;

// OpenCode stores session.model as a JSON string, e.g.
// '{"id":"deepseek-v4-flash-free","providerID":"opencode"}'. Reduce it to the
// bare model id; leave a plain string untouched.
function cleanModel(model) {
  if (model && typeof model === "object") {
    return cleanModel(model.id || model.modelID || model.modelId || model.model);
  }
  if (typeof model !== "string" || !model) return null;
  if (model[0] === "{") {
    try {
      const o = JSON.parse(model);
      return o.id || o.modelID || o.model || model;
    } catch {
      return model;
    }
  }
  return model;
}

// The provider id a model field carries (session.model JSON / message data).
function modelProvider(model) {
  if (model && typeof model === "object") return providerOf(model);
  if (typeof model !== "string" || !model || model[0] !== "{") return null;
  try {
    return providerOf(JSON.parse(model));
  } catch {
    return null;
  }
}

// Concatenate the text of a message's parts (skip tool/other part types).
function partsText(parts) {
  let text = "";
  let tools = 0;
  for (const p of parts || []) {
    if (!p || typeof p !== "object") continue;
    const t = p.type;
    if (t === "text" && typeof p.text === "string") text += p.text;
    else if (t === "tool" || t === "tool-invocation" || t === "tool_use") tools++;
  }
  return { text, tools };
}

// The child sessions a message's task-tool parts name. state.metadata normally
// holds the child's id; it can be missing, or an object carrying the id.
function taskChildren(parts) {
  const children = [];
  for (const p of parts || []) {
    if (!p || typeof p !== "object" || p.type !== "tool") continue;
    if (String(p.tool ?? p.name ?? "") !== "task") continue;
    const meta = p.state && p.state.metadata;
    if (typeof meta === "string" && meta) children.push(meta);
    else if (meta && typeof meta === "object" && meta.sessionId) children.push(String(meta.sessionId));
  }
  return children;
}

// How many of a message's tool parts are task (subagent) calls.
function taskCalls(parts) {
  let n = 0;
  for (const p of parts || []) {
    if (!p || typeof p !== "object" || p.type !== "tool") continue;
    if (String(p.tool ?? p.name ?? "") === "task") n++;
  }
  return n;
}

// OpenCode caches its model catalogue at <XDG_CACHE_HOME|~/.cache>/opencode/
// models.json, shaped { "<providerID>": { models: { "<modelID>": { limit:
// { context, output } } } } }. Read at most once per path per process; tolerate
// it being absent or malformed.
const modelsByPath = new Map();

function modelsJsonPath() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "opencode", "models.json");
}

function loadModelsJson() {
  const file = modelsJsonPath();
  if (modelsByPath.has(file)) return modelsByPath.get(file);
  let models = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object") models = parsed;
  } catch {}
  modelsByPath.set(file, models);
  return models;
}

function modelsWindow(providerId, modelId) {
  const provider = loadModelsJson()[providerId];
  const model = provider && provider.models && provider.models[modelId];
  const context = model && model.limit && Number(model.limit.context);
  return Number.isFinite(context) && context > 0 ? context : null;
}

// Context-window lookup: the request's providerID+modelID in models.json first,
// the known Claude table for Claude model ids, then null — an unknown window is
// stored as null, never as a 0 that reads like a real measurement.
function contextMax(providerId, model) {
  const fromCatalog = modelsWindow(providerId, model);
  if (fromCatalog !== null) return fromCatalog;
  const m = String(model || "").toLowerCase();
  if (isGlm(m)) return zaiContextMax(m);
  if (m.startsWith("claude-")) return knownContextMax(m);
  return null;
}

// One assistant message can hold several model requests; each ends in a
// step-finish part carrying that request's tokens. When a message has no
// step-finish parts, its own summed tokens stand in as the single request.
function messageRequests(msgData, parts) {
  const requests = [];
  for (const p of parts || []) {
    if (!p || typeof p !== "object" || p.type !== "step-finish") continue;
    const u = msgUsage(p);
    if (u) requests.push(u);
  }
  if (requests.length) return requests;
  const u = msgUsage(msgData);
  return u ? [u] : [];
}

// The largest single request's context across some assistant messages, with the
// provider/model that request ran under (read from the message that held it).
function peakContext(messages, partsByMsg) {
  let peak = null;
  for (const m of messages) {
    if (roleOf(m.data) !== "assistant") continue;
    for (const r of messageRequests(m.data, partsByMsg.get(m.id))) {
      const ctx = r.input + r.cacheRead;
      if (peak === null || ctx > peak.tokens) {
        peak = { tokens: ctx, provider: providerOf(m.data) || null, model: cleanModel(modelOf(m.data)) || null };
      }
    }
  }
  return peak;
}

// Count requests independently of message-usage completeness, including zero-token steps.
function requestCount(parts) {
  const steps = (parts || []).filter((p) => p?.type === "step-finish").length;
  return steps || 1;
}

// Counts a session rollup can honestly claim from the messages that exist.
function sessionCounts(messages, partsByMsg) {
  let apiCalls = 0;
  let toolCalls = 0;
  let subagentCalls = 0;
  for (const m of messages) {
    if (roleOf(m.data) !== "assistant") continue;
    const parts = partsByMsg.get(m.id) || [];
    apiCalls += requestCount(parts);
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const t = p.type;
      if (t === "tool" || t === "tool-invocation" || t === "tool_use") {
        toolCalls++;
        if (String(p.tool ?? p.name ?? "") === "task") subagentCalls++;
      }
    }
  }
  return { apiCalls, subagentCalls, toolCalls, thinkingBlocks: 0 };
}

// The first user message's text carries the turn's prompt; fall back to the
// session-input rows, then the caller appends the session title.
function firstUserPrompt(messages, partsByMsg, inputs) {
  for (const m of messages) {
    if (roleOf(m.data) !== "user") continue;
    const { text } = partsText(partsByMsg.get(m.id));
    if (text) return text;
  }
  return (inputs[0] && inputs[0].prompt) || "";
}

// OpenCode names an untitled session "New session - <ts>" and its child sessions
// "Child session - <ts>"; those placeholder names are not real names.
const PLACEHOLDER_NAME = /^(New|Child) session - \d{4}-\d{2}-\d{2}T/;

/**
 * Parse a session into turn records. `ref` is the opaque transcript reference:
 * { sessionId, cwd }. Async (SQLite via store.mjs).
 */
export async function buildTurns(ref, opts = {}) {
  const sessionId = (ref && ref.sessionId) || (typeof ref === "string" ? ref : null);
  if (!sessionId) return [];

  const { session, messages, partsByMsg, inputs } = await readSession(sessionId);
  if (!session && !messages.length) return [];

  const cwd = (ref && ref.cwd) || opts.cwd || (session && session.directory) || null;
  const sessionModel = cleanModel(session && session.model);
  const sessionName =
    typeof session?.title === "string" && session.title.trim() && !PLACEHOLDER_NAME.test(session.title.trim())
      ? session.title
      : null;

  // A child session (parent_id set) nests under its parent; depth is how far its
  // parent chain reaches back to a root session.
  const hierarchy = {};
  if (session && session.parent_id) {
    hierarchy.parentSessionId = session.parent_id;
    hierarchy.agent = {
      kind: "subagent",
      nickname: session.agent || null,
      path: null,
      depth: await parentChainDepth(session.id),
    };
  }

  // Segment at user messages; attach following assistant messages.
  const turns = [];
  let cur = null;
  for (const m of messages) {
    const role = roleOf(m.data);
    const parts = partsByMsg.get(m.id) || [];
    const { text, tools } = partsText(parts);
    if (role === "user") {
      cur = {
        prompt: text, response: "", model: null, usage: null, usageCalls: 0, cost: 0,
        apiCalls: 0, assistantMessages: 0, toolCalls: tools, ts: m.ts, endTs: m.ts,
        peak: null,
        subagentCalls: 0, spawnedAgents: new Set(),
      };
      turns.push(cur);
    } else if (role === "assistant" && cur) {
      cur.response += text;
      cur.toolCalls += tools;
      cur.assistantMessages++;
      cur.apiCalls += requestCount(parts);
      cur.subagentCalls += taskCalls(parts);
      for (const child of taskChildren(parts)) cur.spawnedAgents.add(child);
      cur.endTs = m.ts || cur.endTs;
      cur.model = cur.model || cleanModel(modelOf(m.data));
      cur.cost += num(m.data && m.data.cost);
      const u = msgUsage(m.data);
      if (u) {
        cur.usageCalls++;
        cur.usage = cur.usage || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
        cur.usage.input += u.input;
        cur.usage.output += u.output;
        cur.usage.reasoning += u.reasoning;
        cur.usage.cacheRead += u.cacheRead;
        cur.usage.cacheWrite += u.cacheWrite;
      }
      // The real peak context is the largest single request in the turn.
      for (const r of messageRequests(m.data, parts)) {
        const ctx = r.input + r.cacheRead;
        if (cur.peak === null || ctx > cur.peak.tokens) {
          cur.peak = { tokens: ctx, provider: providerOf(m.data) || null, model: cleanModel(modelOf(m.data)) || null };
        }
      }
    }
  }

  const completeUsage =
    turns.length > 0 &&
    turns.every((t) => t.assistantMessages > 0 && t.usageCalls === t.assistantMessages);
  if (completeUsage) {
    return turns.map((t, i) =>
      finalizeTurn(
        {
          prompt: t.prompt || promptFor(inputs, i),
          response: t.response,
          model: t.model || sessionModel,
          usage: t.usage || { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cost: t.cost,
          apiCalls: t.apiCalls,
          subagentCalls: t.subagentCalls,
          toolCalls: t.toolCalls,
          spawnedAgents: [...t.spawnedAgents],
          requestProvider: t.peak?.provider || modelProvider(session && session.model),
          requestModel: t.peak?.model || sessionModel,
          ctxPeak: t.peak?.tokens ?? null,
          ts: t.ts,
          endTs: t.endTs,
        },
        { sessionId, sessionName, hierarchy, cwd, index: i },
      ),
    );
  }

  // Any missing assistant usage makes per-turn accounting incomplete. Do not
  // invent an allocation: emit one authoritative session rollup instead.
  return [sessionRecord(session, messages, partsByMsg, inputs, { sessionId, sessionName, hierarchy, cwd })];
}

const promptFor = (inputs, i) => (inputs[i] && inputs[i].prompt) || (inputs[0] && inputs[0].prompt) || "";

function finalizeTurn(t, ctx) {
  const u = t.usage;
  const usage = {
    input: num(u.input),
    output: num(u.output),
    reasoning: num(u.reasoning),
    cacheCreate: num(u.cacheWrite),
    cacheRead: num(u.cacheRead),
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const ctxTokens = t.ctxPeak;
  const ctxMax = contextMax(t.requestProvider, t.requestModel);
  const total = num(t.cost);
  const ts = isoOrNull(t.ts);
  const endTs = isoOrNull(t.endTs) || ts;
  return record({
    id: `${ctx.sessionId}:${ctx.index}`,
    sessionId: ctx.sessionId,
    sessionName: ctx.sessionName,
    hierarchy: ctx.hierarchy,
    cwd: ctx.cwd,
    model: t.model || null,
    prompt: t.prompt || "",
    response: t.response || "",
    ts,
    endTs,
    durationMs: ts && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(ts)) : 0,
    usage,
    ctxTokens,
    ctxMax,
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total, source: "provider" },
    counts: { apiCalls: t.apiCalls, subagentCalls: t.subagentCalls, toolCalls: t.toolCalls, thinkingBlocks: 0 },
    spawnedAgents: t.spawnedAgents && t.spawnedAgents.length ? [...t.spawnedAgents] : null,
  });
}

function sessionRecord(session, messages, partsByMsg, inputs, ctx) {
  const s = session || {};
  const usage = {
    input: num(s.tokens_input),
    output: num(s.tokens_output),
    reasoning: num(s.tokens_reasoning),
    cacheCreate: num(s.tokens_cache_write),
    cacheRead: num(s.tokens_cache_read),
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const peak = peakContext(messages, partsByMsg);
  const ctxTokens = peak ? peak.tokens : null;
  const ctxMax = peak
    ? contextMax(peak.provider || modelProvider(s.model), peak.model || cleanModel(s.model))
    : null;
  const ts = isoOrNull(s.time_created);
  const endTs = isoOrNull(s.time_updated) || ts;
  return record({
    id: `${ctx.sessionId}:0`,
    sessionId: ctx.sessionId,
    sessionName: ctx.sessionName,
    hierarchy: ctx.hierarchy,
    cwd: ctx.cwd,
    model: cleanModel(s.model),
    prompt: firstUserPrompt(messages, partsByMsg, inputs) || s.title || "",
    response: "",
    ts,
    endTs,
    durationMs: ts && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(ts)) : 0,
    usage,
    ctxTokens,
    ctxMax,
    cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: num(s.cost), source: "provider" },
    counts: sessionCounts(messages, partsByMsg),
    quality: "session-rollup",
  });
}

// Assemble a full schema-2 record from the pieces above.
function record(r) {
  return {
    id: r.id,
    provider: "opencode",
    sessionId: r.sessionId,
    sessionName: r.sessionName,
    sessionTitle: null,
    ...(r.hierarchy && r.hierarchy.parentSessionId ? { parentSessionId: r.hierarchy.parentSessionId, agent: r.hierarchy.agent } : {}),
    ...(r.spawnedAgents && r.spawnedAgents.length ? { spawnedAgents: r.spawnedAgents } : {}),
    cwd: r.cwd,
    slug: null,
    gitBranch: null,
    cliVersion: null,
    entrypoint: "opencode",
    ts: r.ts,
    endTs: r.endTs,
    durationMs: r.durationMs || 0,
    firstResponseMs: 0,
    prompt: r.prompt,
    promptChars: r.prompt.length,
    response: r.response,
    responseChars: r.response.length,
    model: r.model,
    vendor: vendorOf(r.model),
    serviceTier: null,
    speed: null,
    permissionMode: "default",
    effortLevel: null,
    skills: [],
    usage: r.usage,
    contextTokens: r.ctxTokens,
    contextMax: r.ctxMax,
    contextFillPct: r.ctxTokens != null && r.ctxMax
      ? Math.round((r.ctxTokens / r.ctxMax) * 1000) / 10
      : null,
    counts: r.counts,
    cost: r.cost,
    ...(r.quality ? { quality: r.quality } : {}),
    schema: 2,
  };
}

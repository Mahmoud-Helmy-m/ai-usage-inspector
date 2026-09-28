// Parse an OpenAI Codex CLI "rollout" JSONL into per-prompt turn records that
// match the shared schema (so the dashboard treats Codex and Claude identically).
// Zero dependencies.
//
// Rollout shape (Codex >= ~0.44): one JSON object per line, each
//   { timestamp, type, payload }
// where `type` is "session_meta" | "response_item" | "event_msg" | ...:
//   - session_meta            -> payload has id, cwd, cli_version, (maybe) model
//   - response_item / message -> payload.role ("user"|"assistant") + content[]
//   - event_msg / token_count -> payload.info.{ total_token_usage, last_token_usage,
//                                model_context_window }
// Token usage is cumulative in total_token_usage, so a turn's usage is the delta
// of the running total across that turn — robust to multiple model calls per turn
// (tool loops). Older flat formats (no `payload` wrapper) are tolerated.
import { vendorOf } from "../../lib/vendors/index.mjs";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../../lib/paths.mjs";
import { addCost, zeroCost } from "../../lib/pricing-core.mjs";
import { costOf, contextMax, modelInfo } from "./pricing.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The name a user gave a thread lives in Codex's session index, not the rollout.
// A thread renamed twice has two lines; the latest one is its name. One torn
// line must not hide every other thread's name.
function sessionName(sessionId) {
  let text;
  try {
    text = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }
  let latest = -Infinity;
  let name = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || entry.id !== sessionId) continue;
    const updated = Date.parse(entry.updated_at);
    if (Number.isFinite(updated) && updated >= latest) {
      latest = updated;
      name = typeof entry.thread_name === "string" && entry.thread_name.trim() ? entry.thread_name : null;
    }
  }
  return name;
}

/**
 * The ids a canonical rollout filename encodes, read the way codex-rs reads them
 * (rollout_file_name.rs): `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread-id>.jsonl`, or
 * `...-<thread-id>_<rollout-id>.jsonl` once `thread/revert` has moved the thread
 * into a new file. Any other name is not canonical and returns null.
 */
export function parseRolloutName(fileName) {
  const m = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(String(fileName || ""));
  if (!m) return null;
  const [threadId, rolloutId = threadId, extra] = m[1].split("_");
  if (extra !== undefined || !UUID_RE.test(threadId) || !UUID_RE.test(rolloutId)) return null;
  return { threadId: threadId.toLowerCase(), rolloutId: rolloutId.toLowerCase() };
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
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

// Normalize a record into { top, body, sub, role, ts }. Supports the wrapped
// ({type, payload}) and older flat formats.
function classify(rec) {
  if (!rec || typeof rec !== "object") return null;
  const top = rec.type;
  const body = rec.payload && typeof rec.payload === "object" ? rec.payload : rec;
  return {
    top,
    body,
    sub: body && body.type,
    role: body && body.role,
    ts: rec.timestamp || rec.ts || (body && body.timestamp) || null,
  };
}

function isUserMessage(c) {
  return (c.sub === "message" || c.top === "message") && c.role === "user";
}
function isUserEvent(c) {
  return c.top === "event_msg" && c.sub === "user_message";
}
function isAssistantMessage(c) {
  return (c.sub === "message" || c.top === "message") && c.role === "assistant";
}
function isTokenCount(c) {
  return c.sub === "token_count" || c.top === "token_count";
}
function isSessionMeta(c) {
  return c.top === "session_meta" || (c.body && c.body.cwd && c.body.id && !c.role);
}
// Per-turn context record — carries the model (and cwd/effort) in effect for
// the turn that follows. Lets us track mid-session model switches.
function isTurnContext(c) {
  return c.top === "turn_context" || c.sub === "turn_context";
}
function isTaskStarted(c) {
  return c.top === "event_msg" && c.sub === "task_started";
}

// Join the text out of a Responses-API content array (input_text/output_text/text).
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function userText(c) {
  if (isUserEvent(c)) return typeof c.body.message === "string" ? c.body.message : "";
  return contentText(c.body.content);
}

function normalizeSkillPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
}

// Build file-path -> display-name from the skill catalog embedded in world
// state. This preserves namespaced plugin names such as documents:documents.
function skillCatalog(recs) {
  const byPath = new Map();
  const names = new Set();
  for (const c of recs) {
    const body = c.top === "world_state" && c.body && c.body.state && c.body.state.host_skills;
    if (!body || typeof body.body !== "string") continue;
    for (const line of body.body.split("\n")) {
      const m = line.match(/^- (.+?): .* \(file: (.+?[\\/]SKILL\.md)\)\s*$/);
      if (!m) continue;
      names.add(m[1]);
      byPath.set(normalizeSkillPath(m[2]), m[1]);
    }
  }
  return { byPath, names };
}

function explicitSkills(prompt, catalog) {
  const found = new Set();
  const text = String(prompt || "");
  for (const name of catalog.names) {
    if (text.includes(`[$${name}]`) || text.includes(`$${name}`) || text.includes(`/${name}`)) {
      found.add(name);
    }
  }
  return found;
}

function collectStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function collectToolSkills(c, catalog, found) {
  if (!c || !c.body) return;
  const isToolCall = ["function_call", "local_shell_call", "custom_tool_call"].includes(c.sub);
  if (!isToolCall) return;
  const haystack = normalizeSkillPath(collectStrings(c.body).join("\n"));
  for (const [skillPath, name] of catalog.byPath) {
    if (haystack.includes(skillPath)) found.add(name);
  }
  if (c.body.name === "Skill" && c.body.input && typeof c.body.input === "object") {
    const name = c.body.input.skill || c.body.input.command || c.body.input.name;
    if (name) found.add(String(name));
  }
}

function usageVec(u) {
  u = u || {};
  return {
    input: u.input_tokens || 0,
    cached: u.cached_input_tokens || 0,
    output: u.output_tokens || 0,
    reasoning: u.reasoning_output_tokens || 0,
  };
}
const sub = (a, b) => ({
  input: Math.max(0, a.input - b.input),
  cached: Math.max(0, a.cached - b.cached),
  output: Math.max(0, a.output - b.output),
  reasoning: Math.max(0, a.reasoning - b.reasoning),
});

/**
 * Parse a rollout into an array of turn records (one per user prompt).
 * `opts.model` / `opts.cwd` / `opts.sessionId` (from the hook payload) fill in
 * fields the rollout doesn't reliably carry. Returns [] if unreadable/empty.
 */
export function buildTurns(rolloutPath, opts = {}) {
  const recs = readJsonl(rolloutPath).map(classify).filter(Boolean);
  if (!recs.length) return [];

  // Session-level metadata (rollout first, hook payload as fallback).
  let meta = {};
  for (const c of recs) if (isSessionMeta(c)) { meta = c.body; break; }
  const sessionId = opts.sessionId || meta.id || meta.session_id || null;
  const nameFromIndex = sessionName(sessionId);
  const subagent = meta.source && typeof meta.source === "object" ? meta.source.subagent : null;
  const spawn = subagent && subagent.thread_spawn;
  const parentSessionId = meta.parent_thread_id || (spawn && spawn.parent_thread_id);
  const hierarchy = parentSessionId ? {
    parentSessionId,
    agent: {
      kind: subagent && subagent.other === "guardian" ? "guardian" : "spawned",
      nickname: meta.agent_nickname ?? spawn?.agent_nickname ?? null,
      path: meta.agent_path ?? spawn?.agent_path ?? null,
      role: meta.agent_role ?? spawn?.agent_role ?? null,
      depth: spawn?.depth ?? null,
    },
  } : {};
  const cwd = meta.cwd || opts.cwd || null;
  const sessionModel =
    opts.model || meta.model || (meta.turn_context && meta.turn_context.model) || "unknown";
  const cliVersion = meta.cli_version || meta.version || null;
  // `thread/revert` continues a thread in a new rollout under the same thread id,
  // and its turns count from zero again. An id built from a position would then
  // name one of the original file's turns, so a continuation qualifies such ids
  // with its own rollout id. Decided by the file alone, so the hook and a sync
  // always agree.
  const name = typeof rolloutPath === "string" ? parseRolloutName(path.basename(rolloutPath)) : null;
  const continuation = name && sessionId
    && name.rolloutId !== String(meta.id || name.threadId).toLowerCase()
    ? name.rolloutId
    : null;

  // Segment into turns at each user message; attach the token-count deltas and
  // assistant text that follow it. `currentModel` follows turn_context records,
  // so mid-session model switches are captured per turn.
  const turns = [];
  let cur = null;
  let currentModel = sessionModel;
  let currentEffort = opts.effortLevel || null;
  let pendingTurnId = null;
  let runningTotal = { input: 0, cached: 0, output: 0, reasoning: 0 };
  // Modern Codex rollouts emit the real submitted prompt as
  // event_msg/user_message. response_item/user also contains synthetic
  // environment, policy, and approval-review context, which must not become
  // dashboard turns. Fall back to response_item/user for older rollouts.
  const hasUserEvents = recs.some(isUserEvent);
  const catalog = skillCatalog(recs);
  const spawnCalls = new Set();

  const openTurn = (c) => {
    cur = {
      turnId: pendingTurnId,
      ts: c.ts,
      endTs: c.ts,
      firstAsstTs: null,
      prompt: userText(c),
      response: "",
      model: currentModel,
      effort: currentEffort,
      skillSet: explicitSkills(userText(c), catalog),
      spawnedAgents: new Set(),
      startTotal: { ...runningTotal },
      requests: [],
      lastCtxInput: 0,
      ctxWindow: 0,
      apiCalls: 0,
      toolCalls: 0,
      thinking: 0,
    };
    turns.push(cur);
  };

  for (const c of recs) {
    if (isTurnContext(c)) {
      if (c.body.model) currentModel = c.body.model;
      if (c.body.effort) currentEffort = c.body.effort;
      // A turn_context arriving inside an open turn (before its first request
      // completes) re-scopes that turn's model.
      if (cur && cur.apiCalls === 0 && c.body.model) cur.model = c.body.model;
      if (cur && cur.apiCalls === 0 && c.body.effort) cur.effort = c.body.effort;
      continue;
    }
    if (isTaskStarted(c)) {
      pendingTurnId = c.body.turn_id || null;
      continue;
    }
    if ((hasUserEvents && isUserEvent(c)) || (!hasUserEvents && isUserMessage(c))) {
      openTurn(c);
      pendingTurnId = null;
      continue;
    }
    if (!cur) continue; // skip anything before the first user prompt
    if (c.ts) cur.endTs = c.ts;
    collectToolSkills(c, catalog, cur.skillSet);
    if (c.sub === "function_call" && /(^|\.)spawn_agent$/.test(c.body.name || "") && c.body.call_id) {
      spawnCalls.add(c.body.call_id);
    }
    // The completion item names the child; the envelope's thread_id is the parent.
    if (c.top === "event_msg" && c.sub === "item_completed") {
      const item = c.body.item;
      if (item?.type === "SubAgentActivity" && item.kind === "started"
        && spawnCalls.has(item.id) && UUID_RE.test(item.agent_thread_id)) {
        const turn = turns.find((t) => t.turnId && t.turnId === c.body.turn_id) || cur;
        turn.spawnedAgents.add(item.agent_thread_id);
      }
    }

    if (isAssistantMessage(c)) {
      cur.response += contentText(c.body.content);
      if (!cur.firstAsstTs) cur.firstAsstTs = c.ts;
    } else if (isTokenCount(c)) {
      const info = c.body.info || c.body;
      const before = runningTotal;
      if (info.total_token_usage) runningTotal = usageVec(info.total_token_usage);
      const last = usageVec(info.last_token_usage || info.total_token_usage);
      if (info.last_token_usage && (!info.total_token_usage
          || ["input", "cached", "output"].some((k) => runningTotal[k] > before[k]))) {
        cur.requests.push({ ...last, model: currentModel });
      }
      // Context occupancy = the prompt size of the most recent request this turn.
      cur.lastCtxInput = last.input || cur.lastCtxInput;
      cur.ctxWindow = info.model_context_window || cur.ctxWindow;
      cur.apiCalls++;
      if (!cur.firstAsstTs) cur.firstAsstTs = c.ts;
    } else if (c.sub === "function_call" || c.sub === "local_shell_call" || c.sub === "custom_tool_call") {
      cur.toolCalls++;
    } else if (c.sub === "reasoning") {
      cur.thinking++;
    }
  }

  // A turn's end total = the next turn's start snapshot; the last turn ends at
  // the session-final running total.
  for (let i = 0; i < turns.length; i++) {
    turns[i].endTotal = i + 1 < turns.length ? turns[i + 1].startTotal : runningTotal;
  }

  const identities = turns.map((t, index) => {
    const base = t.turnId || `${sessionId || "codex"}:${index}`;
    return { provider: "codex", sessionId, cwd,
      id: continuation && !UUID_RE.test(base) ? `${base}@${continuation}` : base };
  });
  return turns
    .map((t, i) =>
      finalizeTurn(t, {
        sessionId,
        serviceTier: (i === turns.length - 1 ? opts.hookPricing?.serviceTier : null)
          || opts.pricingForTurn?.(identities[i], identities)?.serviceTier || null,
        modelProvider: meta.model_provider,
        sessionName: nameFromIndex,
        hierarchy,
        cwd,
        cliVersion,
        index: i,
        permissionMode: opts.permissionMode || null,
        continuation,
      }),
    )
    .filter(Boolean);
}

function finalizeTurn(t, ctx) {
  // Turn usage = delta of the cumulative total across the turn.
  const d = sub(t.endTotal, t.startTotal);
  const model = t.model || "unknown";

  const tokens = {
    input: Math.max(0, d.input - d.cached), // billable (non-cached) input
    output: d.output,
    reasoning: d.reasoning,
    cacheCreate: 0,
    cacheRead: d.cached,
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const remaining = { input: tokens.input, cached: d.cached, output: d.output };
  let cost = { ...zeroCost(), source: "priced" };
  for (const request of t.requests) {
    const counts = { input: Math.max(0, request.input - request.cached), cached: request.cached, output: request.output };
    // Incomplete or inconsistent request events must never exceed cumulative deltas.
    // Keep complete requests that fit, then price the unaccounted remainder short.
    if (Object.keys(counts).some((k) => counts[k] < 0 || counts[k] > remaining[k])) continue;
    const info = modelInfo(request.model);
    const tier = (info[ctx.serviceTier] || info).long;
    cost = addCost(cost, costOf(request.model, counts, { long: !!tier && request.input > tier.threshold, modelProvider: ctx.modelProvider, serviceTier: ctx.serviceTier, promptSize: request.input }));
    for (const k of Object.keys(counts)) remaining[k] -= counts[k];
  }
  // A turn with no tokens at all is still priced once, so its cost says how it was labelled.
  if (Object.values(remaining).some((n) => n > 0) || !t.requests.length) cost = addCost(cost, costOf(model, remaining, { modelProvider: ctx.modelProvider, serviceTier: ctx.serviceTier }));

  const ctxTokens = t.lastCtxInput || d.input;
  const ctxMax = t.ctxWindow || contextMax(model);
  const startTs = t.ts;
  const endTs = t.endTs || startTs;
  const durationMs =
    startTs && endTs ? Math.max(0, Date.parse(endTs) - Date.parse(startTs)) : 0;
  const firstResponseMs =
    startTs && t.firstAsstTs ? Math.max(0, Date.parse(t.firstAsstTs) - Date.parse(startTs)) : 0;

  const baseId = t.turnId || `${ctx.sessionId || "codex"}:${ctx.index}`;
  // Codex's own turn ids are UUIDs and unique anywhere. The fallback, and the
  // `rollout-N` ids Codex synthesizes when it migrates an old rollout, are
  // positions, which a continuation file repeats.
  const qualified = ctx.continuation && !UUID_RE.test(baseId);
  return {
    id: qualified ? `${baseId}@${ctx.continuation}` : baseId,
    ...(qualified ? { legacyId: baseId } : {}),
    provider: "codex",
    sessionId: ctx.sessionId,
    sessionName: ctx.sessionName,
    sessionTitle: null,
    ...ctx.hierarchy,
    ...(t.spawnedAgents.size ? { spawnedAgents: [...t.spawnedAgents] } : {}),
    cwd: ctx.cwd,
    slug: null,
    gitBranch: null,
    cliVersion: ctx.cliVersion,
    entrypoint: null,
    ts: startTs,
    endTs,
    durationMs,
    firstResponseMs,
    prompt: t.prompt,
    promptChars: t.prompt.length,
    response: t.response,
    responseChars: t.response.length,
    model,
    vendor: vendorOf(model),
    serviceTier: ctx.serviceTier,
    speed: null,
    permissionMode: ctx.permissionMode || "default",
    effortLevel: t.effort || null,
    skills: [...t.skillSet],
    usage: tokens,
    contextTokens: ctxTokens,
    contextMax: ctxMax,
    contextFillPct: ctxMax ? Math.round((ctxTokens / ctxMax) * 1000) / 10 : 0,
    counts: {
      apiCalls: t.apiCalls,
      subagentCalls: 0,
      toolCalls: t.toolCalls,
      thinkingBlocks: t.thinking,
    },
    cost: {
      input: cost.input,
      output: cost.output,
      cacheWrite: cost.cacheWrite,
      cacheRead: cost.cacheRead,
      total: cost.total,
      source: cost.source || "priced",
      ...(cost.estimatedRate ? { estimatedRate: true } : {}),
      ...(typeof cost.relabels === "number" ? { relabels: cost.relabels } : {}),
      ...(cost.rateSource ? { rateSource: cost.rateSource } : {}),
    },
    schema: 2,
  };
}

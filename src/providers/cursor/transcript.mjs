// Parse one Cursor composer (conversation) into per-prompt turn records that
// match the shared schema. Zero dependencies (node:sqlite via store.mjs).
//
// Realities handled:
//  - Bubbles: type 1 = user, type 2 = assistant; text in `text` (may be empty
//    for tool-call bubbles). Ordering from composer.fullConversationHeadersOnly
//    when present, else DB insertion order.
//  - Token fields are version-dependent: newer builds carry per-bubble
//    `tokenUsage` ({input[Tokens], output[Tokens], cacheRead[Tokens], ...});
//    older builds carry nothing usable per bubble. When absent we estimate
//    ~4 chars/token from the text and mark the record's cost estimated.
//  - Model name often absent locally -> "cursor-auto".
//  - Bubble timestamps generally absent -> all turns stamped with the
//    composer's createdAt; durations unknowable (0).
import { vendorOf } from "../../lib/vendors/index.mjs";
import { costOf, contextMax } from "./pricing.mjs";
import { globalDbPath, readComposer } from "./store.mjs";

const est = (text) => Math.ceil(String(text || "").length / 4);

// Accept both naming styles Cursor has shipped for bubble token usage.
function bubbleUsage(b) {
  const u = b && b.tokenUsage;
  if (!u || typeof u !== "object") return null;
  const input = u.inputTokens ?? u.input ?? 0;
  const output = u.outputTokens ?? u.output ?? 0;
  const cacheRead = u.cacheReadTokens ?? u.cacheRead ?? 0;
  if (!(input > 0) && !(output > 0) && !(cacheRead > 0)) return null;
  return { input, output, cacheRead };
}

function bubbleText(b) {
  return typeof b.text === "string" ? b.text : "";
}

function orderBubbles(composer, bubbles) {
  const headers = composer && composer.fullConversationHeadersOnly;
  if (!Array.isArray(headers) || !headers.length) return bubbles;
  const byId = new Map(bubbles.map((b) => [b.bubbleId, b]));
  const ordered = [];
  for (const h of headers) {
    const id = typeof h === "string" ? h : h && h.bubbleId;
    const b = id && byId.get(id);
    if (b) {
      ordered.push(b);
      byId.delete(id);
    }
  }
  // Anything the header list missed keeps its DB order at the end.
  for (const b of bubbles) if (byId.has(b.bubbleId)) ordered.push(b);
  return ordered;
}

function findModel(composer, bubbles) {
  for (const b of bubbles) {
    const m = b.modelType || b.model;
    if (typeof m === "string" && m) return m;
  }
  const cm = composer && (composer.model || composer.modelType);
  return (typeof cm === "string" && cm) || "cursor-auto";
}

function isoOrNull(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toISOString();
  } catch {
    return null;
  }
}

/**
 * Parse a composer into turn records. `composerRef` is the provider-opaque
 * transcript reference: { composerId, cwd }. Async (SQLite via store.mjs).
 */
export async function buildTurns(composerRef, opts = {}) {
  const composerId =
    (composerRef && composerRef.composerId) ||
    (typeof composerRef === "string" ? composerRef : null);
  if (!composerId) return [];

  const { composer, bubbles } = await readComposer(globalDbPath(), composerId);
  if (!bubbles.length) return [];

  const ordered = orderBubbles(composer, bubbles);
  const model = findModel(composer, ordered);
  const cwd = opts.cwd || (composerRef && composerRef.cwd) || null;
  const createdTs = isoOrNull(composer && composer.createdAt);
  const updatedTs = isoOrNull(composer && composer.lastUpdatedAt) || createdTs;
  const sessionName = typeof composer?.name === "string" && composer.name.trim() ? composer.name : null;

  // Segment at user bubbles; attach following assistant bubbles.
  const turns = [];
  let cur = null;
  for (const b of ordered) {
    if (b.type === 1) {
      cur = { prompt: bubbleText(b), response: "", usage: null, apiCalls: 0, toolCalls: 0 };
      turns.push(cur);
      const u = bubbleUsage(b);
      if (u) cur.usage = { input: u.input, output: 0, cacheRead: u.cacheRead };
    } else if (b.type === 2 && cur) {
      cur.response += bubbleText(b);
      cur.apiCalls++;
      if (Array.isArray(b.toolFormerData)) cur.toolCalls += b.toolFormerData.length;
      else if (b.toolFormerData && typeof b.toolFormerData === "object") cur.toolCalls++;
      const u = bubbleUsage(b);
      if (u) {
        cur.usage = cur.usage || { input: 0, output: 0, cacheRead: 0 };
        cur.usage.input += u.input;
        cur.usage.output += u.output;
        cur.usage.cacheRead += u.cacheRead;
      }
    }
  }

  return turns.map((t, i) =>
    finalizeTurn(t, {
      composerId,
      sessionName,
      cwd,
      model,
      index: i,
      last: i === turns.length - 1,
      createdTs,
      updatedTs,
    }),
  );
}

function finalizeTurn(t, ctx) {
  // Real per-bubble usage when present; otherwise estimate both sides from
  // text length and flag the cost as approximate.
  let input, output, cacheRead;
  let estimated = false;
  if (t.usage && (t.usage.input > 0 || t.usage.output > 0)) {
    input = t.usage.input;
    output = t.usage.output;
    cacheRead = t.usage.cacheRead || 0;
    if (!(output > 0) && t.response) {
      output = est(t.response);
      estimated = true;
    }
  } else {
    input = est(t.prompt);
    output = est(t.response);
    cacheRead = 0;
    estimated = true;
  }

  const tokens = {
    input,
    output,
    reasoning: 0,
    cacheCreate: 0,
    cacheRead,
    cacheCreate1h: 0,
    cacheCreate5m: 0,
    webSearch: 0,
    webFetch: 0,
  };
  const cost = costOf(ctx.model, { input, cached: cacheRead, output });

  const ctxTokens = input + cacheRead;
  const ctxMax = contextMax(ctx.model);
  const ts = ctx.createdTs;
  const endTs = ctx.last ? ctx.updatedTs || ts : ts;

  // Two independent reasons a cost can be approximate: tokens we derived from
  // text length, or a model we have no listed rate for (costOf says which).
  const approx = estimated || cost.source === "estimated";
  const costOut = {
    input: cost.input,
    output: cost.output,
    cacheWrite: 0,
    cacheRead: cost.cacheRead,
    total: cost.total,
    source: approx ? "estimated" : "priced",
  };
  if (approx) costOut.estimated = true;
  if (cost.estimatedRate) costOut.estimatedRate = true;

  return {
    id: `${ctx.composerId}:${ctx.index}`,
    provider: "cursor",
    sessionId: ctx.composerId,
    sessionName: ctx.sessionName,
    sessionTitle: null,
    cwd: ctx.cwd,
    slug: null,
    gitBranch: null,
    cliVersion: null,
    entrypoint: null,
    ts,
    endTs,
    durationMs: 0, // bubble-level timestamps aren't stored; unknowable
    firstResponseMs: 0,
    prompt: t.prompt,
    promptChars: t.prompt.length,
    response: t.response,
    responseChars: t.response.length,
    model: ctx.model,
    vendor: vendorOf(ctx.model),
    serviceTier: null,
    speed: null,
    permissionMode: "default",
    effortLevel: null,
    skills: [],
    usage: tokens,
    contextTokens: ctxTokens,
    contextMax: ctxMax,
    contextFillPct: ctxMax ? Math.round((ctxTokens / ctxMax) * 1000) / 10 : null,
    counts: {
      apiCalls: t.apiCalls,
      subagentCalls: 0,
      toolCalls: t.toolCalls,
      thinkingBlocks: 0,
    },
    cost: costOut,
    schema: 2,
  };
}

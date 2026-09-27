// OpenAI model pricing for the Codex provider. USD per 1,000,000 tokens.
// Source: OpenAI API pricing page (verified 2026-07). OpenAI has no machine-
// readable pricing source like Claude's docs .md, so this table is hardcoded;
// a dynamic refresh can be added later if a clean source appears.
//
// OpenAI cost model is simpler than Claude's: standard input, a discounted
// cached-input read, and output (which already includes reasoning tokens).
// There is no 5m/1h cache-write tier — so the shared cost object carries
// cacheWrite: 0 and cacheRead = cached-input cost.
import { M, zeroCost } from "../../lib/pricing-core.mjs";
import { readCachedRates } from "./remote-pricing.mjs";

export { zeroCost };

// { input, cachedInput, output, contextMax } per model.
function model(input, cachedInput, output, ctx) {
  return { input, cachedInput, output, contextMax: ctx };
}

// Keyed by normalized model slug (date suffix stripped — see normalize()).
const TABLE = {
  "gpt-5.5": model(5, 0.5, 30, 400_000),
  "gpt-5.5-pro": model(30, 3, 180, 400_000),
  "gpt-5.4": model(2.5, 0.25, 15, 400_000),
  "gpt-5.4-mini": model(0.75, 0.075, 4.5, 400_000),
  "gpt-5.4-nano": model(0.2, 0.02, 1.25, 400_000),
  "gpt-5.4-pro": model(30, 3, 180, 400_000),
  "gpt-5.3-codex": model(1.75, 0.175, 14, 400_000),
  "chat-latest": model(5, 0.5, 30, 400_000),
};

// Unknown Codex models default to the codex-tier rate. That rate is a guess, so
// costs derived from it are labelled "estimated" rather than "priced".
const FALLBACK = { ...model(1.75, 0.175, 14, 400_000), estimated: true };

// Rates fetched from models.dev (see remote-pricing.mjs), keyed like TABLE.
// Applied at import from the on-disk cache the viewer refreshes — so newly
// recorded turns price at current rates, hook stays offline.
let OVERRIDES = {};

/** Merge fetched { id: { input, cachedInput, output, contextMax? } } over TABLE. */
export function applyRemoteRates(rates) {
  if (!rates) return;
  for (const [id, r] of Object.entries(rates)) {
    if (!r || !(r.input >= 0) || !(r.output >= 0)) continue;
    const cachedKnown = r.cachedInput >= 0 && !r.cachedGuessed;
    const cached = cachedKnown ? r.cachedInput : r.input * 0.1;
    const ctx =
      r.contextMax > 0
        ? r.contextMax
        : (TABLE[id] && TABLE[id].contextMax) || FALLBACK.contextMax;
    OVERRIDES[id] = { ...model(r.input, cached, r.output, ctx), cachedGuessed: !cachedKnown };
  }
}

try {
  applyRemoteRates(readCachedRates());
} catch {}

/** Strip a trailing dated snapshot from an OpenAI slug (e.g. -2026-03-01 / -20260301). */
export function normalize(modelId) {
  return String(modelId || "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

export function knownModel(modelId) {
  const id = normalize(modelId);
  return Object.hasOwn(OVERRIDES, id) || Object.hasOwn(TABLE, id);
}

export function modelInfo(modelId) {
  const id = normalize(modelId);
  return OVERRIDES[id] || TABLE[id] || FALLBACK;
}

export function contextMax(modelId) {
  return modelInfo(modelId).contextMax;
}

/**
 * Cost (USD) of one turn's token deltas. `tokens` carries raw counts:
 *   input  — billable input tokens (already excluding cached)
 *   cached — cached input tokens (billed at the discounted cached rate)
 *   output — output tokens (already includes reasoning tokens)
 * Returns the shared cost object { input, output, cacheRead, cacheWrite, total }.
 */
export function costOf(modelId, tokens) {
  if (!tokens) return { ...zeroCost(), source: "priced" };
  const r = modelInfo(modelId);
  const input = (Math.max(0, tokens.input || 0) * r.input) / M;
  const cacheRead = (Math.max(0, tokens.cached || 0) * r.cachedInput) / M;
  const output = (Math.max(0, tokens.output || 0) * r.output) / M;
  const guessedRate = !!r.estimated || (!!r.cachedGuessed && cacheRead > 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    total: input + cacheRead + output,
    source: guessedRate ? "estimated" : "priced",
    ...(guessedRate ? { estimatedRate: true } : {}),
  };
}

// Cursor model pricing. USD per 1,000,000 tokens.
// Source: cursor.com/docs/models-and-pricing (verified 2026-07). Cursor bills
// per token at the rates it publishes per model; there is no local record of
// actual charged cost, so these rates × (sometimes estimated) token counts are
// an approximation — records built from estimates carry cost.estimated: true.
//
// No cache-write tier; cached input reads priced at ~10% of input.
import { isGlm, knownContextMax as zaiContextMax } from "../../lib/vendors/zai/pricing.mjs";
import { M, zeroCost } from "../../lib/pricing-core.mjs";
import { readCachedRates } from "./remote-pricing.mjs";

export { zeroCost };

function model(input, cachedInput, output, ctx) {
  return { input, cachedInput, output, contextMax: ctx };
}

// Keyed by normalized id (lowercased, spaces->dashes, parentheticals dropped).
const TABLE = {
  "cursor-auto": model(1.25, 0.125, 6, 200_000),
  "composer-2.5": model(0.5, 0.05, 2.5, 200_000),
  "claude-sonnet-5": model(3, 0.3, 15, 1_000_000),
  "claude-4.6-sonnet": model(3, 0.3, 15, 1_000_000),
  "claude-4.6-opus": model(5, 0.5, 25, 1_000_000),
  "claude-4.7-opus": model(5, 0.5, 25, 1_000_000),
  "claude-fable-5": model(10, 1, 50, 1_000_000),
  "gpt-5.5": model(5, 0.5, 30, 400_000),
  "gpt-5.4": model(2.5, 0.25, 15, 400_000),
};

// Unknown models default to the Auto pool rate (Cursor's most common mode).
// That rate is a guess, so costs derived from it are labelled "estimated".
const FALLBACK = { ...model(1.25, 0.125, 6, 200_000), estimated: true };

// Rates fetched from cursor.com's pricing docs (see remote-pricing.mjs),
// applied at import from the on-disk cache the viewer refreshes.
let OVERRIDES = {};

/** Merge fetched { id: { input, cachedInput, output } } over TABLE. */
export function applyRemoteRates(rates) {
  if (!rates) return;
  for (const [id, r] of Object.entries(rates)) {
    if (!r || !(r.input >= 0) || !(r.output >= 0)) continue;
    const cachedKnown = r.cachedInput >= 0 && !r.cachedGuessed;
    const cached = cachedKnown ? r.cachedInput : r.input * 0.1;
    const ctx = (TABLE[id] && TABLE[id].contextMax) || FALLBACK.contextMax;
    OVERRIDES[id] = { ...model(r.input, cached, r.output, ctx), cachedGuessed: !cachedKnown };
  }
}

try {
  applyRemoteRates(readCachedRates());
} catch {}

/** Lowercase, spaces->dashes, parentheticals + date suffixes stripped. */
export function normalize(modelId) {
  return String(modelId || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "");
}

export function modelInfo(modelId) {
  const id = normalize(modelId);
  return OVERRIDES[id] || TABLE[id] || FALLBACK;
}

export function contextMax(modelId) {
  const id = normalize(modelId);
  if (isGlm(id) && !TABLE[id]) return zaiContextMax(id);
  return modelInfo(modelId).contextMax;
}

/**
 * Cost (USD) of one turn's tokens: { input (non-cached), cached, output }.
 * Returns the shared cost object.
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

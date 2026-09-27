// OpenAI Standard API pricing, verified 2026-09. USD per 1,000,000 tokens.
// Source: developers.openai.com/api/docs/pricing.md; cached rates override this table.
import { M, zeroCost } from "../../lib/pricing-core.mjs";
import { readCachedRates, LONG_CONTEXT_THRESHOLD } from "./remote-pricing.mjs";

export { zeroCost };

// Per-MTok prices, optional long tier and context window per model.
function model(input, cachedInput, output, ctx, cacheWrite = null, long = null) {
  return { input, cachedInput, output, contextMax: ctx, cacheWrite, long };
}
const tier = (input, cachedInput, output, cacheWrite = null) => ({ input, cachedInput, cacheWrite, output, threshold: LONG_CONTEXT_THRESHOLD });

// Keyed by normalized model slug (date suffix stripped — see normalize()).
const TABLE = {
  "gpt-6-astra": model(10, 1, 50, 1_050_000, 12.5, tier(20, 2, 75, 25)),
  "gpt-6-sol": model(2, 0.2, 10, 1_050_000, 2.5, tier(4, 0.4, 15, 5)),
  "gpt-6-luna": model(0.1, 0.01, 0.5, 1_050_000, 0.125, tier(0.2, 0.02, 0.75, 0.25)),
  "gpt-5.6-sol": model(4, 0.4, 20, 1_050_000, 5, tier(8, 0.8, 30, 10)),
  "gpt-5.6-terra": model(2, 0.2, 12, 1_050_000, 2.5, tier(4, 0.4, 18, 5)),
  "gpt-5.6-luna": model(0.2, 0.02, 1.2, 1_050_000, 0.25, tier(0.4, 0.04, 1.8, 0.5)),
  "gpt-5.5": model(5, 0.5, 30, 1_050_000, null, tier(10, 1, 45)),
  "gpt-5.5-pro": model(30, 30, 180, 1_050_000, null, tier(60, 60, 270)),
  "gpt-5.4": model(2.5, 0.25, 15, 1_050_000, null, tier(5, 0.5, 22.5)),
  "gpt-5.4-mini": model(0.75, 0.075, 4.5, 400_000),
  "gpt-5.4-nano": model(0.2, 0.02, 1.25, 400_000),
  "gpt-5.4-pro": model(30, 30, 180, 1_050_000, null, tier(60, 60, 270)),
  "gpt-5.3-codex": model(1.75, 0.175, 14, 400_000),
  "chat-latest": model(5, 0.5, 30, 400_000),
};

// Unknown Codex models default to the codex-tier rate. That rate is a guess, so
// costs derived from it are labelled "estimated" rather than "priced".
const FALLBACK = { ...model(1.75, 0.175, 14, 400_000), estimated: true };

// Fetched OpenAI rates, supplemented by models.dev for missing ids, keyed like TABLE.
// Applied at import from the on-disk cache the viewer refreshes — so newly
// recorded turns price at current rates, hook stays offline.
let OVERRIDES = {};
const price = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const GUESSED = new Set();
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*$/;
export function guessedModels() { return [...GUESSED]; }
export function clearGuessedModels() { GUESSED.clear(); }
export function pricedModel(modelId) {
  const r = modelInfo(modelId);
  return !r.estimated && !r.cachedGuessed;
}

/** Merge fetched { id: { input, cachedInput, output, contextMax? } } over TABLE. */
export function applyRemoteRates(rates) {
  if (!rates) return;
  for (const [id, r] of Object.entries(rates)) {
    if (!r || !price(r.input) || !price(r.output)) continue;
    const cachedKnown = price(r.cachedInput) && !r.cachedGuessed;
    const cached = cachedKnown ? r.cachedInput : r.input * 0.1;
    const ctx =
      r.contextMax > 0
        ? r.contextMax
        : (TABLE[id] && TABLE[id].contextMax) || FALLBACK.contextMax;
    const long = r.long && ["input", "cachedInput", "output", "threshold"].every((k) => price(r.long[k])) ? { ...r.long } : null;
    OVERRIDES[id] = { ...model(r.input, cached, r.output, ctx, r.cacheWrite ?? null, long), cachedGuessed: !cachedKnown };
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
export function costOf(modelId, tokens, { long = false } = {}) {
  if (!tokens) return { ...zeroCost(), source: "priced" };
  const info = modelInfo(modelId);
  const r = long && info.long ? info.long : info;
  const input = (Math.max(0, tokens.input || 0) * r.input) / M;
  const cacheRead = (Math.max(0, tokens.cached || 0) * r.cachedInput) / M;
  const output = (Math.max(0, tokens.output || 0) * r.output) / M;
  const guessedRate = !!r.estimated || (!!r.cachedGuessed && (tokens.cached || 0) > 0);
  if (guessedRate && [tokens.input, tokens.cached, tokens.output].some((n) => n > 0)) {
    const id = normalize(String(modelId || "").trim().toLowerCase());
    if (MODEL_ID.test(id) && id !== "unknown") GUESSED.add(id);
  }
  return {
    input,
    output,
    cacheRead,
    // Rollouts do not report cache-write tokens; rates are kept for a future parser.
    cacheWrite: 0,
    total: input + cacheRead + output,
    source: guessedRate ? "estimated" : "priced",
    ...(guessedRate ? { estimatedRate: true } : {}),
  };
}

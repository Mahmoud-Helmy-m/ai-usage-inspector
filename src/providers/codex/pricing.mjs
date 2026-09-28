// OpenAI API pricing, verified 2026-09. USD per 1,000,000 tokens.
// Source: developers.openai.com/api/docs/pricing.md; cached rates override this table.
import { M, zeroCost } from "../../lib/pricing-core.mjs";
import { readCachedRates, LONG_CONTEXT_THRESHOLD } from "./remote-pricing.mjs";
import { lookup, providerForId } from "../../lib/vendors/modelsdev/pricing.mjs";

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

Object.assign(TABLE["gpt-6-astra"], {
  fast: model(20, 2, 100, 1_050_000, 25, tier(40, 4, 150, 50)),
  flex: model(5, 0.5, 25, 1_050_000, 6.25, tier(10, 1, 37.5, 12.5)),
});
TABLE["gpt-6-sol"].fast = model(4, 0.4, 20, 1_050_000, 5, tier(8, 0.8, 30, 10));
TABLE["gpt-5.6-sol"].fast = model(8, 0.8, 40, 1_050_000, 10, tier(16, 1.6, 60, 20));
Object.assign(TABLE["gpt-5.5"], {
  fast: model(12.5, 1.25, 75, 1_050_000),
  flex: model(2.5, 0.25, 15, 1_050_000, null, tier(5, 0.5, 22.5)),
});

// Unknown Codex models default to the codex-tier rate. That rate is a guess, so
// costs derived from it are labelled "estimated" rather than "priced".
const FALLBACK = { ...model(1.75, 0.175, 14, 400_000), estimated: true };

// Fetched OpenAI rates, supplemented by models.dev for missing ids, keyed like TABLE.
// Applied at import from the on-disk cache the viewer refreshes — so newly
// recorded turns price at current rates, hook stays offline.
let OVERRIDES = {};
const price = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const GUESSED = new Set();
const MODEL_ID = /^[a-z0-9][a-z0-9._/@:-]*$/;
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
    for (const service of ["fast", "flex"]) {
      const rate = r[service] || TABLE[id]?.[service];
      if (rate && price(rate.input) && price(rate.output)) OVERRIDES[id][service] = { ...rate };
    }
    if (r.tiers) OVERRIDES[id].tiers = r.tiers;
    if (r.source === "models.dev") OVERRIDES[id].rateSource = "models.dev";
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
  return Object.hasOwn(OVERRIDES, modelId) || Object.hasOwn(OVERRIDES, id) || Object.hasOwn(TABLE, id);
}

export function modelInfo(modelId, promptSize = 0) {
  const id = normalize(modelId);
  const override = OVERRIDES[modelId] || OVERRIDES[id];
  if (override && override.rateSource !== "models.dev") return override;
  if (TABLE[id]) return TABLE[id];
  // A shared refresh may fill a missing cache price even when OpenAI returns 304
  // and its supplemental copy is unchanged. Observe that price before the old copy.
  const extra = lookup(modelId, null, promptSize) || lookup(modelId, ["openai"], promptSize) || lookup(id, ["openai"], promptSize);
  if (extra?.provider === "openai") return { ...extra,
    cachedInput: extra.cacheRead ?? extra.input * (extra.size ? 1 : 0.1), cachedGuessed: extra.cacheRead == null };
  if (!extra && override) {
    const tier = override.tiers?.filter((r) => promptSize > r.size).at(-1);
    return tier ? { ...override, ...tier, cachedInput: tier.cacheRead ?? tier.input, cachedGuessed: tier.cacheRead == null } : override;
  }
  // Another lab's model: a missing cache-hit price bills hits at input, flagged as a guess.
  return extra ? { ...extra, cachedInput: extra.cacheRead ?? extra.input, cachedGuessed: extra.cacheRead == null }
    : override || FALLBACK;
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
export function costOf(modelId, tokens, { long = false, modelProvider = null, serviceTier = null, promptSize = 0 } = {}) {
  if (["ollama", "lmstudio", "oss"].includes(modelProvider)) return { ...zeroCost(), source: "priced", rateSource: "local" };
  if (!tokens) return { ...zeroCost(), source: "priced" };
  const info = modelInfo(modelId, promptSize);
  const service = serviceTier === "fast" || serviceTier === "flex" ? serviceTier : null;
  const selected = (service && info[service]) || info;
  const missingTier = service && !info[service];
  const r = long && selected.long ? selected.long : selected;
  const input = (Math.max(0, tokens.input || 0) * r.input) / M;
  const cacheRead = (Math.max(0, tokens.cached || 0) * r.cachedInput) / M;
  const output = (Math.max(0, tokens.output || 0) * r.output) / M;
  const used = [tokens.input, tokens.cached, tokens.output].some((n) => n > 0);
  // No tokens cost nothing at any rate: nothing about them is a guess. Before 2.11.1 such a
  // turn could be labelled estimated; `relabels` lets the store drop that label while keeping
  // the amount (Codex costs carry no rate revision, so any value works).
  const guessedRate = ((!!r.estimated || missingTier) && used) || (!!r.cachedGuessed && (tokens.cached || 0) > 0);
  if (guessedRate && used) {
    const raw = String(modelId || "").trim().toLowerCase();
    const id = providerForId(raw) ? raw : normalize(raw);
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
    ...(info.rateSource ? { rateSource: info.rateSource } : {}),
    ...(!used ? { relabels: 1 } : {}),
  };
}

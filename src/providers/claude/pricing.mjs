// Model -> context window + USD pricing, and a per-usage cost calculator.
// Prices are USD per 1,000,000 tokens. The table below is the built-in
// fallback; current rates and context windows fetched from Claude's docs
// override it when available (see remote-pricing.mjs / applyRemoteRates).
// Cache writes: 5m = 1.25x input, 1h = 2x input. Cache reads = 0.1x input,
// except where a model publishes its own cache prices.
import { isGlm, modelInfo as zaiModelInfo } from "../../lib/vendors/zai/pricing.mjs";
import { M, zeroCost, addCost } from "../../lib/pricing-core.mjs";
import { readCachedRates, readCachedWindows } from "./remote-pricing.mjs";
import { lookup, platformOf, anthropicId } from "../../lib/vendors/modelsdev/pricing.mjs";

// Which version of this table a cost was worked out under. Costs carry it, so a
// correction can name the models it corrected and the revision it arrived in:
// a stored cost from before that revision is worked out again on the next read
// instead of being kept. Stored costs are otherwise never rewritten — what a
// turn cost at the time stands — but these were never Anthropic's prices.
// Revision 4 changed no rate: it stopped a message with no tokens marking its turn estimated.
// Revision 5 corrects fast messages previously billed at standard rates.
export const RATES_REVISION = 5;
const CORRECTED_IN = {
  // Missing from the table before revision 2. Without fetched rates they were
  // priced at the Opus-tier guess — Sonnet 5 2.5x too high, Fable and Mythos 5.1
  // at half — and labelled estimated even where the guess happened to be right.
  "claude-opus-5": 2,
  "claude-sonnet-5": 2,
  // Cache hits on these are 0.025x input, not 0.1x: priced four times too high
  // with or without fetched rates, which only ever carried input and output.
  "claude-fable-5-1": 2,
  "claude-mythos-5-1": 2,
};

export { zeroCost, addCost };

// Per-MTok rates. Cache prices follow input by the standard multipliers unless a
// model publishes its own: Fable 5.1 and Mythos 5.1 price cache hits at 0.025x.
// `windowKnown` says whether contextMax is the model's real window or a guess.
// It is separate from `estimated`, which is about the rate: a model can have a
// fetched price and no known window, or a fetched window and a guessed price.
function model(input, output, ctx, { cacheWrite5m, cacheWrite1h, cacheRead, fast, fastStandard } = {}, windowKnown = true) {
  return {
    input,
    output,
    cacheWrite5m: cacheWrite5m ?? input * 1.25,
    cacheWrite1h: cacheWrite1h ?? input * 2,
    cacheRead: cacheRead ?? input * 0.1,
    contextMax: ctx,
    windowKnown,
    ...(fast ? { fast } : {}),
    ...(fastStandard ? { fastStandard } : {}),
  };
}

// Keyed by normalized model id (date suffix stripped, see normalize()).
// Figures from Anthropic's pricing and models pages; fast rates checked 2026-09-28.
const TABLE = {
  "claude-fable-5-1": model(10, 50, 1_000_000, { cacheRead: 0.25 }),
  "claude-mythos-5-1": model(10, 50, 1_000_000, { cacheRead: 0.25 }),
  "claude-fable-5": model(10, 50, 1_000_000),
  "claude-mythos-5": model(10, 50, 1_000_000),
  "claude-opus-5-5": model(4, 20, 1_000_000, { cacheRead: 0.2, fast: { input: 8, output: 40 } }),
  "claude-opus-5": model(5, 25, 1_000_000, { fast: { input: 10, output: 50 } }),
  "claude-sonnet-5": model(2, 10, 1_000_000),
  "claude-opus-4-8": model(5, 25, 1_000_000, { fast: { input: 10, output: 50 } }),
  "claude-opus-4-7": model(5, 25, 1_000_000),
  "claude-opus-4-6": model(5, 25, 1_000_000, { fastStandard: true }),
  "claude-opus-4-5": model(5, 25, 200_000),
  "claude-opus-4-1": model(15, 75, 200_000),
  "claude-sonnet-4-6": model(3, 15, 1_000_000),
  "claude-sonnet-4-5": model(3, 15, 200_000),
  "claude-haiku-4-5": model(1, 5, 200_000),
};

// Unknown Claude models fall back to the current Opus tier. The rate is a
// guess, so entries built from it carry `estimated` and any cost derived from
// them is labelled "estimated" rather than "priced". The window is a guess too.
const FALLBACK = { ...model(5, 25, 200_000, {}, false), estimated: true };

// Rates and context windows fetched from the docs, keyed like TABLE. Applied at
// import from the on-disk cache; the viewer, install and sync refresh that
// cache, so newly recorded turns price and fill against current figures.
let OVERRIDES = {};

const price = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const tokens = (n) => typeof n === "number" && Number.isFinite(n) && n >= 1_000;
const CACHE_KEYS = ["cacheWrite5m", "cacheWrite1h", "cacheRead"];

/**
 * Merge fetched rates ({ id: { input, output, cacheWrite5m?, cacheWrite1h?,
 * cacheRead? } }) and context windows ({ id: tokens }) over what is known of each
 * model: an earlier override, else the built-in entry, else the fallback. A price
 * and a window are taken independently, so a refresh that brings only one of them
 * never discards the other. A non-numeric or negative figure is ignored, never
 * poisoning a model's pricing.
 */
export function applyRemoteRates(rates, windows) {
  const r = rates && typeof rates === "object" ? rates : {};
  const w = windows && typeof windows === "object" ? windows : {};
  for (const id of new Set([...Object.keys(r), ...Object.keys(w)])) {
    const known = OVERRIDES[id] || TABLE[id] || null;
    const current = known || FALLBACK;
    const fetched = r[id];
    const hasPrice = Boolean(fetched && price(fetched.input) && price(fetched.output));
    const hasWindow = tokens(w[id]);
    if (!hasPrice && !hasWindow) continue;
    const ctx = hasWindow ? w[id] : current.contextMax;
    const windowKnown = hasWindow || Boolean(known && known.windowKnown);
    if (hasPrice) {
      // A cache price the page did not give keeps this model's own ratio to input,
      // never the generic one: Fable 5.1's cache hits stay at 0.025x of whatever
      // input is fetched. Only a model nothing is known about takes the default.
      const cache = {};
      for (const key of CACHE_KEYS) {
        cache[key] = price(fetched[key])
          ? fetched[key]
          : known && known.input > 0 ? fetched.input * (known[key] / known.input) : undefined;
      }
      OVERRIDES[id] = model(fetched.input, fetched.output, ctx, cache, windowKnown);
      if (price(fetched.fast?.input) && price(fetched.fast?.output)) OVERRIDES[id].fast = { ...fetched.fast };
      else if (known?.fast) OVERRIDES[id].fast = known.fast;
      if (known?.fastStandard) OVERRIDES[id].fastStandard = true;
    } else {
      // A window without a price: whatever rates are already known — an earlier
      // fetch, the built-in entry, or still the guess — with the window now known.
      OVERRIDES[id] = { ...current, contextMax: ctx, windowKnown };
    }
  }
}

// Seed overrides from whatever was last cached. Best-effort; the hook stays
// fully offline (no fetch here, just a local file read).
try {
  applyRemoteRates(readCachedRates(), readCachedWindows());
} catch {}

/** Platform aliases share Anthropic's windows and fallback rates. */
export function normalize(modelId) {
  return anthropicId(modelId);
}

/** Whether the Anthropic table or its fetched overrides know this model. */
export function knownModel(modelId) {
  const id = normalize(modelId);
  return Object.hasOwn(OVERRIDES, id) || Object.hasOwn(TABLE, id);
}

export function modelInfo(modelId, promptSize = 0) {
  // Unknown GLM keeps the provider's explicit estimated fallback, never its window guess.
  if (isGlm(modelId)) return zaiModelInfo(modelId) || { ...FALLBACK, contextMax: null };
  const id = normalize(modelId);
  const platform = platformOf(modelId);
  const extra = platform || !id.startsWith("claude-") ? lookup(modelId, null, promptSize) : null;
  if (extra) {
    const standard = OVERRIDES[id] || TABLE[id];
    // Claude on Bedrock or Vertex keeps Anthropic's cache multipliers (5m write 1.25x, 1h write
    // 2x, the model's own hit ratio) on the platform's input price; models.dev lists only one
    // write price, which would bill 1h writes as 5m ones. Other vendors' models use what the
    // lab publishes; a missing cache-hit price stays null, so hits are billed at input and
    // labelled estimated rather than passed off as looked up. Explicit context tiers
    // also use their own cache prices, never a ratio inherited from the base tier.
    if (platform && !extra.size && standard && standard.input > 0) {
      const scale = extra.input / standard.input;
      return { ...extra, cacheWrite5m: standard.cacheWrite5m * scale, cacheWrite1h: standard.cacheWrite1h * scale,
        cacheRead: standard.cacheRead * scale, contextMax: standard.contextMax, windowKnown: !!standard.windowKnown };
    }
    return { ...extra, cacheWrite5m: extra.cacheWrite ?? extra.input,
      cacheWrite1h: extra.cacheWrite ?? extra.input, cacheRead: extra.cacheRead ?? null,
      ...(platform ? { contextMax: standard?.contextMax || null, windowKnown: !!standard?.windowKnown } : {}) };
  }
  return OVERRIDES[id] || TABLE[id] || FALLBACK;
}

/** Whether a model is priced from a real rate — Anthropic's, fetched, or z.ai's — rather than a guess. */
export function pricedModel(modelId) {
  return !modelInfo(modelId).estimated;
}

// Models this process had to price by guess, so the worker knows to refresh rates now rather
// than at the next twelve-hourly refresh. Only ids that look like a model and only turns that
// used tokens: Claude Code writes "<synthetic>" for messages no model produced.
const GUESSED = new Set();
const MODEL_ID = /^[a-z0-9][a-z0-9._/@:-]*$/;
export function guessedModels() {
  return [...GUESSED];
}
export function clearGuessedModels() {
  GUESSED.clear();
}

/** Context window (tokens) for a model id. */
export function contextMax(modelId) {
  return modelInfo(modelId).contextMax;
}

/** The window of a model this version actually knows — never the fallback guess. */
export function knownContextMax(modelId) {
  const info = modelInfo(modelId);
  return info.windowKnown ? info.contextMax : null;
}

/**
 * Cost (USD) of one assistant message's usage, priced at that message's model.
 * `usage` is the Anthropic usage object from the transcript.
 */
export function costOf(modelId, usage, { endpoint = null } = {}) {
  if (endpoint === "local") return { ...zeroCost(), source: "priced", rateSource: "local" };
  if (!usage) return { ...zeroCost(), source: "priced" };
  const promptSize = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens ?? ((usage.cache_creation?.ephemeral_5m_input_tokens || 0) + (usage.cache_creation?.ephemeral_1h_input_tokens || 0)));
  let r = modelInfo(modelId, promptSize);
  const fast = usage.speed === "fast" && !platformOf(modelId);
  const fastPriced = fast && r.fast && r.input > 0;
  if (fastPriced) {
    // Preserve each model's published cache ratios, including Opus 5.5's 0.05x hit.
    const scale = r.fast.input / r.input;
    r = { ...r, ...r.fast, cacheWrite5m: r.cacheWrite5m * scale,
      cacheWrite1h: r.cacheWrite1h * scale, cacheRead: r.cacheRead * scale };
  } else if (fast && !r.fastStandard) r = { ...r, estimated: true };
  const cc = usage.cache_creation || {};
  // If no breakdown, treat all cache_creation as 5m (the common case).
  const c1h = cc.ephemeral_1h_input_tokens || 0;
  const c5m =
    cc.ephemeral_5m_input_tokens != null
      ? cc.ephemeral_5m_input_tokens
      : Math.max(0, (usage.cache_creation_input_tokens || 0) - c1h);

  const input = ((usage.input_tokens || 0) * r.input) / M;
  const output = ((usage.output_tokens || 0) * r.output) / M;
  const cacheRead = ((usage.cache_read_input_tokens || 0) * (r.cacheRead ?? r.input)) / M;
  const cacheWrite = (c5m * r.cacheWrite5m + c1h * r.cacheWrite1h) / M;
  const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
    + (usage.cache_read_input_tokens || 0) + c1h + c5m;
  // No tokens cost nothing at any rate, so nothing about them is a guess — a "<synthetic>"
  // message, which Claude Code writes for an API error or an interruption, marked its
  // whole turn estimated before revision 4.
  const estimated = (r.estimated && tokens > 0) || (r.cacheRead === null && (usage.cache_read_input_tokens || 0) > 0);
  if (r.estimated && input + output + cacheRead + cacheWrite > 0) {
    const raw = String(modelId || "").trim().toLowerCase();
    const id = !platformOf(raw) && raw.startsWith("claude-") ? normalize(raw) : raw;
    if (MODEL_ID.test(id) && id !== "unknown") GUESSED.add(id);
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    source: estimated ? "estimated" : "priced",
    ...(estimated ? { estimatedRate: true } : {}),
    ...(r.rateSource ? { rateSource: r.rateSource } : {}),
    rates: RATES_REVISION,
    // A stored cost from before revision 4 that holds such a message may carry that label
    // wrongly; the store takes the new label when the amount is unchanged (see store.mjs).
    ...(tokens === 0 ? { relabels: 4 } : {}),
    ...(isGlm(modelId) && zaiModelInfo(modelId) ? { supersedes: 3 } : {}),
    ...(CORRECTED_IN[normalize(modelId)] ? { supersedes: CORRECTED_IN[normalize(modelId)] } : {}),
    ...(fastPriced ? { supersedes: 5 } : {}),
  };
}

// z.ai model vendor rates, USD per million tokens. Agents keep their identity.
// Context windows are bundled only: the pricing page does not publish them.
import { readCachedRates } from "./remote-pricing.mjs";

export const normalize = (id) => String(id || "").trim().toLowerCase().split("/").pop();
export const isGlm = (id) => /^glm-/.test(normalize(id));

function model(input, cacheRead, output, contextMax = null) {
  // Cached Input Storage is currently "Limited-time Free", for both lifetimes.
  return { input, cacheRead, output, cacheWrite5m: 0, cacheWrite1h: 0,
    contextMax, windowKnown: contextMax !== null };
}

const TABLE = {
  "glm-5.3": model(1.4, 0.26, 4.4, 1_000_000),
  "glm-5.3-flash": model(0.15, 0.03, 0.50, 1_000_000),
  "glm-5.3-flashx": model(0.37, 0.075, 1.25, 1_000_000),
  "glm-5.2": model(1.4, 0.26, 4.4),
  "glm-5.1": model(1.4, 0.26, 4.4, 200_000),
  "glm-5": model(1.0, 0.2, 3.2, 200_000),
  "glm-4.7": model(0.6, 0.11, 2.2, 200_000),
  "glm-4.7-flashx": model(0.07, 0.01, 0.4, 200_000),
  "glm-4.7-flash": model(0, 0, 0, 200_000),
  "glm-4.6": model(0.6, 0.11, 2.2, 200_000),
  "glm-4.6v": model(0.3, 0.05, 0.9),
  "glm-4.6v-flashx": model(0.04, 0.004, 0.4),
  "glm-4.6v-flash": model(0, 0, 0),
  "glm-4.5": model(0.6, 0.11, 2.2),
  "glm-4.5-x": model(2.2, 0.45, 8.9),
  "glm-4.5-air": model(0.2, 0.03, 1.1),
  "glm-4.5-airx": model(1.1, 0.22, 4.5),
  "glm-4.5-flash": model(0, 0, 0),
  "glm-4.5v": model(0.6, 0.11, 1.8),
  // No published cache-read rate (dash), not a promise of free caching.
  "glm-4-32b-0414-128k": model(0.1, null, 0.1, 128_000),
};
const OVERRIDES = Object.create(null);
const price = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Complete fetched rows only; partial/malformed data never degrades a model.
 * Windows stay built-in, including null for newly published models. */
export function applyRemoteRates(rates) {
  for (const [key, r] of Object.entries(rates || {})) {
    const id = normalize(key);
    if (!isGlm(id) || !r || ![r.input, r.output, r.cacheWrite5m, r.cacheWrite1h].every(price)) continue;
    if (!price(r.cacheRead) && !(id === "glm-4-32b-0414-128k" && r.cacheRead === null)) continue;
    const current = OVERRIDES[id] || TABLE[id];
    OVERRIDES[id] = { ...model(r.input, r.cacheRead, r.output, current?.contextMax ?? null),
      cacheWrite5m: r.cacheWrite5m, cacheWrite1h: r.cacheWrite1h };
  }
}

try { applyRemoteRates(readCachedRates()); } catch {}
export function modelInfo(id) { return OVERRIDES[normalize(id)] || TABLE[normalize(id)] || null; }
export function knownContextMax(id) { return modelInfo(id)?.contextMax ?? null; }

/** Interactive entry points only; importing this module never fetches. */
export async function refreshPricing(options = {}) {
  const { refreshPricing: refreshRemote } = await import("./remote-pricing.mjs");
  const result = await refreshRemote(options);
  if (result.rates) applyRemoteRates(result.rates);
  return result;
}

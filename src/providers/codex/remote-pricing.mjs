// Official OpenAI Standard prices, supplemented only for missing ids by models.dev.
// Self-contained: install copies this module beside the bundled viewer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
export const MODELS_URL = "https://models.dev/api.json";
// OpenAI's documented long-context threshold when a row does not name one.
export const LONG_CONTEXT_THRESHOLD = 272_000;

const price = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const parsePrice = (cell) => /^\$\s*\d+(?:\.\d+)?$/.test(cell) ? Number(cell.replace(/[$\s]/g, "")) : null;

/** Only the Standard table: other service tiers have different prices. */
export function parsePricingMarkdown(md) {
  const rates = {};
  let standard = false, table = false, started = false;
  for (const raw of String(md || "").split("\n")) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      standard = /^###\s+Standard pricing data\s*$/i.test(line);
      table = false;
      started = false;
      continue;
    }
    if (!standard) continue;
    if (!line.startsWith("|")) {
      if (started) standard = false;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells[0] === "Model") {
      table = cells.length === 9 && cells[1] === "Short context input" && cells[8] === "Long context output";
      started = true;
      continue;
    }
    if (!table || cells.length !== 9) continue;
    const id = cells[0].split(/\s+\(/)[0];
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(id) || Object.hasOwn(rates, id)) continue;
    const tier = (values) => {
      const [input, cachedInput, cacheWrite, output] = values.map(parsePrice);
      if (input === null || output === null || (cachedInput === null && values[1] !== "-")
          || (cacheWrite === null && values[2] !== "-")) return null;
      return { input, cachedInput: cachedInput ?? input, cacheWrite, output };
    };
    const short = tier(cells.slice(1, 5));
    const long = tier(cells.slice(5));
    if (!short || (!long && !cells.slice(5).every((c) => c === "-"))) continue;
    const threshold = /\(<\s*(\d+(?:\.\d+)?)K\b/i.exec(cells[0]);
    rates[id] = { ...short, long: long ? { ...long, threshold: threshold ? Number(threshold[1]) * 1000 : LONG_CONTEXT_THRESHOLD } : null };
  }
  return rates;
}

export const CACHE_FILE = path.join(
  os.homedir(),
  ".ai-usage-inspector",
  "pricing-codex.json",
);

// models.dev shape: { openai: { models: { "<id>": { cost: { input, output,
// cache_read }, limit: { context } } } } }. Costs are USD per MTok already.
export function parseModelsDev(json) {
  const rates = {};
  const models = json && json.openai && json.openai.models;
  if (!models || typeof models !== "object") return rates;
  for (const [id, m] of Object.entries(models)) {
    const c = m && m.cost;
    if (!c || !price(c.input) || !price(c.output)) continue;
    rates[id] = {
      input: c.input,
      cachedInput: price(c.cache_read) ? c.cache_read : c.input * 0.1,
      // No published cache rate: the 10% is our guess, and the cost built from
      // it has to say so rather than pass as a looked-up rate.
      cachedGuessed: !price(c.cache_read),
      output: c.output,
      contextMax: (m.limit && m.limit.context) || null,
    };
  }
  return rates;
}

function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // Older caches predate official sources and long tiers; do not reinterpret them.
    if (!parsed || parsed.schema !== CACHE_SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {}
}

/** Cached rate map or null. Sync, never throws. */
// v3 records official sources, cache writes and long-context tiers.
export const CACHE_SCHEMA = 3;

/** Rates from the on-disk cache, or null if there is no usable one. */
export function readCachedRates(file = CACHE_FILE) {
  const c = readCache(file);
  return c && c.rates ? c.rates : null;
}

// Content diff — how we know pricing actually changed (no version/ETag to rely on).
export function diffRates(oldRates, nextRates) {
  const a = oldRates || {};
  const b = nextRates || {};
  const changes = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!y) changes.push({ id, type: "removed", from: x });
    else if (!x) changes.push({ id, type: "added", to: y });
    else if (["input", "output", "cachedInput", "cachedGuessed", "cacheWrite"].some((k) => x[k] !== y[k])
      || ["input", "output", "cachedInput", "cacheWrite", "threshold"].some((k) => x.long?.[k] !== y.long?.[k]))
      changes.push({ id, type: "changed", from: x, to: y });
  }
  return changes;
}

/** Best-effort refresh with a twelve-hour ttl and one-hour failure backoff. */
export async function refreshPricing({
  file = CACHE_FILE, url = PRICING_URL,
  modelsUrl = MODELS_URL,
  ttlMs = 12 * 60 * 60 * 1000, retryMs = 60 * 60 * 1000, timeoutMs = 10_000,
  now = Date.now(),
  fetchImpl = process.env.AI_USAGE_NO_PRICING_REFRESH === "1" ? null : globalThis.fetch,
} = {}) {
  const cached = readCache(file);
  const result = (status) => ({ status, rates: cached?.rates || null });
  if (typeof fetchImpl !== "function") return result("no-fetch");
  if (ttlMs > 0 && cached?.fetchedAt && now - cached.fetchedAt < ttlMs) return result("fresh");
  if (ttlMs > 0 && cached?.attemptedAt && now - cached.attemptedAt < Math.min(retryMs, ttlMs)) return result("backoff");
  const keep = (status) => {
    writeCache(file, { ...(cached || {}), schema: CACHE_SCHEMA, attemptedAt: now });
    return result(status);
  };
  const headers = { accept: "text/markdown, text/plain, */*" };
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  let res;
  try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { return keep("offline"); }
  if (res.status === 304 && cached?.rates) {
    writeCache(file, { ...cached, fetchedAt: now, attemptedAt: now });
    return result("not-modified");
  }
  if (!res.ok) return keep(`http-${res.status}`);
  let md;
  try { md = await res.text(); } catch { return keep("read-error"); }
  const rates = parsePricingMarkdown(md);
  if (Object.keys(rates).length < 3) return keep("parse-thin");

  const sources = { openai: url, "models.dev": modelsUrl };
  for (const r of Object.values(rates)) r.source = "openai";
  // A secondary failure never holds back official prices or replaces them.
  try {
    const extra = await fetchImpl(modelsUrl, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (extra.ok) {
      for (const [id, rate] of Object.entries(parseModelsDev(await extra.json()))) {
        if (!Object.hasOwn(rates, id)) rates[id] = { ...rate, source: "models.dev" };
      }
    }
  } catch {}
  const changes = diffRates(cached?.rates, rates);
  const etag = res.headers?.get("etag") || cached?.etag || null;
  writeCache(file, { schema: CACHE_SCHEMA, fetchedAt: now, attemptedAt: now, etag, sources, rates });
  return { status: cached && !changes.length ? "unchanged" : "updated", rates, changes };
}

// Self-contained so the installed viewer can refresh the same trimmed cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRICING_URL = "https://models.dev/api.json";
export const CACHE_FILE = path.join(os.homedir(), ".ai-usage-inspector", "pricing-modelsdev.json");
// Explicit allowlist: coding plans and resellers often advertise zero subscription
// prices for the same ids. They are not a lab's per-token API price.
export const PROVIDERS = ["anthropic", "openai", "moonshotai", "deepseek", "alibaba", "minimax",
  "xai", "google", "mistral", "cohere", "llama", "zai", "amazon-bedrock",
  "google-vertex", "google-vertex-anthropic", "openrouter"];
const price = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function parseModelsDev(json) {
  const rates = {};
  for (const provider of PROVIDERS) {
    const models = json?.[provider]?.models;
    if (!models || typeof models !== "object") continue;
    const kept = {};
    for (const [id, m] of Object.entries(models)) {
      const c = m?.cost;
      if (!c || !price(c.input) || !price(c.output)) continue;
      const tiers = (Array.isArray(c.tiers) ? c.tiers : [])
        .filter((r) => r?.tier?.type === "context" && price(r.tier.size) && r.tier.size > 0 && price(r.input) && price(r.output))
        .map((r) => ({ size: r.tier.size, input: r.input, output: r.output,
          cacheRead: price(r.cache_read) ? r.cache_read : null,
          cacheWrite: price(r.cache_write) ? r.cache_write : null }))
        .sort((a, b) => a.size - b.size);
      kept[id.toLowerCase()] = { input: c.input, output: c.output,
        ...(tiers.length ? { tiers } : {}),
        cacheRead: price(c.cache_read) ? c.cache_read : null,
        cacheWrite: price(c.cache_write) ? c.cache_write : null,
        contextMax: Number.isFinite(m.limit?.context) && m.limit.context > 0 ? m.limit.context : null };
    }
    if (Object.keys(kept).length) rates[provider] = kept;
  }
  return rates;
}

function readCache(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function writeCache(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); } catch {}
}
export function readCachedRates(file = CACHE_FILE) { return readCache(file)?.rates || null; }
export function diffRates(a = {}, b = {}) {
  const changes = [];
  for (const provider of new Set([...Object.keys(a), ...Object.keys(b)])) {
    for (const id of new Set([...Object.keys(a[provider] || {}), ...Object.keys(b[provider] || {})])) {
      const from = a[provider]?.[id], to = b[provider]?.[id];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ id: `${provider}:${id}`,
        type: !from ? "added" : !to ? "removed" : "changed", from, to });
    }
  }
  return changes;
}

export async function refreshPricing({ file = CACHE_FILE, url = PRICING_URL,
  ttlMs = 12 * 60 * 60 * 1000, retryMs = 60 * 60 * 1000, timeoutMs = 10_000,
  now = Date.now(),
  fetchImpl = process.env.AI_USAGE_NO_PRICING_REFRESH === "1" ? null : globalThis.fetch,
} = {}) {
  const cached = readCache(file);
  const oldRates = cached?.rates || null;
  const result = (status) => ({ status, rates: oldRates });
  if (typeof fetchImpl !== "function") return result("no-fetch");
  if (ttlMs > 0 && cached?.fetchedAt && now - cached.fetchedAt < ttlMs) return result("fresh");
  if (ttlMs > 0 && cached?.attemptedAt && now - cached.attemptedAt < Math.min(retryMs, ttlMs)) return result("backoff");
  const keep = (status) => { writeCache(file, { ...(cached || {}), attemptedAt: now }); return result(status); };
  const headers = { accept: "application/json" };
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  let res;
  try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { return keep("offline"); }
  if (res?.status === 304 && oldRates) {
    writeCache(file, { ...cached, fetchedAt: now, attemptedAt: now });
    return result("not-modified");
  }
  if (!res?.ok) return keep(`http-${res?.status}`);
  let rates;
  try { rates = parseModelsDev(await res.json()); } catch { return keep("read-error"); }
  // A truncated response must not erase a previously useful provider table.
  const count = (r) => Object.values(r || {}).reduce((n, models) => n + Object.keys(models || {}).length, 0);
  if (count(rates) < 3 || count(rates) < count(oldRates) / 2) return keep("parse-thin");
  const changes = diffRates(oldRates || {}, rates);
  const etag = res.headers?.get("etag") || cached?.etag || null;
  writeCache(file, { fetchedAt: now, attemptedAt: now, etag, source: url, rates });
  return { status: cached && !changes.length ? "unchanged" : "updated", rates, changes };
}

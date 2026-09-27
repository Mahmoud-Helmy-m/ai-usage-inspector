// Best-effort z.ai pricing cache. No imports from providers: also copied beside
// the standalone viewer. The hook only calls readCachedRates, never refreshPricing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The docs site answers the page path with HTML and the same path plus .md with the markdown
// this parser reads; fetching the page itself parses to nothing.
export const PRICING_URL = "https://docs.z.ai/guides/overview/pricing.md";
export const CACHE_FILE = path.join(os.homedir(), ".ai-usage-inspector", "pricing-zai.json");
const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];
// That markdown escapes the dollar signs (\$0.15) and leaves the rendered page's /MTok suffix off.
const clean = (s) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "").replace(/\\(?=[$\\])/g, "").trim();
function parsePrice(cell) {
  if (/^(?:Limited-time\s+)?Free$/i.test(cell)) return 0;
  const match = /^\$\s*(\d+(?:\.\d+)?)\s*(?:\/\s*MTok)?$/i.exec(cell);
  return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
}

/** Read only the canonical five columns; never shift past a missing price. */
export function parsePricingMarkdown(md) {
  const rates = {};
  let table = false;
  for (const line of String(md || "").split("\n")) {
    if (!line.trim().startsWith("|")) { table = false; continue; }
    const cells = line.trim().split("|").slice(1, -1).map(clean);
    if (cells[0]?.toLowerCase() === "model") {
      table = cells.map((s) => s.toLowerCase()).join("|") === "model|input|cached input|cached input storage|output";
      continue;
    }
    if (!table || cells.length !== 5) continue;
    const id = cells[0].toLowerCase();
    if (!/^glm-[a-z0-9.-]+$/.test(id) || Object.hasOwn(rates, id)) continue;
    const [input, cacheRead, storage, output] = cells.slice(1).map(parsePrice);
    // A dash means the model has no cache pricing at all: no write charge, and a read the table
    // cannot state, which the built-in fallback then estimates from the input rate.
    const dash = (cell) => /^[—–-]$/.test(cell);
    const write = storage === null && dash(cells[3]) ? 0 : storage;
    const read = cacheRead === null && dash(cells[2]) ? null : cacheRead;
    if (input === null || output === null || write === null || (read === null && !dash(cells[2]))) continue;
    rates[id] = { input, cacheRead: read, output, cacheWrite5m: write, cacheWrite1h: write };
  }
  return rates;
}

function readCache(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function writeCache(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}
export function readCachedRates(file = CACHE_FILE) { return readCache(file)?.rates || null; }
export function diffRates(a = {}, b = {}) {
  return Object.entries(b).flatMap(([id, to]) => !a[id] ? [{ id, type: "added", to }]
    : PRICE_FIELDS.some((k) => a[id][k] !== to[k]) ? [{ id, type: "changed", from: a[id], to }] : []);
}

/** Same ttl, timeout, failure backoff and statuses as Claude's refresher.
 * Explicit fake fetch injection is supported in offline tests, as in Claude. */
export async function refreshPricing({ file = CACHE_FILE, url = PRICING_URL,
  ttlMs = 12 * 60 * 60 * 1000, retryMs = 60 * 60 * 1000, timeoutMs = 10_000,
  now = Date.now(),
  fetchImpl = process.env.AI_USAGE_NO_PRICING_REFRESH === "1" ? null : globalThis.fetch,
} = {}) {
  const cached = readCache(file);
  const oldRates = cached?.rates || null;
  const result = (status) => ({ status, rates: oldRates });
  if (typeof fetchImpl !== "function") return result("no-fetch");
  if (cached?.fetchedAt && now - cached.fetchedAt < ttlMs) return result("fresh");
  if (cached?.attemptedAt && now - cached.attemptedAt < Math.min(retryMs, ttlMs)) return result("backoff");
  const keep = (status) => { writeCache(file, { ...(cached || {}), attemptedAt: now }); return result(status); };
  const headers = { accept: "text/markdown, text/plain, */*" };
  if (cached?.etag) headers["if-none-match"] = cached.etag;
  let res;
  try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) }); }
  catch { return keep("offline"); }
  if (res.status === 304 && cached) {
    writeCache(file, { ...cached, fetchedAt: now });
    return result("not-modified");
  }
  if (!res.ok) return keep(`http-${res.status}`);
  let md;
  try { md = await res.text(); } catch { return keep("read-error"); }
  const parsed = parsePricingMarkdown(md);
  if (Object.keys(parsed).length < 3) return keep("parse-thin");
  // A model omitted by a partial page keeps its previously fetched prices.
  const rates = { ...(oldRates || {}), ...parsed };
  const changes = diffRates(oldRates || {}, rates);
  const etag = res.headers.get("etag") || cached?.etag || null;
  writeCache(file, { etag, fetchedAt: now, source: url, rates });
  return { status: cached && !changes.length ? "unchanged" : "updated", rates, changes };
}

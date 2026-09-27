// Cursor's official markdown prices, including cache reads and writes.
// Missing read prices use a flagged 10% guess. Hooks read the cache offline;
// worker, install, sync and viewer refresh it. Self-contained for the bundled viewer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRICING_URL = "https://cursor.com/docs/models-and-pricing.md";

export const CACHE_FILE = path.join(
  os.homedir(),
  ".ai-usage-inspector",
  "pricing-cursor.json",
);

// Table layout (verified 2026-07):
//   | Model | Provider | Input | Cache write | Cache read | Output | Notes |
// The Model cell is a markdown link `[Name](url)`; prices are bare `$N`.
const COL = { model: 1, input: 3, cacheWrite: 4, cacheRead: 5, output: 6 };

// "[Claude 4.6 Sonnet](url)" -> "claude-4.6-sonnet". Link + parens stripped.
function nameToId(cell) {
  let s = String(cell || "");
  const link = /^\[([^\]]+)\]\([^)]*\)$/.exec(s.trim()); // markdown link → text
  if (link) s = link[1];
  s = s.toLowerCase().replace(/\([^)]*\)/g, "").trim().replace(/\s+/g, "-");
  return s || null;
}

// "$3" / "$12.50" -> number; anything else -> null.
function parsePrice(cell) {
  const m = /^\$\s*([\d.]+)$/.exec(String(cell || "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Markdown -> { id: { input, cachedInput, output } }. First row per id wins. */
export function parsePricingMarkdown(md) {
  const rates = {};
  for (const line of String(md || "").split("\n")) {
    if (line[0] !== "|") continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length <= COL.output) continue;
    const id = nameToId(cells[COL.model]);
    const input = parsePrice(cells[COL.input]);
    const output = parsePrice(cells[COL.output]);
    if (!id || id in rates || input == null || output == null) continue;
    const cr = parsePrice(cells[COL.cacheRead]);
    // cr == null means the page published no cache rate; the 10% below is our
    // guess, flagged so costs derived from it are labelled estimated.
    rates[id] = { input, cachedInput: cr != null ? cr : input * 0.1, output, cacheWrite: parsePrice(cells[COL.cacheWrite]), cachedGuessed: cr == null };
  }
  return rates;
}

function readCache(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // Pre-v2 files stored a synthesized cache rate with nothing to distinguish it
    // from a published one, and a genuine rate that happens to be a tenth of the
    // input rate is common enough that guessing from the number is wrong either
    // way. Treat such a file as absent: the built-in table prices the current
    // models until the next refresh writes a cache that records what it knows.
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
// Cache format version. Files written before the cache recorded WHICH rates were
// guessed carry no marker, so a synthesized cache rate in them would read as a
// looked-up one. Bumped when the entry shape changes meaning.
export const CACHE_SCHEMA = 2;

/** Rates from the on-disk cache, or null if there is no usable one. */
export function readCachedRates(file = CACHE_FILE) {
  const c = readCache(file);
  return c && c.rates ? c.rates : null;
}

// Content diff — the only change signal available (no version/ETag).
export function diffRates(oldRates, nextRates) {
  const a = oldRates || {};
  const b = nextRates || {};
  const changes = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!y) changes.push({ id, type: "removed", from: x });
    else if (!x) changes.push({ id, type: "added", to: y });
    else if (["input", "output", "cachedInput", "cacheWrite", "cachedGuessed"].some((k) => x[k] !== y[k]))
      changes.push({ id, type: "changed", from: x, to: y });
  }
  return changes;
}

/** Best-effort refresh with a twelve-hour ttl and one-hour failure backoff. */
export async function refreshPricing({
  file = CACHE_FILE, url = PRICING_URL,
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
  // Some Accept values listing text/markdown got a 404 from cursor.com (2026-09); keep text/plain.
  const headers = { accept: "text/plain, */*" };
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
  const sources = { cursor: url };
  const changes = diffRates(cached?.rates, rates);
  const etag = res.headers?.get("etag") || cached?.etag || null;
  writeCache(file, { schema: CACHE_SCHEMA, fetchedAt: now, attemptedAt: now, etag, sources, rates });
  return { status: cached && !changes.length ? "unchanged" : "updated", rates, changes };
}

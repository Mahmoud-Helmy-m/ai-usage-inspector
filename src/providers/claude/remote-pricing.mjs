// Dynamic model pricing: fetch current per-MTok rates and context windows from
// Claude's public docs and cache them on disk, so recorded costs and context
// fill track new models and price changes without a code edit. Zero-dependency,
// fully offline-safe.
//
// Split of responsibilities:
//   - The viewer, `install` and `sync` (interactive, have network) call
//     refreshPricing() to keep the cache current. The viewer refreshes on every
//     start; install and sync only when the cache is older than its ttl, so
//     neither is slowed by a fetch that already happened today.
//   - The Stop hook (short-lived, must stay fast) never hits the network. It
//     reads the cached rates and windows synchronously — see pricing.mjs, which
//     applies them over the built-in table at import.
//
// The built-in table in pricing.mjs is always the fallback: if the network is
// down, the page format changes, or nothing has been cached yet, costs still
// compute from the bundled rates.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Anthropic's public pricing page, in machine-readable markdown. No API key
// needed. The "Model pricing" table lists one model per row as `$N / MTok`.
export const PRICING_URL =
  "https://platform.claude.com/docs/en/about-claude/pricing.md";

// The models overview: one column per current model, with a "Claude API ID" row
// and a "Context window" row. A model is listed here from its launch, which is
// exactly when the built-in table does not know it yet.
export const MODELS_URL =
  "https://platform.claude.com/docs/en/about-claude/models/overview.md";

// Shared across every project on this machine — pricing is global, not
// per-project. Lives beside the installed app's global config. Per-provider
// file so providers never clobber each other's cached rates.
export const CACHE_FILE = path.join(
  os.homedir(),
  ".ai-usage-inspector",
  "pricing-claude.json",
);

const PRICE_FIELDS = ["input", "output", "cacheWrite5m", "cacheWrite1h", "cacheRead"];

// "Claude Opus 4.8" -> "claude-opus-4-8". Trailing footnotes/links in the cell
// (e.g. "Claude Sonnet 5 through August 31, 2026") are ignored: we only read
// the leading `Claude <tier> <version>`.
function nameToId(name) {
  const m = /^Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\s+(\d+(?:\.\d+)?)/i.exec(
    String(name || "").trim(),
  );
  if (!m) return null;
  return `claude-${m[1].toLowerCase()}-${m[2].replace(/\./g, "-")}`;
}

// "$12.50 / MTok" -> 12.5 ; non-price cells -> null.
function parsePrice(cell) {
  const m = /\$\s*([\d.]+)\s*\/\s*MTok/i.exec(String(cell || ""));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Parse the pricing markdown into { "<model-id>": { input, output, ... } }.
// Each model row renders as: Model | Base Input | 5m | 1h | Cache hit | Output.
// Input is the first price and output the last, so the column count can shift
// without breaking; the three cache prices are read only when a row carries all
// five, because a model's cache prices do not always follow its input — Fable
// 5.1's cache hits are 0.025x input, not the usual 0.1x. First row for a given
// id wins: the canonical "Model pricing" table sits above the batch/fast-mode
// tables, and currently effective pricing is listed before any future price.
export function parsePricingMarkdown(md) {
  const rates = {};
  const fastRates = {};
  let fast = false;
  for (const line of String(md || "").split("\n")) {
    if (/^#{1,3}\s/.test(line)) fast = /^###\s+Fast mode pricing\s*$/i.test(line);
    if (line[0] !== "|") continue;
    const cells = line.split("|").map((c) => c.trim());
    if (fast) {
      const input = parsePrice(cells[2]), output = parsePrice(cells[3]);
      if (input === null || output === null) continue;
      for (const name of cells[1].split(/\s+\/\s+/)) {
        const id = nameToId(name);
        if (id && !fastRates[id]) fastRates[id] = { input, output };
      }
      continue;
    }
    if (cells[1].includes(" / ")) continue;
    const id = nameToId(cells[1]);
    if (!id || id in rates) continue;
    const prices = cells.slice(2).map(parsePrice).filter((n) => n != null);
    if (prices.length < 2) continue;
    const input = prices[0];
    const output = prices[prices.length - 1];
    if (!(input >= 0 && output >= 0)) continue;
    const rate = { input, output };
    if (prices.length === 5 && prices.slice(1, 4).every((n) => n >= 0)) {
      [rate.cacheWrite5m, rate.cacheWrite1h, rate.cacheRead] = prices.slice(1, 4);
    }
    rates[id] = rate;
  }
  for (const [id, rate] of Object.entries(fastRates)) {
    if (rates[id]) rates[id].fast = rate;
  }
  return rates;
}

// "1M tokens" -> 1000000, "200K tokens" -> 200000, "1,000,000 tokens" -> 1000000.
function parseWindow(cell) {
  const m = /([\d.,]+)\s*([KM])?\s*tokens?/i.exec(String(cell || ""));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const scale = m[2] ? (m[2].toUpperCase() === "M" ? 1_000_000 : 1_000) : 1;
  const tokens = Math.round(n * scale);
  return tokens >= 1_000 ? tokens : null;
}

/**
 * Parse the models overview into { "<model-id>": contextWindowTokens }. Its tables
 * run one model per column, so the ids and the windows are read from their own
 * rows and matched by column. Dated ids ("claude-haiku-4-5-20251001") are keyed
 * without the date, as the rate table is.
 */
export function parseModelsMarkdown(md) {
  const windows = {};
  let ids = null;
  const label = (cell) => cell.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
  for (const line of String(md || "").split("\n")) {
    if (line[0] !== "|") { ids = null; continue; }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    // A separator row starts a new table: its columns are not the old table's,
    // so ids read above it must never be matched to windows read below it.
    if (cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))) { ids = null; continue; }
    const name = label(cells[0] || "");
    if (/^Claude API ID$/i.test(name)) {
      ids = cells.slice(1).map((c) => {
        const m = /`?(claude-[a-z0-9-]+)`?/i.exec(c);
        return m ? m[1].toLowerCase().replace(/-\d{8}$/, "") : null;
      });
      continue;
    }
    if (ids && cells.length - 1 === ids.length && /^Context window$/i.test(name)) {
      cells.slice(1).forEach((cell, i) => {
        const tokens = parseWindow(cell);
        if (ids[i] && tokens) windows[ids[i]] = tokens;
      });
    }
  }
  return windows;
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
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

/** Cached rate map ({id:{input,output,...}}) or null. Sync, never throws. */
export function readCachedRates(file = CACHE_FILE) {
  const c = readCache(file);
  return c && c.rates ? c.rates : null;
}

/** Cached context windows ({id: tokens}) or null. Sync, never throws. */
export function readCachedWindows(file = CACHE_FILE) {
  const c = readCache(file);
  return c && c.windows && typeof c.windows === "object" ? c.windows : null;
}

// What actually changed between two rate maps: a model added, removed, or
// repriced. This — not an ETag — is how we know there's a real change, since
// the docs CDN doesn't send validators. Returns [] when nothing moved.
export function diffRates(oldRates, nextRates) {
  const a = oldRates || {};
  const b = nextRates || {};
  const changes = [];
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    if (!y) changes.push({ id, type: "removed", from: x });
    else if (!x) changes.push({ id, type: "added", to: y });
    else if (PRICE_FIELDS.some((k) => x[k] !== y[k]) || ["input", "output"].some((k) => x.fast?.[k] !== y.fast?.[k]))
      changes.push({ id, type: "changed", from: x, to: y });
  }
  return changes;
}

/** Windows that were added or moved. A model dropping off the page is not a change. */
export function diffWindows(oldWindows, nextWindows) {
  const a = oldWindows || {};
  const changes = [];
  for (const [id, tokens] of Object.entries(nextWindows || {})) {
    if (a[id] !== tokens) changes.push({ id, type: "window", from: a[id] ?? null, to: tokens });
  }
  return changes;
}

async function fetchText(fetchImpl, url, headers, timeoutMs) {
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
  return fetchImpl(url, { headers, ...(signal ? { signal } : {}) });
}

/**
 * Refresh the on-disk pricing cache from the public docs. Best-effort and
 * non-blocking by contract — every failure path falls back to the cached (or
 * null) rates and the caller keeps using the built-in table.
 *
 * Returns { status, rates, windows, changes? }. status is one of: no-fetch,
 * fresh (cache still within ttl, skipped network), not-modified (304 from
 * server), unchanged (re-fetched but nothing parsed differently), updated (a
 * rate or a window actually differs — `changes` lists what moved), offline,
 * http-<code>, read-error, parse-thin.
 */
export async function refreshPricing({
  file = CACHE_FILE,
  url = PRICING_URL,
  modelsUrl = MODELS_URL,
  ttlMs = 12 * 60 * 60 * 1000,
  // After a failed attempt, how long before trying again. A page that is down must
  // not cost every sync two slow requests; capped at ttlMs, so the dashboard's
  // ttlMs of 0 still tries on every start.
  retryMs = 60 * 60 * 1000,
  timeoutMs = 10_000,
  now = Date.now(),
  // AI_USAGE_NO_PRICING_REFRESH=1 keeps a run off the network entirely: the test
  // suite sets it, and so can anyone on a machine that must not reach out.
  fetchImpl = process.env.AI_USAGE_NO_PRICING_REFRESH === "1" ? null : globalThis.fetch,
} = {}) {
  const cached = readCache(file);
  const cachedWindows = (cached && cached.windows) || null;
  if (typeof fetchImpl !== "function") {
    return { status: "no-fetch", rates: cached ? cached.rates || null : null, windows: cachedWindows };
  }
  // Don't even open a socket if we refreshed recently, or failed to recently.
  if (cached && cached.fetchedAt && now - cached.fetchedAt < ttlMs) {
    return { status: "fresh", rates: cached.rates || null, windows: cachedWindows };
  }
  if (cached && cached.attemptedAt && now - cached.attemptedAt < Math.min(retryMs, ttlMs)) {
    return { status: "backoff", rates: cached.rates || null, windows: cachedWindows };
  }

  // Windows come from their own page. A failure there leaves the last known
  // windows in place; it never holds back a rate refresh.
  let windows = cachedWindows;
  let windowChanges = [];
  try {
    const res = await fetchText(fetchImpl, modelsUrl, { accept: "text/markdown, text/plain, */*" }, timeoutMs);
    if (res.ok) {
      const parsed = parseModelsMarkdown(await res.text());
      if (Object.keys(parsed).length) {
        windowChanges = diffWindows(cachedWindows, parsed);
        windows = { ...(cachedWindows || {}), ...parsed };
      }
    }
  } catch {}

  const headers = { accept: "text/markdown, text/plain, */*" };
  if (cached && cached.etag) headers["if-none-match"] = cached.etag;

  // The rate page failed. Keep what was known, keep any windows that did arrive
  // even with no rates cached yet, and note the attempt so the next sync backs off.
  const keep = (status) => {
    writeCache(file, { ...(cached || {}), windows, attemptedAt: now });
    return { status, rates: cached ? cached.rates || null : null, windows, ...(windowChanges.length ? { changes: windowChanges } : {}) };
  };

  let res;
  try {
    res = await fetchText(fetchImpl, url, headers, timeoutMs);
  } catch {
    return keep("offline");
  }

  // Unchanged since last fetch — bump the timestamp, skip re-parsing.
  if (res.status === 304 && cached) {
    writeCache(file, { ...cached, windows, fetchedAt: now });
    return windowChanges.length
      ? { status: "updated", rates: cached.rates || null, windows, changes: windowChanges }
      : { status: "not-modified", rates: cached.rates || null, windows };
  }
  if (!res.ok) return keep(`http-${res.status}`);

  let md;
  try {
    md = await res.text();
  } catch {
    return keep("read-error");
  }

  const rates = parsePricingMarkdown(md);
  // Guard against a page redesign silently zeroing out prices: keep the old
  // cache if the parse came back implausibly thin.
  if (Object.keys(rates).length < 3) return keep("parse-thin");

  const etag = res.headers.get("etag") || (cached && cached.etag) || null;
  const changes = [...diffRates(cached && cached.rates, rates), ...windowChanges];
  // Re-fetched, but the numbers are identical — no real change. Just record
  // that we checked (bump fetchedAt / refresh the etag) and report it.
  if (cached && changes.length === 0) {
    writeCache(file, { ...cached, etag, fetchedAt: now, rates, windows });
    return { status: "unchanged", rates, windows };
  }
  writeCache(file, { etag, fetchedAt: now, source: url, rates, windows });
  return { status: "updated", rates, windows, changes };
}

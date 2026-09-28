// Put real prices on turns that were stored with a guessed one.
//
// A model released after the rates were last fetched is priced from a fallback and marked
// estimated. Once its real rate is known, the turns stored in the meantime are worth pricing
// again — but from their transcripts, not from the totals a row keeps: a turn or a subagent run
// can mix models, and only the parser prices each message at its own model. So this finds the
// estimated rows whose model now has a real rate and re-reads just the transcripts behind them;
// the store takes the new price because an estimate never counted as the rate on the day
// (see preserveComputedCost).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestTranscript } from "./ingest.mjs";
import { workspaceFile } from "./paths.mjs";

const HEAD_BYTES = 256 * 1024;

// Who fetched new rates must not decide whether stored estimates are corrected: the dashboard
// refetches on every start and corrects nothing, and after it the worker and sync find the cache
// fresh. So the rate caches are fingerprinted, and a correction is due whenever the fingerprint
// differs from the one recorded at the last completed correction.
const stateDir = () => path.join(os.homedir(), ".ai-usage-inspector");
const markerFile = (dir) => path.join(dir, "estimates.json");
// Fields that change on every fetch without the rates changing.
const VOLATILE = new Set(["fetchedAt", "attemptedAt", "etag"]);

/** A fingerprint of every cached rate table (pricing-*.json), ignoring fetch timestamps. */
export function ratesDigest(dir = stateDir()) {
  const hash = crypto.createHash("sha256");
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^pricing-.+\.json$/.test(n)).sort(); } catch {}
  for (const name of names) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch {}
    const kept = data && typeof data === "object"
      ? Object.fromEntries(Object.entries(data).filter(([k]) => !VOLATILE.has(k)))
      : data;
    hash.update(name).update("\0").update(JSON.stringify(kept)).update("\0");
  }
  return hash.digest("hex");
}

/** Have the cached rates changed since stored estimates were last corrected? Never throws. */
export function ratesChangedSinceCorrection(dir = stateDir()) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerFile(dir), "utf8"));
    return !marker || marker.ratesDigest !== ratesDigest(dir);
  } catch {
    return true;
  }
}

/**
 * Correct every given provider that supports it, then record the rates it corrected against —
 * the fingerprint taken before starting, so rates that change meanwhile are caught next time.
 * Nothing is recorded if a provider's correction failed. Returns { <id>: result }.
 */
export async function correctAll(providers, { correct = correctEstimatedCosts, dir = stateDir() } = {}) {
  const digest = ratesDigest(dir);
  const results = {};
  let ok = true;
  for (const provider of providers.filter(Boolean)) {
    if (typeof provider.pricedModel !== "function" || typeof provider.transcriptId !== "function") continue;
    try { results[provider.id] = await correct(provider); } catch { ok = false; }
  }
  if (ok) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(markerFile(dir), JSON.stringify({ ratesDigest: digest, correctedAt: Date.now() }));
    } catch {}
  }
  return results;
}

function readJsonl(file, bytes = Infinity) {
  let text = "";
  try {
    if (bytes === Infinity) text = fs.readFileSync(file, "utf8");
    else {
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(bytes);
        const n = fs.readSync(fd, buf, 0, bytes, 0);
        text = buf.subarray(0, n).toString("utf8");
      } finally { fs.closeSync(fd); }
    }
  } catch { return []; }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

// Where a transcript's rows live: the store of the folder its first turn names (the rule
// storeTurns follows). The head of the file is enough almost always.
function homeOf(transcriptPath) {
  for (const bytes of [HEAD_BYTES, Infinity]) {
    for (const e of readJsonl(transcriptPath, bytes)) {
      const cwd = e?.cwd || e?.payload?.cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    }
  }
  return null;
}

/** Every store the given transcripts write to (or, pooled, every file in AI_USAGE_DIR). */
export function storesOf(transcripts) {
  const aggregate = process.env.AI_USAGE_DIR;
  if (aggregate) {
    try {
      return fs.readdirSync(aggregate).filter((n) => n.endsWith(".ndjson")).map((n) => path.join(aggregate, n));
    } catch { return []; }
  }
  const files = new Set();
  for (const t of transcripts) {
    const file = t && t.transcriptPath;
    if (typeof file !== "string") continue;
    const home = homeOf(file);
    if (!home) continue;
    const store = workspaceFile(home);
    if (fs.existsSync(store)) files.add(store);
  }
  return [...files];
}

const runsOf = (e) => (Array.isArray(e && e.subagents) ? e.subagents : []);
const allRuns = (e) => runsOf(e).flatMap((r) => [r, ...allRuns(r)]);
const tokens = (u) => (u ? Object.values(u).reduce((n, v) => n + (Number(v) || 0), 0) : 0);

/** Would a re-read of this row now price it from real rates where it was guessed before? */
export function correctable(row, priced) {
  if (!row || !row.cost || row.cost.source !== "estimated" || tokens(row.usage) <= 0) return false;
  const guessedParts = [row, ...allRuns(row)].filter((p) => p.cost && p.cost.source === "estimated");
  // Every guessed part must now have a real rate, or the re-read would still be an estimate.
  return guessedParts.length > 0 && guessedParts.every((p) => typeof p.model === "string" && priced(p.model));
}

/**
 * Re-read the transcripts behind this provider's estimated rows whose models now have a real
 * rate. Returns { stores, rows, transcripts, reread, priced }: `rows` looked priceable from what
 * a row records, `priced` actually became priced. They differ when a row's guess came from a
 * message whose model the row does not name — a run is labelled with its last message's model —
 * and such a row simply stays an estimate. Never throws for one bad transcript.
 */
export async function correctEstimatedCosts(provider, { transcripts = null } = {}) {
  const out = { stores: 0, rows: 0, transcripts: 0, reread: 0, priced: 0 };
  if (!provider || typeof provider.pricedModel !== "function" || typeof provider.transcriptId !== "function") return out;
  const found = transcripts || (typeof provider.discoverTranscripts === "function" ? await provider.discoverTranscripts({ sinceMs: 0 }) : []);
  const byId = new Map();
  for (const t of found) {
    try {
      const id = provider.transcriptId(t.transcriptPath);
      if (id != null) byId.set(String(id), t);
    } catch {}
  }
  const stores = storesOf(found);
  out.stores = stores.length;
  const priceable = () => {
    const ids = new Set();
    let rows = 0;
    for (const store of stores) {
      for (const row of readJsonl(store)) {
        if ((row.provider || "claude") !== provider.id || row.transcriptId == null) continue;
        if (!correctable(row, (m) => provider.pricedModel(m))) continue;
        rows++;
        ids.add(String(row.transcriptId));
      }
    }
    return { rows, ids };
  };
  const before = priceable();
  out.rows = before.rows;
  out.transcripts = before.ids.size;
  for (const id of before.ids) {
    const ref = byId.get(id);
    if (!ref) continue;
    try {
      await ingestTranscript(provider, ref);
      out.reread++;
    } catch {}
  }
  if (out.reread) out.priced = Math.max(0, before.rows - priceable().rows);
  return out;
}

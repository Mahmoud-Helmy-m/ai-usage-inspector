// Put real prices on turns that were stored with a guessed one.
//
// A model released after the rates were last fetched is priced from a fallback and marked
// estimated. Once its real rate is known, the turns stored in the meantime are worth pricing
// again — but from their transcripts, not from the totals a row keeps: a turn or a subagent run
// can mix models, and only the parser prices each message at its own model. So this finds the
// estimated rows whose model now has a real rate and re-reads just the transcripts behind them;
// the store takes the new price because an estimate never counted as the rate on the day
// (see preserveComputedCost).
import fs from "node:fs";
import path from "node:path";
import { ingestTranscript } from "./ingest.mjs";
import { workspaceFile } from "./paths.mjs";

const HEAD_BYTES = 256 * 1024;

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
    for (const e of readJsonl(transcriptPath, bytes)) if (e && typeof e.cwd === "string" && e.cwd) return e.cwd;
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
 * rate. Returns { stores, rows, transcripts, reread }. Never throws for one bad transcript.
 */
export async function correctEstimatedCosts(provider, { transcripts = null } = {}) {
  const out = { stores: 0, rows: 0, transcripts: 0, reread: 0 };
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
  const wanted = new Set();
  for (const store of stores) {
    for (const row of readJsonl(store)) {
      if ((row.provider || "claude") !== provider.id || row.transcriptId == null) continue;
      if (!correctable(row, (m) => provider.pricedModel(m))) continue;
      out.rows++;
      wanted.add(String(row.transcriptId));
    }
  }
  out.transcripts = wanted.size;
  for (const id of wanted) {
    const ref = byId.get(id);
    if (!ref) continue;
    try {
      await ingestTranscript(provider, ref);
      out.reread++;
    } catch {}
  }
  return out;
}

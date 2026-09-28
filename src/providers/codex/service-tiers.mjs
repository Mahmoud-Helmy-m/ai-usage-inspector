// The service tier a Codex turn ran at, from Codex's own log database.
//
// Rollouts do not record the tier and config.toml holds only the current one (the hook reads
// it when a turn ends). Codex does log a "feedback_tags" entry per turn carrying the thread id
// and `"service_tier":"<tier>"`, in ~/.codex/logs_2.sqlite. That database is Codex's internal
// log, not a documented file, and Codex prunes it (about ten days are kept), so this is
// best-effort evidence for turns the hook did not see: anything unrecognised gives no tier.
// Once a turn's tier is stored it survives re-reads, so evidence read before the log is pruned
// is kept. Only the tier is read out of each entry. Never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeServiceTier } from "../../lib/hook-pricing.mjs";

export const logsFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "logs_2.sqlite");
// A turn's entry is logged as it starts; allow for clock rounding at the turn's end.
const SLACK_MS = 5_000;
const TAG = /"service_tier":"([A-Za-z_]+)"/;

/** The tier named in one feedback_tags body, normalised, or null. */
export function tierFromTags(body) {
  const m = TAG.exec(String(body || ""));
  return m ? normalizeServiceTier(m[1].toLowerCase()) : null;
}

let db = null, dbFile = null;
function open(file) {
  if (dbFile === file) return db;
  dbFile = file;
  db = null;
  try {
    if (!fs.existsSync(file)) return null;
    // Synchronous on purpose: rollouts are parsed synchronously. Node < 22.5 has no sqlite.
    const sqlite = process.getBuiltinModule?.("node:sqlite");
    if (sqlite) db = new sqlite.DatabaseSync(file, { readOnly: true });
  } catch { db = null; }
  return db;
}

/**
 * Tier entries logged for one thread, oldest first: [{ at: ms, tier }]. Empty when the
 * database, its table or its columns are missing or unreadable.
 */
export function threadTiers(threadId, { file = logsFile() } = {}) {
  if (!threadId) return [];
  const conn = open(file);
  if (!conn) return [];
  try {
    return conn.prepare(`select ts, ts_nanos, feedback_log_body as body from logs
      where thread_id = ? and target = 'feedback_tags' and feedback_log_body like '%"service_tier":%'
      order by ts, ts_nanos`).all(String(threadId))
      .map((r) => ({ at: Number(r.ts) * 1000 + Math.floor((Number(r.ts_nanos) || 0) / 1e6), tier: tierFromTags(r.body) }))
      .filter((e) => Number.isFinite(e.at) && e.tier);
  } catch {
    return [];
  }
}

/**
 * The tier a turn ran at: the latest entry logged before the next turn started (each turn's
 * entry is logged as it starts, so a bound at this turn's end would take the next turn's entry
 * when it followed quickly). The last turn takes entries up to shortly after its end.
 */
export function tierAt(entries, { endMs, nextStartMs = null } = {}) {
  const next = Number(nextStartMs), end = Number(endMs);
  const bound = nextStartMs != null && Number.isFinite(next) ? (at) => at < next
    : Number.isFinite(end) ? (at) => at <= end + SLACK_MS : null;
  if (!bound) return null;
  let tier = null;
  for (const e of entries) if (bound(e.at)) tier = e.tier;
  return tier;
}

/** For tests: forget the open database. */
export function closeTierLog() {
  try { db?.close(); } catch {}
  db = null;
  dbFile = null;
}

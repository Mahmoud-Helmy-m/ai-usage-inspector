// Durable high-water marks + scan health for scan-based providers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mutateJson } from "./store.mjs";

export const FIRST_SCAN_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SCAN_OVERLAP_MS = 5 * 60 * 1000;
export const SCAN_STATUSES = new Set(["ok", "locked", "unsupported-schema", "missing"]);

// Raised when rows already stored need their sessions read again from the start.
// A change to how turns are identified or costed reaches a stored row only when
// its session is read again, and the transcripts behind old rows are not kept for
// ever — so an upgrade across it asks each agent for one full read.
// 1: turns kept per transcript (2.5.0). 2: one home per session, branches and
// subagent runs counted once, copies in other folders removed (2.6.0).
// 3: Opus 5, Sonnet 5, Fable 5.1 and Mythos 5.1 measured against their 1M
// windows, each subagent run's context measured on its own, and the costs those
// models were given under wrong rates worked out again (2.8.0).
// 4: OpenCode rows rewritten the old way — summed context, 0 for an unknown
// window, unlinked subagent sessions — are re-read (2.9.1).
// 5: OpenCode request counts/windows and Cline-family unknown windows (2.9.2).
// 6: z.ai vendor, GLM rates and known/unknown windows (2.10.0).
// 7: Codex official Standard rates and per-request long-context pricing (2.11.0).
// 8: Claude turns ending in a "<synthetic>" message take the real model, and turns with
//    no-token parts lose a wrong "estimated" label (2.11.1).
export const REPAIR_EPOCH = 8;

// Which agents' stored rows each epoch's changes touch. Epochs before this map
// existed touched every provider, so a missing entry repairs them all.
const REPAIR_PROVIDERS_BY_EPOCH = Object.freeze({ 4: ["opencode"], 5: ["opencode", "cline", "roo", "kilo"], 6: ["claude", "opencode", "cline", "roo", "kilo", "cursor"], 7: ["codex"], 8: ["claude", "codex"] });

// A repair covers the rows one destination holds: each project's own files, or
// the pooled copy in an aggregate AI_USAGE_DIR. Settling one says nothing about
// the other — and a machine that always writes to an aggregate must still be able
// to settle its own.
function repairDestination() {
  if (!process.env.AI_USAGE_DIR) return "projects";
  const dir = path.resolve(process.env.AI_USAGE_DIR);
  // A Windows path names the same directory whatever its casing.
  return `dir:${process.platform === "win32" ? dir.toLowerCase() : dir}`;
}

function repairedAt(entry) {
  const done = entry && entry.repaired && typeof entry.repaired === "object" ? entry.repaired : {};
  return Number(done[repairDestination()]) || 0;
}

function pendingRepair(state, providerId) {
  const entry = state && state.providers && state.providers[providerId];
  const requested = Number(entry && entry.repairRequested) || 0;
  return requested > repairedAt(entry) ? requested : null;
}

/** The repair epoch this machine still owes a provider, or null. */
export function repairDue(providerId, { file = scanStatePath() } = {}) {
  return pendingRepair(readScanState(file), providerId);
}

export function scanStatePath() {
  return process.env.AI_USAGE_SCAN_STATE_FILE
    || path.join(os.homedir(), ".ai-usage-inspector", "scan-state.json");
}

export function readScanState(file = scanStatePath()) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state && typeof state === "object" ? state : { schema: 1, providers: {} };
  } catch {
    return { schema: 1, providers: {} };
  }
}

export function scanWindow(providerId, { file = scanStatePath(), now = Date.now() } = {}) {
  const state = readScanState(file);
  // A repair this machine still owes reads the provider's whole history once,
  // whatever the mark says.
  const repairEpoch = pendingRepair(state, providerId);
  if (repairEpoch !== null) return { scanStartedAtMs: now, sinceMs: 0, repairEpoch };
  const provider = state.providers && state.providers[providerId];
  const mark = Number(provider && provider.lastSuccessfulScanMs);
  return {
    scanStartedAtMs: now,
    sinceMs: Number.isFinite(mark) && mark > 0
      ? Math.max(0, mark - SCAN_OVERLAP_MS)
      : Math.max(0, now - FIRST_SCAN_WINDOW_MS),
    repairEpoch: null,
  };
}

/**
 * Take the right to scan a provider, or report that someone else already has.
 *
 * Sweeps run in detached workers that can start at the same moment, so reading
 * the throttle and then acting on it is a race: both read a stale mark, both
 * scan, both ingest. The check and the stamp happen together inside the same
 * locked mutation, so exactly one caller wins.
 *
 * Returns true if this caller may scan. A caller that loses simply skips.
 */
export const SCAN_LEASE_MS = 15 * 60 * 1000;

export async function claimScan(providerId, {
  file = scanStatePath(),
  throttleMs = 0,
  leaseMs = SCAN_LEASE_MS,
  now = Date.now(),
  leaseId = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
} = {}) {
  return mutateJson(file, (state) => {
    const next = state && typeof state === "object" ? { ...state } : {};
    next.schema = 1;
    next.providers = next.providers && typeof next.providers === "object" ? { ...next.providers } : {};
    const previous = next.providers[providerId] && typeof next.providers[providerId] === "object"
      ? next.providers[providerId]
      : {};
    // A scan that outruns the throttle would otherwise be claimable by a second
    // worker mid-flight, which is the very overlap this exists to prevent. The
    // lease covers the scan itself and expires so a crashed worker frees it.
    const lease = Number(previous.scanLeaseUntilMs);
    if (Number.isFinite(lease) && now < lease) return { data: next, value: false };

    const last = Number(previous.lastScanAtMs);
    if (throttleMs > 0 && Number.isFinite(last) && now - last < throttleMs) {
      return { data: next, value: false };
    }
    // Stamp the attempt now so a concurrent worker sees it and stands down. The
    // successful-scan watermark is untouched; only a completed scan moves that.
    next.providers[providerId] = {
      ...previous,
      lastScanAtMs: now,
      lastScanAt: new Date(now).toISOString(),
      scanLeaseUntilMs: now + Math.max(0, leaseMs),
      scanLeaseId: leaseId,
    };
    return { data: next, value: leaseId };
  });
}

export async function recordScanResult(providerId, {
  file = scanStatePath(),
  scanStartedAtMs,
  leaseId = null,
  status = "ok",
  completed = false,
  detail = null,
  recordedAtMs = Date.now(),
  repairEpoch = null,
} = {}) {
  const cleanStatus = SCAN_STATUSES.has(status) ? status : "unsupported-schema";
  return mutateJson(file, (state) => {
    const next = state && typeof state === "object" ? { ...state } : {};
    next.schema = 1;
    next.providers = next.providers && typeof next.providers === "object"
      ? { ...next.providers }
      : {};
    const previous = next.providers[providerId] && typeof next.providers[providerId] === "object"
      ? next.providers[providerId]
      : {};
    const holdsLease = leaseId != null && previous.scanLeaseId === leaseId;
    const releasing = holdsLease || previous.scanLeaseId == null;
    const entry = {
      ...previous,
      scanLeaseUntilMs: releasing ? undefined : previous.scanLeaseUntilMs,
      scanLeaseId: releasing ? undefined : previous.scanLeaseId,
      lastScanAt: new Date(recordedAtMs).toISOString(),
      lastScanAtMs: recordedAtMs,
      lastScanStatus: cleanStatus,
      lastScanCompleted: completed === true,
    };
    if (detail) entry.lastScanDetail = String(detail).slice(0, 500);
    else delete entry.lastScanDetail;
    const started = Number(scanStartedAtMs);
    if (completed === true && cleanStatus === "ok" && Number.isFinite(started) && started > 0) {
      entry.lastSuccessfulScanMs = Math.max(Number(previous.lastSuccessfulScanMs) || 0, started);
      entry.lastSuccessfulScanAt = new Date(entry.lastSuccessfulScanMs).toISOString();
    }
    // Passed only for a full-history pass that reached everything it found, so a
    // repair cut short is attempted again.
    const repaired = Number(repairEpoch);
    if (Number.isFinite(repaired) && repaired > 0) {
      entry.repaired = { ...(previous.repaired || {}), [repairDestination()]: Math.max(repairedAt(previous), repaired) };
    }
    next.providers[providerId] = entry;
    return next;
  }, { schema: 1, providers: {} });
}

/** Record that a provider's history was read in full for a repair. */
export async function markRepaired(providerId, repairEpoch, { file = scanStatePath() } = {}) {
  return mutateJson(file, (state) => {
    const next = state && typeof state === "object" ? { ...state } : {};
    next.schema = 1;
    next.providers = next.providers && typeof next.providers === "object" ? { ...next.providers } : {};
    const previous = next.providers[providerId] && typeof next.providers[providerId] === "object"
      ? next.providers[providerId]
      : {};
    next.providers[providerId] = {
      ...previous,
      repaired: { ...(previous.repaired || {}), [repairDestination()]: Math.max(repairedAt(previous), Number(repairEpoch) || 0) },
    };
    return next;
  }, { schema: 1, providers: {} });
}

/**
 * Note an install. Replacing an app older than REPAIR_EPOCH asks each agent whose
 * rows the crossed epochs touched for one full read of its history. A fresh
 * install owes nothing — no row has been written the old way — and reading
 * everything would import history the user never asked for. Returns whether a
 * repair was requested.
 */
export async function recordInstall({ upgrading = false, providerIds = [], file = scanStatePath() } = {}) {
  return mutateJson(file, (state) => {
    const next = state && typeof state === "object" ? { ...state } : {};
    next.schema = 1;
    next.providers = next.providers && typeof next.providers === "object" ? { ...next.providers } : {};
    const installed = Number(next.installedRepairEpoch) || 0;
    let requested = false;
    if (upgrading && installed < REPAIR_EPOCH && providerIds.length > 0) {
      const owed = new Set();
      for (let epoch = installed + 1; epoch <= REPAIR_EPOCH; epoch++) {
        const providers = REPAIR_PROVIDERS_BY_EPOCH[epoch];
        if (providers == null) {
          for (const id of providerIds) owed.add(id);
        } else {
          for (const id of providers) owed.add(id);
        }
      }
      for (const id of providerIds) {
        if (!owed.has(id)) continue;
        const previous = next.providers[id] && typeof next.providers[id] === "object" ? next.providers[id] : {};
        next.providers[id] = { ...previous, repairRequested: REPAIR_EPOCH };
        requested = true;
      }
    }
    next.installedRepairEpoch = Math.max(installed, REPAIR_EPOCH);
    return { data: next, value: requested };
  }, { schema: 1, providers: {} });
}

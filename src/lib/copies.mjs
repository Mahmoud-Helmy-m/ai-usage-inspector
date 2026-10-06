// One-time cleanup of turns stored twice by older versions.
//
// Before 2.6.0 a hook stored a whole session under whatever folder the agent was
// in when a turn ended, and Claude Code moves a desktop session into any project
// subfolder its own commands cd into, so those folders kept a copy of the session
// beside its own store. Branches and forks were stored under both sessions too.
// A row is removed only when a freshly read holder has at least as much work
// for that turn, and every file is backed up under its lock before it changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ABORT, LockTimeoutError, planCollapseCopies, mutateNdjson, tombstoneKey, tombstonePath, addTombstones, tokenCount, withFileLock } from "./store.mjs";
import { workspaceFile } from "./paths.mjs";

const appDir = () => path.join(os.homedir(), ".ai-usage-inspector");
export const defaultBackupDir = () => path.join(appDir(), "backups");
export const defaultReportFile = () => path.join(appDir(), "copy-cleanup.json");

// A Windows path names the same file whatever its casing.
const same = (p) => {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function readRows(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}

const sessionKey = (r) => JSON.stringify([r.provider || "claude", String(r.sessionId)]);
const costOf = (rows) => rows.reduce((n, r) => n + ((r.cost && Number(r.cost.total)) || 0), 0);

// Every store a copy could sit in. A copy lives in a folder a session was moved
// into, which its transcript names; a session whose transcript is gone still names
// its start folder in each stored row, so rows lead to more stores.
export function candidateStores(transcripts) {
  const stores = new Map();
  const aggregate = process.env.AI_USAGE_DIR;
  if (aggregate) {
    let names = [];
    try {
      names = fs.readdirSync(aggregate).filter((n) => n.endsWith(".ndjson"));
    } catch {}
    for (const n of names) stores.set(same(path.join(aggregate, n)), path.join(aggregate, n));
    return stores;
  }
  const pending = [];
  for (const t of transcripts) {
    const file = t && t.transcriptPath;
    if (typeof file !== "string") continue;
    for (const e of readRows(file)) if (e && typeof e.cwd === "string" && e.cwd) pending.push(e.cwd);
  }
  const seen = new Set();
  while (pending.length) {
    const folder = pending.pop();
    if (seen.has(same(folder))) continue;
    seen.add(same(folder));
    const file = workspaceFile(folder);
    if (!fs.existsSync(file)) continue;
    stores.set(same(file), file);
    for (const r of readRows(file)) if (typeof r.cwd === "string" && r.cwd && !seen.has(same(r.cwd))) pending.push(r.cwd);
  }
  return stores;
}

// Each session's own store, by the rule rows are now written with: the first
// folder its own turns name that still exists (the first at all in aggregate mode).
function homeStores(rowsByStore) {
  const turns = new Map();
  for (const rows of rowsByStore.values()) {
    for (const r of rows) {
      if (r.sessionId == null || typeof r.cwd !== "string" || !r.cwd) continue;
      const key = sessionKey(r);
      if (!turns.has(key)) turns.set(key, []);
      turns.get(key).push(r);
    }
  }
  const home = new Map();
  for (const [key, list] of turns) {
    const own = list.filter((r) => r.copied !== true);
    const folders = [...(own.length ? own : list)].sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")) || same(a.cwd).localeCompare(same(b.cwd))).map((r) => r.cwd);
    const folder = process.env.AI_USAGE_DIR ? folders[0] : folders.find(isDirectory);
    if (folder) home.set(key, same(workspaceFile(folder)));
  }
  return home;
}

function recoveryBackup(backupDir, now) {
  const at = now.toISOString();
  const dir = path.join(backupDir, at.replace(/[:.]/g, "-") + "-" + randomUUID());
  const files = [];
  return {
    get directory() { return files.length ? dir : null; },
    save(source, text) {
      fs.mkdirSync(dir, { recursive: true });
      const backup = path.join(dir, `${files.length + 1}.ndjson`);
      fs.writeFileSync(backup, text);
      files.push({ source, backup });
      // Publish recovery information before allowing the source to change.
      const manifest = path.join(dir, "manifest.json");
      fs.writeFileSync(manifest + ".tmp", JSON.stringify({ at, files }, null, 2) + "\n");
      fs.renameSync(manifest + ".tmp", manifest);
    },
  };
}

/** Preserve candidate Claude stores before a repair parser can rewrite them. */
export async function backupCandidateStores({ transcripts = [], backupDir = defaultBackupDir(), now = new Date() } = {}) {
  const backup = recoveryBackup(backupDir, now);
  for (const file of candidateStores(transcripts).values()) {
    const result = await withFileLock(file, () => {
      if (!readRows(file).some((r) => (r.provider || "claude") === "claude")) return;
      backup.save(file, fs.readFileSync(file, "utf8"));
    });
    if (result === false) throw new LockTimeoutError(file);
  }
  pruneBackups({ backupDir, protect: [backup.directory] });
  return backup;
}

// Each repair copies every store it may rewrite, a few tens of MB on a busy machine; kept for
// good they reached 458 MB in 14 copies. A backup is for undoing the latest repairs, so only the
// newest few are kept.
export const BACKUPS_KEPT = 3;
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}$/;

/**
 * Remove all but the newest `keep` backups. Only folders this tool wrote — its name pattern and
 * a manifest.json — are touched, and never one in `protect` (the backup a repair just took,
 * which a clock set back would sort as oldest) or the one the last cleanup report names as its
 * recovery copy. Returns the folders removed; never throws.
 */
export function pruneBackups({ backupDir = defaultBackupDir(), keep = BACKUPS_KEPT, protect = [], reportFile = defaultReportFile() } = {}) {
  const kept = new Set(protect.filter(Boolean).map((p) => path.basename(p)));
  try {
    const named = JSON.parse(fs.readFileSync(reportFile, "utf8")).backup;
    if (named) kept.add(path.basename(named));
  } catch {}
  let names = [];
  try {
    names = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && BACKUP_NAME.test(e.name) && fs.existsSync(path.join(backupDir, e.name, "manifest.json")))
      .map((e) => e.name)
      .filter((name) => !kept.has(name))
      .sort(); // ISO time first in the name, so lexical order is age order
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fs.rmSync(path.join(backupDir, name), { recursive: true, force: true });
      removed.push(name);
    } catch {}
  }
  return removed;
}

function planCleanup(rowsByStore) {
  const home = homeStores(rowsByStore);
  const copies = new Set();
  const richer = new Set();
  for (const [key, rows] of rowsByStore) for (const row of rows) {
    if ((row.provider || "claude") !== "claude" || row.sessionId == null) continue;
    const own = home.get(sessionKey(row));
    if (!own || own === key) continue;
    const holders = (rowsByStore.get(own) || []).filter((r) => tombstoneKey(r) === tombstoneKey(row));
    if (holders.some((r) => tokenCount(r) >= tokenCount(row))) copies.add(row);
    else if (holders.length) richer.add(row);
  }
  const remaining = [...rowsByStore.values()].flat().filter((r) => !copies.has(r));
  const { drop, parentOf } = planCollapseCopies(remaining);
  return { copies, richer, drop, parentOf };
}

/**
 * Remove copied rows, once. `transcripts` is the Claude provider's
 * discoverTranscripts() output. Returns a report; writes the report file and a
 * backup (with manifest) only when something changed. A dry run reports what it
 * would remove and touches nothing.
 */
export async function cleanUpCopies(options = {}) {
  const stores = candidateStores(options.transcripts || []);
  if (options.dryRun) return cleanUpLocked(options, stores);
  // Acquire ALL usage and tombstone locks before the first change. Sorting also
  // prevents competing cleanups deadlocking. A lock failure leaves every row intact.
  const files = [...new Set([...stores.values()].flatMap((f) => [f, tombstonePath(f)]))].sort();
  const acquire = async (i) => {
    if (i === files.length) return cleanUpLocked(options, stores);
    const result = await withFileLock(files[i], () => acquire(i + 1));
    if (result === false) throw new LockTimeoutError(files[i]);
    return result;
  };
  return acquire(0);
}

async function cleanUpLocked({
  transcripts = [],
  backupDir = defaultBackupDir(),
  reportFile = defaultReportFile(),
  now = new Date(),
  dryRun = false,
  backup = null,
} = {}, stores) {
  const readStores = () => new Map([...stores].map(([key, file]) => [key, readRows(file)]));
  const rowsByStore = readStores();
  const planned = planCleanup(rowsByStore);
  const recovery = backup || recoveryBackup(backupDir, now);
  const report = {
    at: now.toISOString(), dryRun, copiesRemoved: 0, copiesCost: 0,
    branchCopiesRemoved: 0, keptRicher: 0, backup: null, files: [], emptyStores: [],
  };
  const note = (file, copies, branch, left) => {
    report.copiesRemoved += copies.length;
    report.copiesCost += costOf(copies);
    report.branchCopiesRemoved += branch;
    report.files.push({ file, copiesRemoved: copies.length, branchCopiesRemoved: branch, rowsLeft: left });
    if (left === 0) report.emptyStores.push(process.env.AI_USAGE_DIR ? file : path.dirname(file));
  };
  for (const [storeKey, file] of stores) {
    let copies = [], branch = 0, left = 0;
    const apply = (records, plan) => {
      copies = records.filter((r) => plan.copies.has(r));
      branch = records.filter((r) => plan.drop.has(r)).length;
      report.keptRicher += records.filter((r) => plan.richer.has(r)).length;
      const next = records.filter((r) => !plan.copies.has(r) && !plan.drop.has(r)).map((r) => {
        const label = (r.provider || "claude") === "claude"
          ? plan.parentOf.get(String(r.sessionId)) || planned.parentOf.get(String(r.sessionId)) : null;
        return label && (r.branchOf !== label.original || r.branchResolution !== label.resolution)
          ? { ...r, branchOf: label.original, branchResolution: label.resolution } : r;
      });
      left = next.length;
      return copies.length || branch || next.some((r, i) => r !== records[i]) ? next : ABORT;
    };
    if (dryRun) {
      if (apply(rowsByStore.get(storeKey), planned) !== ABORT) note(file, copies, branch, left);
      continue;
    }
    const result = await mutateNdjson(file, async (records) => {
      // Re-read every potential holder under the lock of the file being changed.
      // A planning snapshot cannot authorize removal after another writer ran.
      const fresh = readStores();
      fresh.set(storeKey, records);
      const plan = planCleanup(fresh);
      const next = apply(records, plan);
      const removed = records.filter((r) => plan.drop.has(r));
      if (removed.length) {
        // Publish suppression before removing rows. These are copy removals, not
        // user deletions: they must never suppress the surviving session's UUID.
        recovery.save(file, fs.readFileSync(file, "utf8"));
        const tombstones = tombstonePath(file);
        if (fs.existsSync(tombstones)) recovery.save(tombstones, fs.readFileSync(tombstones, "utf8"));
        await addTombstones(tombstones, removed, { lockHeld: true, reason: "copy" });
      }
      return next;
    }, { lockHeld: true, onBeforeWrite: (currentText) => recovery.save(file, currentText) });
    if (result === false) throw new LockTimeoutError(file);
    if (result.value !== ABORT) note(file, copies, branch, left);
  }
  report.backup = recovery.directory;
  if (report.files.length && !dryRun) {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + "\n");
  }
  return report;
}

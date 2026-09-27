// Tracking + stored-field config.
//
// Model: each project owns its config in <project>/.ai-usage/config.json
// (the same file the viewer uses for title/port/ui). On a project's first sight
// it is SEEDED from the global defaults template at ~/.ai-usage-inspector/
// config.json, then it is authoritative for that project. Aggregate mode
// (AI_USAGE_DIR) uses the aggregate directory's config, with those defaults as
// its fallback.
//
// IMPORTANT: this file must stay SELF-CONTAINED — node builtins only, inline
// `encCwd`. install.mjs copies it next to the viewer (app/viewer/config.mjs) so
// the per-project bundle (which ships viewer/ ONLY) can import it too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

// The selectable field groups (all on by default).
export const FIELD_GROUPS = ["text", "tokens", "cost", "context", "timing", "skills", "counts", "subagents", "meta"];

export function globalConfigPath() {
  return path.join(os.homedir(), ".ai-usage-inspector", "config.json");
}

// Keep identical to paths.mjs `encCwd` (duplicated to stay bundle-importable).
export function encCwd(cwd) {
  return String(cwd || "").replace(/[:\\/]/g, "-").replace(/^-+|-+$/g, "");
}

function defaultFields() {
  const f = {};
  for (const g of FIELD_GROUPS) f[g] = true;
  return f;
}
function loadJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

// The global file is a DEFAULTS TEMPLATE only: { enabledDefault, fields }.
// Old-shape files (with tracking.projects) are ignored — only fields are read.
export function loadGlobalDefaults() {
  const c = loadJson(globalConfigPath());
  const fields = defaultFields();
  if (c.fields && typeof c.fields === "object") {
    for (const g of FIELD_GROUPS) if (typeof c.fields[g] === "boolean") fields[g] = c.fields[g];
  }
  const enabledDefault = typeof c.enabledDefault === "boolean" ? c.enabledDefault : true;
  return { schema: 2, enabledDefault, fields };
}
export function defaultGlobalConfig() {
  return { schema: 2, enabledDefault: true, fields: defaultFields() };
}

// <cwd>/.ai-usage/config.json — or null in aggregate mode (no per-project folder).
export function projectConfigPath(cwd) {
  if (process.env.AI_USAGE_DIR) return null;
  return path.join(cwd, ".ai-usage", "config.json");
}

/**
 * The one config governing aggregate mode, where every project pools into a
 * single directory and there is no per-project folder to hold settings. The
 * dashboard writes it; capture has to read it, or its switches do nothing.
 */
export function aggregateConfigPath() {
  return process.env.AI_USAGE_DIR
    ? path.join(process.env.AI_USAGE_DIR, "config.json")
    : null;
}

export function isEnabled(cfg) {
  return !(cfg && cfg.tracking) || cfg.tracking.enabled !== false;
}

// Ensure a project has tracking+fields, seeding from the global defaults the
// first time (merged into any existing {title,port,ui} without clobbering).
// Returns the effective config. In aggregate mode merges its own config over
// the global defaults (no file written).
export async function ensureProjectConfig(cwd) {
  const def = loadGlobalDefaults();
  const file = projectConfigPath(cwd);
  if (!file) {
    // Aggregate mode: honour the dashboard's own switches, falling back to the
    // global defaults for anything it has not set.
    const agg = loadJson(aggregateConfigPath() || "");
    const fields = { ...def.fields };
    if (agg.fields && typeof agg.fields === "object") {
      for (const g of FIELD_GROUPS) if (typeof agg.fields[g] === "boolean") fields[g] = agg.fields[g];
    }
    const enabled = agg.tracking && typeof agg.tracking.enabled === "boolean"
      ? agg.tracking.enabled
      : def.enabledDefault;
    return { tracking: { enabled }, fields };
  }

  const cur = loadJson(file);
  const complete =
    cur.tracking && typeof cur.tracking.enabled === "boolean" &&
    cur.fields && FIELD_GROUPS.every((g) => typeof cur.fields[g] === "boolean");
  if (complete) return cur;

  const next = await mutateFile(file, (c) => {
    c.tracking = c.tracking && typeof c.tracking === "object" ? c.tracking : {};
    if (typeof c.tracking.enabled !== "boolean") c.tracking.enabled = def.enabledDefault;
    c.fields = c.fields && typeof c.fields === "object" ? c.fields : {};
    for (const g of FIELD_GROUPS) if (typeof c.fields[g] !== "boolean") c.fields[g] = def.fields[g];
  });
  if (next) return next;
  // Lock unavailable — fall back to an in-memory seed so this run still works.
  return {
    ...cur,
    tracking: { enabled: typeof (cur.tracking || {}).enabled === "boolean" ? cur.tracking.enabled : def.enabledDefault, ...(cur.tracking || {}) },
    fields: { ...def.fields, ...(cur.fields || {}) },
  };
}

// ---- cross-process lock (same algorithm as src/lib/store.mjs, inlined) ----
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempName = (file) => `${file}.${process.pid}.${randomUUID()}.tmp`;

function readLockToken(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

function removeOwnedLock(file, token) {
  try {
    if (readLockToken(file) === token) fs.rmSync(file, { force: true });
  } catch {}
}

// Read-modify-write any JSON config file under an exclusive lock. Returns the
// saved object, or null if the lock couldn't be taken (caller best-effort).
export async function mutateFile(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  while (true) {
    try {
      fd = fs.openSync(lock, "wx");
      fs.writeFileSync(fd, token, "utf8");
      break;
    } catch (err) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
        fd = null;
      }
      if (err.code !== "EEXIST") throw err;
      try {
        const seen = readLockToken(lock);
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (seen !== null && age > LOCK_STALE_MS && readLockToken(lock) === seen) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) return null;
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    const obj = loadJson(file);
    fn(obj);
    const tmp = tempName(file);
    try {
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
      fs.renameSync(tmp, file);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
    return obj;
  } finally {
    try { fs.closeSync(fd); } catch {}
    removeOwnedLock(lock, token);
  }
}

// Map each field group to the record keys it controls. Core keys
// (id, sessionId, cwd, workspace, ts, model, permissionMode, schema) are never
// stripped — the viewer needs them for identity, grouping, filters and axes.
const GROUP_KEYS = {
  text: ["prompt", "response"], // promptChars/responseChars are sizes, kept
  tokens: ["usage"],
  cost: ["cost"],
  context: ["contextTokens", "contextMax", "contextFillPct"],
  timing: ["durationMs", "endTs", "firstResponseMs"],
  skills: ["skills"],
  counts: ["counts"],
  subagents: ["subagents"],
  meta: ["vendor", "slug", "gitBranch", "cliVersion", "entrypoint", "serviceTier", "speed", "effortLevel", "sessionName", "sessionTitle"],
};

// A subagent run carries its own share of what these groups control, so turning
// one off has to reach inside the run tree as well.
const RUN_GROUP_KEYS = {
  meta: ["vendor"],
  context: ["contextTokens", "contextMax", "contextFillPct"],
  counts: ["counts"],
  text: ["description"],
  tokens: ["usage"],
  cost: ["cost"],
  timing: ["durationMs", "endTs"],
};

function runKeysOff(fields) {
  const keys = [];
  for (const [g, ks] of Object.entries(RUN_GROUP_KEYS)) if (fields && fields[g] === false) keys.push(...ks);
  return keys;
}

function stripRuns(runs, keys) {
  return runs.map((run) => {
    const out = { ...run };
    for (const k of keys) delete out[k];
    if (Array.isArray(out.subagents)) out.subagents = stripRuns(out.subagents, keys);
    return out;
  });
}

function restoreRuns(runs, previous, keys) {
  const byAgent = new Map((Array.isArray(previous) ? previous : [])
    .filter((run) => run && run.agentId != null)
    .map((run) => [run.agentId, run]));
  return runs.map((run) => {
    const prior = byAgent.get(run.agentId);
    if (!prior) return run;
    const out = { ...run };
    for (const k of keys) if (out[k] === undefined && prior[k] !== undefined) out[k] = prior[k];
    if (Array.isArray(out.subagents)) out.subagents = restoreRuns(out.subagents, prior.subagents, keys);
    return out;
  });
}

// Return a shallow clone of `record` with disabled groups' keys removed.
export function applyFieldSelection(record, fields) {
  const out = { ...record };
  for (const g of FIELD_GROUPS) {
    if (fields && fields[g] === false) for (const k of GROUP_KEYS[g]) delete out[k];
  }
  const nested = runKeysOff(fields);
  if (nested.length && Array.isArray(out.subagents)) out.subagents = stripRuns(out.subagents, nested);
  return out;
}

/**
 * Carry already-stored values through a reparse of the same turn.
 *
 * Turning a field group off means "stop recording this", not "delete what you
 * already recorded". Without this, any later reparse of a session — a following
 * turn, or a sweep — rewrote its rows with the group stripped, so history the
 * user had already collected disappeared as a side effect of a settings change.
 * Only groups that are currently OFF are restored, and only from the row that
 * was already on disk.
 */
export function preserveStoredFields(next, previous, fields) {
  if (!previous) return next;
  const out = { ...next };
  for (const g of FIELD_GROUPS) {
    if (!fields || fields[g] !== false) continue;
    for (const k of GROUP_KEYS[g]) {
      if (out[k] === undefined && previous[k] !== undefined) out[k] = previous[k];
    }
  }
  const nested = runKeysOff(fields);
  if (nested.length && Array.isArray(out.subagents) && Array.isArray(previous.subagents)) {
    out.subagents = restoreRuns(out.subagents, previous.subagents, nested);
  }
  // Only a hook can see the effort setting; a sweep reads the transcript alone,
  // and its blank used to replace what the hook had recorded.
  if (out.effortLevel == null && previous.effortLevel != null) out.effortLevel = previous.effortLevel;
  return out;
}

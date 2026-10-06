// Provider-neutral ingestion: turn a hook payload into stored turn records.
// Shared by every provider; the provider supplies payload normalization, the
// transcript parser, and (at install time) its own hook wiring.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertSession, ABORT, readNdjson, tombstoneKey } from "./store.mjs";
import { workspaceFile, workspaceLabel } from "./paths.mjs";
import { ensureProjectConfig, isEnabled, applyFieldSelection, preserveStoredFields } from "./config.mjs";
import { hookPricing } from "./hook-pricing.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bump when the bundled viewer changes so existing projects refresh their copy
// on the next prompt (after the user re-installs the app via npx).
// 21: bundles written by a sweep run from a checkout are missing the settings
// module and cannot start; every bundle is rewritten once to repair them.
// 22: interactive time charts (readout, zoom) and a since/until date range.
// 23: each subagent run's own context fill, beside the main thread's.
// 24: chart overlays that stay hidden, zoom controls with cost alone, a zoom the
// filters moved past dropped, and a dashboard that names its store to sync.
// 25: calendar chart explorer, stacked series, overview and accessible readouts.
// 26: faster shared chart models, token small multiples, context peaks and saved chart preferences.
// 27: opencode subagent sessions nest under their parent like codex's do.
// 28: consistent unknown context and visible isolated context observations.
// 29: usage-patterns overview as one labelled range selector with square-root strip.
// 30: overview handles as solid grips on the window edges, each labelled with its date; unselected days dimmed.
// 31: slim overview grips; the grab area stays wider than the drawn bar.
// 32: a plain wheel over a chart scrolls the page; Ctrl/⌘ + wheel or a pinch zooms.
// 33: Safari trackpad pinch zooms the time charts.
// 34: session rows show the summed duration of their turns.
// 35: model vendor filter, prompt detail metadata and CSV column.
// 36: the Codex price sidecar reads OpenAI's official page into a new cache schema; an older
//     copy would keep rewriting that cache in the old one.
// 37: shared models.dev prices and Claude fast-mode pricing sidecars.
// 38: Codex service tiers and models.dev context tiers.
// 39: the refresh button syncs (new turns, due rates, estimates); start-up stops refetching every rate.
// 40: dashboard syncs check rates over an hour old.
// 41: the models.dev sidecar allows 30 seconds for its ~5 MB body.
// 42: the server refuses other hosts, and changes or exports without the dashboard header.
export const VIEWER_VERSION = "42";

// A project gets viewer/ and nothing else — no src/ tree beside it — so the
// modules the bundled dashboard imports are copied in next to it, under the
// names it looks for. One list, used by the installer when it builds the app and
// by ensureBundle when it writes a project's copy, so a bundle is never missing
// a module because of which tree it was written from.
export const VIEWER_SIDECARS = [
  ["lib/config.mjs", "config.mjs"],
  ["lib/store.mjs", "store.mjs"],
  ["lib/vendors/modelsdev/remote-pricing.mjs", "remote-pricing-modelsdev.mjs"],
  ["lib/vendors/zai/remote-pricing.mjs", "remote-pricing-zai.mjs"],
  ["providers/claude/remote-pricing.mjs", "remote-pricing.mjs"],
  ["providers/codex/remote-pricing.mjs", "remote-pricing-codex.mjs"],
  ["providers/cursor/remote-pricing.mjs", "remote-pricing-cursor.mjs"],
];

/** Put those modules beside a viewer copy. Existing files are left alone. */
export function copyViewerSidecars(viewerDir, srcRoot = path.join(__dirname, "..")) {
  for (const [from, name] of VIEWER_SIDECARS) {
    const target = path.join(viewerDir, name);
    if (fs.existsSync(target)) continue;
    const source = path.join(srcRoot, ...from.split("/"));
    if (fs.existsSync(source)) fs.copyFileSync(source, target);
  }
}

// The file a user double-clicks to see their dashboard, so nobody has to open a
// terminal and remember a path. It is deliberately thin: it only runs
// viewer/launch.mjs, which holds all the logic and is refreshed with the bundle.
// Paths are relative to the file itself, so moving or renaming the project keeps
// it working.
export function launcherName(platform = process.platform) {
  return {
    win32: "Open dashboard.cmd",
    darwin: "Open dashboard.command",
  }[platform] || "open-dashboard.sh";
}

function launcherBody(platform) {
  if (platform === "win32") {
    return [
      "@echo off",
      "rem  AI Usage Inspector - opens this project's dashboard.",
      "rem  Generated file: it is rewritten when the viewer is updated.",
      // Forward slash on purpose: node accepts it on Windows, and it keeps this
      // template free of backslash escaping that is easy to get wrong.
      'node "%~dp0viewer/launch.mjs" %*',
      "if errorlevel 1 pause",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    "#  AI Usage Inspector - opens this project's dashboard.",
    "#  Generated file: it is rewritten when the viewer is updated.",
    'exec node "$(dirname "$0")/viewer/launch.mjs" "$@"',
    "",
  ].join("\n");
}

function ensureLauncher(base, platform = process.platform) {
  const file = path.join(base, launcherName(platform));
  const body = launcherBody(platform);
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body) fs.writeFileSync(file, body);
    // Archives and Windows copies can preserve the bytes but lose execution.
    if (platform !== "win32") fs.chmodSync(file, 0o755);
  } catch {}
}

export function ensureLauncherForTest(base, platform) {
  ensureLauncher(base, platform);
}

// Make each project self-contained: copy the viewer + a default config into
// <project>/.ai-usage/ so it can be viewed in place. Skipped in aggregate mode
// (AI_USAGE_DIR). Idempotent and best-effort.
export function ensureBundleForTest(cwd) {
  return ensureBundle(cwd);
}

function ensureBundle(cwd) {
  if (process.env.AI_USAGE_DIR) return;
  try {
    const base = path.join(cwd, ".ai-usage");
    const viewerSrc = path.join(__dirname, "..", "..", "viewer");
    const viewerDst = path.join(base, "viewer");
    const verFile = path.join(viewerDst, ".version");
    const have = fs.existsSync(verFile) ? fs.readFileSync(verFile, "utf8").trim() : null;
    const stale = !fs.existsSync(path.join(viewerDst, "server.mjs")) || have !== VIEWER_VERSION;
    if (fs.existsSync(viewerSrc) && stale) {
      fs.rmSync(viewerDst, { recursive: true, force: true });
      fs.cpSync(viewerSrc, viewerDst, { recursive: true });
      // An installed app carries these already; a sweep run straight from a
      // checkout copies that checkout's viewer/, which carries none of them, and
      // every bundle it wrote would die on an import before it could listen.
      // Whatever tree this came from, the bundle leaves here able to run.
      copyViewerSidecars(viewerDst);
      fs.writeFileSync(verFile, VIEWER_VERSION + "\n");
    }
    const cfgFile = path.join(base, "config.json");
    fs.mkdirSync(base, { recursive: true });
    // Usage records carry prompt and response text. A folder that ignores itself
    // stays out of `git add -A` in any repository it lands in. An ignore file that
    // is already there is the user's decision and is left as it is.
    const ignoreFile = path.join(base, ".gitignore");
    if (!fs.existsSync(ignoreFile)) {
      fs.writeFileSync(ignoreFile, "# Written by AI Usage Inspector: keeps usage records, prompts included, out of git.\n*\n");
    }
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) || {}; } catch {}
    let changed = false;
    if (!cfg.title) { cfg.title = path.basename(cwd); changed = true; }
    if (!cfg.ui || typeof cfg.ui !== "object") { cfg.ui = {}; changed = true; }
    if (changed) fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    ensureLauncher(base);
  } catch {}
}

const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folder a session's rows belong to: the one it started in.
 *
 * A hook reports wherever the agent is when a turn ends, and Claude Code moves a
 * desktop session into any project subfolder its own commands `cd` into. Stored
 * under that folder, a whole session was copied into the subfolder beside the
 * original. The first turn names where the session began, which is also what a
 * sweep uses, so the two paths agree. A start folder that no longer exists gives
 * way to the next folder a turn names, then to the caller's, so a project that
 * moved keeps recording. With no folder left, the session is stale history.
 */
function homeFolder(group, fallback) {
  const own = group.filter((t) => t.copied !== true);
  const named = (own.length ? own : group).map((t) => t.cwd).filter((c) => typeof c === "string" && c);
  // Aggregate mode creates nothing in the project, so a folder need not exist.
  if (process.env.AI_USAGE_DIR) return named[0] || fallback || null;
  return named.find(isDirectory) || (fallback && isDirectory(fallback) ? fallback : null);
}

// Shared tail: group, place, field-select, upsert, bundle. Returns turns written.
async function storeTurns(turns, fallbackCwd, sessionId, precondition = null, transcriptId = null) {
  // One transcript can hold turns of more than one session, and each session is
  // replaced on its own: written under the first, the others were appended beside
  // their earlier copies on every re-read. A turn that names no session belongs
  // to the one the caller identified.
  const fallbackSession = sessionId || (turns[0] && turns[0].sessionId);
  const sessions = new Map();
  for (const t of turns) {
    const sid = t.sessionId || fallbackSession;
    if (!sid) continue;
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid).push(t);
  }

  let written = 0;
  const configs = new Map();
  const homes = new Set();
  for (const [sid, group] of sessions) {
    const home = homeFolder(group, fallbackCwd);
    if (!home) continue;
    // Per-project tracking config gates the project the rows go to.
    if (!configs.has(home)) configs.set(home, await ensureProjectConfig(home));
    const cfg = configs.get(home);
    if (!isEnabled(cfg)) continue;
    const workspace = workspaceLabel(home);
    const slim = group.map((t) => applyFieldSelection({ ...t, workspace }, cfg.fields));
    const n = await upsertSession(workspaceFile(home), sid, slim, {
      precondition,
      // A field turned off stops new recording; it does not erase what is stored.
      preserveFields: (r, prior) => preserveStoredFields(r, prior, cfg.fields),
      transcriptId,
    });
    if (n === ABORT) {
      // An OpenCode session whose turns are stored but whose newest turn has no
      // usage yet is left as stored, and the read counts as done. When the turn
      // completes the session changes and is read again; a session that crashed
      // mid-turn must not hold the scan mark and the repair open forever.
      if (group.some((r) => r.provider === "opencode" && r.quality === "session-rollup")) continue;
      const err = new Error("transcript changed before the write");
      err.scanStatus = "locked";
      err.transcriptMoved = true;
      throw err;
    }
    written += n;
    homes.add(home);
  }
  for (const home of homes) ensureBundle(home);
  return written;
}

/**
 * Ingest one provider's hook event (raw stdin string). Best-effort: never
 * throws to the caller. Returns the number of turns written.
 */
export async function ingest(provider, raw, pricing) {
  const { sessionId, cwd, transcriptPath, opts } = provider.normalizePayload(raw);
  if (!transcriptPath || !cwd) return 0;

  return ingestTranscript(provider, { transcriptPath, cwd, sessionId,
    opts: { ...opts, hookPricing: pricing || hookPricing(provider.id, cwd) } });
}

/**
 * A marker that changes when the source behind a transcript changes.
 *
 * Only Claude and Codex hand us a file path; Cursor, OpenCode and the Cline
 * family pass an opaque reference to a row in their own store, so they supply
 * their own stamp. A provider that offers none gets no protection — that is
 * visible here rather than silently true.
 */
function transcriptStamp(provider, transcriptPath) {
  if (provider && typeof provider.stampTranscript === "function") {
    try {
      return provider.stampTranscript(transcriptPath);
    } catch (err) {
      if (provider.id === "claude") {
        err.scanStatus = "locked";
        throw err;
      }
      return null;
    }
  }
  if (typeof transcriptPath !== "string") return null;
  try {
    const st = fs.statSync(transcriptPath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Which transcript a batch was read from, when the provider can say. Codex keeps
 * a reverted thread in more than one rollout, so the store has to know which file
 * wrote which rows. A provider that keeps one source per session names nothing,
 * and its batches replace the whole session as they always have.
 */
function transcriptIdOf(provider, transcriptPath) {
  if (!provider || typeof provider.transcriptId !== "function") return null;
  try {
    const value = provider.transcriptId(transcriptPath);
    return value == null || value === "" ? null : String(value);
  } catch {
    return null;
  }
}

/**
 * Ingest one transcript directly (backfill/sync path — no hook payload).
 * cwd may be unknown up front; it's recovered from the parsed turns. The same
 * per-project tracking config gates ingestion, so disabled projects are
 * skipped exactly like on the hook path. Returns the number of turns written.
 */
export async function ingestTranscript(provider, { transcriptPath, cwd, sessionId, opts } = {}) {
  if (!transcriptPath) return 0;
  // Parsing happens outside the usage lock, so a scan that started before the
  // agent appended its newest turn would take the lock afterwards and replace
  // the session with its older snapshot. If the file moved under us, drop this
  // pass: the scan mark does not advance, so the next sweep re-reads it whole.
  const before = transcriptStamp(provider, transcriptPath);
  // Resolve billing metadata before pricing, including --reprice and token growth.
  // Use the same session home and composite identity as the eventual upsert.
  const stored = new Map(), homes = new Map();
  const pricingForTurn = (row, peers) => {
    if (!homes.has(row.sessionId)) homes.set(row.sessionId, homeFolder(peers.filter((r) => r.sessionId === row.sessionId), cwd));
    const home = homes.get(row.sessionId);
    if (!home) return {};
    const file = workspaceFile(home);
    if (!stored.has(file)) stored.set(file, new Map(readNdjson(file).records.map((r) => [tombstoneKey(r), r])));
    const prior = stored.get(file).get(tombstoneKey(row));
    return { serviceTier: prior?.serviceTier, endpoint: prior?.endpoint };
  };
  const turns = await provider.buildTurns(transcriptPath, { ...opts, pricingForTurn });
  if (before !== null && transcriptStamp(provider, transcriptPath) !== before) {
    const err = new Error("transcript changed while being parsed");
    err.scanStatus = "locked";
    err.transcriptMoved = true;
    throw err;
  }
  if (!turns.length) return 0;

  // Rows go where each session started. A session none of whose folders still
  // exists is stale history and is skipped, except in aggregate mode, where
  // records pool centrally and nothing is created in the project.
  // Checked again under the write lock: config work and the lock queue both take
  // time, and the agent may have appended a turn in the meantime.
  return storeTurns(
    turns, cwd || null, sessionId,
    () => before === null || transcriptStamp(provider, transcriptPath) === before,
    transcriptIdOf(provider, transcriptPath),
  );
}

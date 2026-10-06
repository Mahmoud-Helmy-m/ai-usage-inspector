#!/usr/bin/env node
// Self-contained, zero-dependency viewer. Reads ONE project's records + config
// from a `.ai-usage` folder and serves the dashboard.
//
// It figures out which folder to read, in priority order:
//   1. $AI_USAGE_DIR                           (explicit / aggregate mode)
//   2. its own sibling folder, when this file was copied into a project at
//      <project>/.ai-usage/viewer/server.mjs   → reads <project>/.ai-usage
//   3. <argv path>/.ai-usage  or  <cwd>/.ai-usage
//
//   node server.mjs                 # reads ./.ai-usage
//   node server.mjs /path/to/proj   # reads that project
//   node server.mjs --port 8080     # or PORT=8080 / config.json "port"
//   node server.mjs --no-sync       # do not run background history sync
//   node server.mjs --no-pricing-refresh
//
// Port priority: --port flag > $PORT > config.json "port" > first free port
// starting at 4317 (auto-picked so it never fails to start).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureRuntimeDir, runtimePaths } from "./runtime.mjs";
import { createSseRegistry } from "./sse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");

function parseArgs(argv) {
  let port = null;
  let projectPath = null;
  let help = false;
  let noSync = false;
  let noPricingRefresh = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--no-sync") {
      noSync = true;
    } else if (a === "--no-pricing-refresh") {
      noPricingRefresh = true;
    } else if (a === "--port" || a === "-p") {
      port = Number(argv[++i]);
    } else if (a.startsWith("--port=")) {
      port = Number(a.slice("--port=".length));
    } else if (!a.startsWith("-")) {
      projectPath = a;
    } else {
      throw new Error(`unknown option: ${a}`);
    }
  }
  return { port, projectPath, help, noSync, noPricingRefresh };
}
function help() {
  console.log(`
  AI Usage Inspector viewer

  Usage
    node viewer/server.mjs [project] [--port N]
    node viewer/server.mjs --no-sync --no-pricing-refresh

  Serves the .ai-usage dashboard for one project, or AI_USAGE_DIR when set.
`);
}
let ARGS;
try {
  ARGS = parseArgs(process.argv);
} catch (err) {
  console.error(err && err.message);
  process.exit(1);
}
if (ARGS.help) {
  help();
  process.exit(0);
}

// Field/defaults config module. In a bundled project it sits beside this file
// (viewer/config.mjs, placed there by the installer); when running from the repo
// it lives at ../src/lib/config.mjs. Try the bundle path, fall back to repo.
let CFG;
try {
  CFG = await import("./config.mjs");
} catch {
  CFG = await import("../src/lib/config.mjs");
}

// Same bundle-or-repo lookup for lock-guarded usage/tombstone mutations.
let STORE;
try {
  STORE = await import("./store.mjs");
} catch {
  STORE = await import("../src/lib/store.mjs");
}

// Same bundle-or-repo dance for the per-provider pricing refreshers. On a fresh
// install a module may not be bundled yet; degrade silently if so.
async function loadPricing(bundle, repo) {
  try {
    return await import(bundle);
  } catch {
    try {
      return await import(repo);
    } catch {
      return null;
    }
  }
}
const PRICING = [
  { label: "models.dev", mod: await loadPricing("./remote-pricing-modelsdev.mjs", "../src/lib/vendors/modelsdev/remote-pricing.mjs") },
  { label: "z.ai", mod: await loadPricing("./remote-pricing-zai.mjs", "../src/lib/vendors/zai/remote-pricing.mjs") },
  { label: "claude", mod: await loadPricing("./remote-pricing.mjs", "../src/providers/claude/remote-pricing.mjs") },
  { label: "openai", mod: await loadPricing("./remote-pricing-codex.mjs", "../src/providers/codex/remote-pricing.mjs") },
  { label: "cursor", mod: await loadPricing("./remote-pricing-cursor.mjs", "../src/providers/cursor/remote-pricing.mjs") },
].filter((p) => p.mod);

function resolveDataDir() {
  if (process.env.AI_USAGE_DIR) return process.env.AI_USAGE_DIR;
  // Bundled inside a project: <project>/.ai-usage/viewer/server.mjs
  if (
    path.basename(__dirname) === "viewer" &&
    path.basename(path.dirname(__dirname)) === ".ai-usage"
  ) {
    return path.dirname(__dirname);
  }
  const base = ARGS.projectPath ? path.resolve(ARGS.projectPath) : process.cwd();
  return path.join(base, ".ai-usage");
}

const DATA_DIR = resolveDataDir();
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const TOMBSTONE_FILE = path.join(DATA_DIR, "tombstones.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// ---- per-project config (title/port/ui + tracking + stored fields) ----
function loadConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {}
  if (!c.title) c.title = path.basename(path.dirname(DATA_DIR)) || "workspace";
  if (!c.ui || typeof c.ui !== "object") c.ui = {};
  // Surface tracking + fields (seed a view from the global defaults so the
  // settings panel always has values, even before the hook has written them).
  const def = CFG.loadGlobalDefaults();
  c.tracking = { enabled: def.enabledDefault, ...(c.tracking || {}) };
  c.fields = { ...def.fields, ...(c.fields || {}) };
  return c;
}
function saveConfig(patch) {
  const c = loadConfig();
  const next = {
    ...c, ...patch,
    ui: { ...c.ui, ...(patch && patch.ui) },
    tracking: { ...c.tracking, ...(patch && patch.tracking) },
    fields: { ...c.fields, ...(patch && patch.fields) },
  };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  } catch {}
  return next;
}

const requestedPort = ARGS.port || Number(process.env.PORT) || loadConfig().port;
// Bind to loopback by default — the dashboard serves prompt/response text and a
// DELETE API, so it must not be reachable across the LAN unless explicitly opted
// in (AI_USAGE_HOST=0.0.0.0).
const HOST = process.env.AI_USAGE_HOST || "127.0.0.1";

// ---- data ----
function loadEvents() {
  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return [];
  }
  const tombstones = STORE.loadTombstoneKeys(TOMBSTONE_FILE);
  const events = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(DATA_DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const event = JSON.parse(s);
        if (!tombstones.has(STORE.tombstoneKey(event))) events.push(event);
      } catch {}
    }
  }
  events.sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0));
  return events;
}

function toListItem(e) {
  const { prompt, response, ...rest } = e;
  return {
    ...rest,
    promptPreview: (prompt || "").slice(0, 280),
    responsePreview: (response || "").slice(0, 280),
  };
}

// Full-text match against the STORED prompt/response — the list payload only
// carries 280-char previews, so text search has to happen here, server-side,
// or it silently misses every hit past the preview cut-off.
function matchesQuery(e, q) {
  if (!q) return true;
  const runText = (runs) => (Array.isArray(runs) ? runs : []).flatMap((run) =>
    [run.agentType, run.description, ...runText(run.subagents)]);
  const hay = [e.prompt, e.response, e.slug, e.workspace, e.model,
    e.sessionName, e.sessionTitle, e.agent?.nickname, ...runText(e.subagents)]
    .map((v) => (typeof v === "string" ? v : ""))
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

// Persistently remove records by composite identity across all ndjson files.
// Tombstones survive sync; shared locked mutation prevents ingest/delete races.
async function deleteEvents(keys, ids) {
  const wanted = new Set((keys || []).filter(Boolean).map(STORE.tombstoneKey));
  const legacyIds = new Set((ids || []).filter((id) => id != null).map(String));
  if (!wanted.size && !legacyIds.size) return { removed: 0, bytesFreed: 0 };

  const targets = loadEvents().filter(
    (e) => wanted.has(STORE.tombstoneKey(e)) || legacyIds.has(String(e.id)),
  );
  if (!targets.length) return { removed: 0, bytesFreed: 0 };
  const tombstoned = await STORE.addTombstones(TOMBSTONE_FILE, targets);
  if (tombstoned === false) return { removed: 0, bytesFreed: 0, error: "tombstone-lock-timeout" };
  const targetKeys = new Set(targets.map(STORE.tombstoneKey));

  let files = [];
  try {
    files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return { removed: 0, bytesFreed: 0 };
  }
  let removed = 0,
    bytesFreed = 0;
  for (const f of files) {
    const fp = path.join(DATA_DIR, f);
    try {
      const result = await STORE.mutateNdjson(fp, (records) => {
        const kept = records.filter((e) => !targetKeys.has(STORE.tombstoneKey(e)));
        return { records: kept, value: records.length - kept.length };
      });
      if (result === false) continue;
      removed += result.value;
      bytesFreed += Math.max(0, result.beforeBytes - result.afterBytes);
    } catch {}
  }
  return { removed, bytesFreed };
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
const readBody = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });

// ---- live updates (SSE) ----
// Records arrive from a detached worker while the page is open, so the dashboard
// watches the data dir and tells connected clients to refetch. fs.watch is not
// reliable on every filesystem (network shares, some containers), so a slow mtime
// poll backs it up; both funnel through the same debounce.
let watching = false;
const clients = createSseRegistry({ onDrop: () => armIdleExit() });

function notifyClients() {
  clients.notify();
}

function dataFingerprint() {
  try {
    return fs
      .readdirSync(DATA_DIR)
      .filter((f) => f.endsWith(".ndjson"))
      .map((f) => {
        try {
          const s = fs.statSync(path.join(DATA_DIR, f));
          return `${f}:${s.size}:${s.mtimeMs}`;
        } catch {
          return f;
        }
      })
      .join("|");
  } catch {
    return "";
  }
}

function startWatching() {
  if (watching) return;
  watching = true;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const w = fs.watch(DATA_DIR, { persistent: false }, (_e, name) => {
      if (!name || String(name).endsWith(".ndjson")) notifyClients();
    });
    w.on("error", () => {});
  } catch {}
  let last = dataFingerprint();
  const poll = setInterval(() => {
    const now = dataFingerprint();
    if (now !== last) {
      last = now;
      notifyClients();
    }
  }, 4000);
  if (poll.unref) poll.unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;
  try {
    if (!localHost(req)) return send(res, 403, "forbidden", "text/plain");
    // Changes and full-text exports come only from this dashboard's own page (see localHost).
    const changing = (route === "/api/config" && req.method === "POST")
      || (route === "/api/events" && req.method === "DELETE")
      || route === "/api/export";
    if (changing && !fromDashboard(req)) return send(res, 403, JSON.stringify({ error: "forbidden" }));
    if (route === "/api/status") {
      // A verified reuse happens just before the browser opens. Resetting only
      // for a launcher that knows our nonce closes the verify-to-open idle race.
      if (LAUNCHER_MODE && req.headers["x-ai-usage-launcher"] === LAUNCH_NONCE) armIdleExit();
      return send(res, 200, JSON.stringify({
        app: "ai-usage-inspector",
        nonce: LAUNCH_NONCE,
        dataDir: DATA_DIR,
        clients: clients.size,
      }));
    }
    if (route === "/api/events") {
      if (req.method === "DELETE") {
        let body = {};
        try {
          body = JSON.parse(await readBody(req)) || {};
        } catch {}
        return send(res, 200, JSON.stringify(await deleteEvents(body.keys, body.ids)));
      }
      return send(res, 200, JSON.stringify(loadEvents().map(toListItem)));
    }
    // Full-text search over stored prompt/response. Returns only the matching
    // composite keys, so the client keeps its complete record set (the
    // "this month" total stays search-independent) and the payload stays small.
    if (route === "/api/search") {
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (!q) return send(res, 200, JSON.stringify({ q: "", keys: null }));
      const keys = loadEvents()
        .filter((e) => matchesQuery(e, q))
        .map(STORE.tombstoneKey);
      return send(res, 200, JSON.stringify({ q, keys }));
    }
    // Live change feed: one event whenever the data dir changes, so an open
    // dashboard picks up turns recorded by the background worker.
    if (route === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      clearTimeout(idleTimer);
      startWatching();
      clients.add(req, res);
      return;
    }
    // Export the FULL stored records (prompt/response included) for the given
    // composite keys — the list endpoint only ships previews, so exporting
    // straight from the table would silently drop the real text.
    if (route === "/api/export" && req.method === "POST") {
      let body = {};
      try {
        body = JSON.parse(await readBody(req)) || {};
      } catch {}
      const wanted = new Set((body.keys || []).filter(Boolean).map(STORE.tombstoneKey));
      const rows = wanted.size
        ? loadEvents().filter((e) => wanted.has(STORE.tombstoneKey(e)))
        : [];
      return send(res, 200, JSON.stringify(rows));
    }
    if (route.startsWith("/api/event/")) {
      const id = decodeURIComponent(route.slice("/api/event/".length));
      // An id is unique only within its provider and session — a Codex subagent
      // thread repeats its parent's turn ids — so the drawer names all three. A
      // request without them still resolves by id alone.
      const provider = url.searchParams.get("provider");
      const session = url.searchParams.get("session");
      const e = loadEvents().find((x) => x.id === id
        && (provider === null || (x.provider || "claude") === provider)
        && (session === null || (x.sessionId == null ? "" : String(x.sessionId)) === session));
      return e ? send(res, 200, JSON.stringify(e)) : send(res, 404, "{}");
    }
    if (route === "/api/sync" && req.method === "POST") {
      const { status, body } = requestSync(req);
      return send(res, status, JSON.stringify(body));
    }
    if (route === "/api/config") {
      if (req.method === "POST") {
        let patch = {};
        try {
          patch = JSON.parse(await readBody(req)) || {};
        } catch {}
        return send(res, 200, JSON.stringify(saveConfig(patch)));
      }
      return send(res, 200, JSON.stringify(loadConfig()));
    }
    // static
    let rel = (route === "/" ? "/index.html" : route).replace(/\.\.+/g, "");
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (err) {
    if (err.code === "ENOENT") return send(res, 404, "not found", "text/plain");
    return send(res, 500, "error", "text/plain");
  }
});

// ---- launcher mode ----------------------------------------------------------
// Started by a double-clicked launcher rather than a terminal. The launcher has
// no console to report into, so the server records where it is listening and
// proves its identity on /api/status; and because nobody is watching a window to
// close, it stops on its own once the last dashboard has gone.
const LAUNCH_NONCE = process.env.AI_USAGE_INSTANCE || null;
const LAUNCHER_MODE = !!LAUNCH_NONCE;
const IDLE_EXIT_MS = Number(process.env.AI_USAGE_IDLE_EXIT_MS || 5 * 60 * 1000);
const { dir: RUNTIME_DIR, runtimeFile: RUNTIME_FILE } = runtimePaths(DATA_DIR);

function writeRuntimeFile(port) {
  if (!LAUNCHER_MODE) return;
  try {
    ensureRuntimeDir(RUNTIME_DIR);
    const body = JSON.stringify({
      nonce: LAUNCH_NONCE, port, pid: process.pid, dataDir: DATA_DIR, startedAt: Date.now(),
    }, null, 2);
    // O_NOFOLLOW so a symlink planted at this path cannot redirect the write
    // into a file we did not mean to touch. Windows has no equivalent and no
    // shared temp directory, so it takes the plain path.
    if (process.platform === "win32") {
      fs.writeFileSync(RUNTIME_FILE, body);
    } else {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
      const fd = fs.openSync(RUNTIME_FILE, flags, 0o600);
      try { fs.writeFileSync(fd, body); } finally { fs.closeSync(fd); }
    }
  } catch {}
}

function clearRuntimeFile() {
  if (!LAUNCHER_MODE) return;
  try {
    const cur = JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8"));
    // Only remove our own record: a newer instance may already have replaced it.
    if (cur && cur.nonce === LAUNCH_NONCE) fs.rmSync(RUNTIME_FILE, { force: true });
  } catch {}
}

// A dashboard holds an SSE connection open, so "no clients" means no dashboard.
// Give it a grace period: a browser reload drops and re-opens the stream.
let idleTimer = null;
function armIdleExit() {
  if (!LAUNCHER_MODE || IDLE_EXIT_MS <= 0) return;
  clearTimeout(idleTimer);
  if (clients.size > 0) return;
  idleTimer = setTimeout(() => {
    if (clients.size > 0) return;
    clearRuntimeFile();
    process.exit(0);
  }, IDLE_EXIT_MS);
  if (idleTimer.unref) idleTimer.unref();
}

// When no port was explicitly requested, retry on the next port instead of
// failing — the real listen() (not a separate probe) decides what's free,
// since pre-checking with a throwaway socket is unreliable on Windows.
let port = requestedPort || 4317;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    if (!requestedPort) {
      port++;
      server.listen(port, HOST);
      return;
    }
    console.error(`\n  Port ${port} is already in use. Pick another with --port <n>.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, HOST, () => {
  console.log(`\n  AI Usage Inspector  ->  http://localhost:${port}`);
  console.log(`  project: ${loadConfig().title}`);
  console.log(`  reading: ${DATA_DIR}\n`);
  writeRuntimeFile(port);
  armIdleExit();
  // The sync refreshes every rate cache that is due and re-prices estimates when rates changed;
  // a second refresh from here would only repeat its downloads. Without a sync, refresh here.
  const synced = !ARGS.noSync && autoSync();
  if (!ARGS.noPricingRefresh && !synced) refreshPricing();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { clearRuntimeFile(); process.exit(0); });
}

// Pull the last few days of sessions from every provider in the background so
// the dashboard is fresh even when a hook missed turns (or was never
// installed). Uses the globally installed app; silently skipped in repo-mode
// dev where it isn't installed. /api/events reads from disk per request, so a
// browser refresh picks up whatever the sync imported.
// One sync at a time per dashboard, started at launch or by the refresh button.
let syncChild = null;
let syncStartedAt = 0;
const SYNC_MIN_GAP_MS = Number(process.env.AI_USAGE_SYNC_MIN_GAP_MS || 30_000);
const DASHBOARD_RATES_TTL_MS = 60 * 60 * 1000;

/** Start the background sync. Returns whether one was started. */
function autoSync() {
  try {
    const syncJs = path.join(os.homedir(), ".ai-usage-inspector", "app", "src", "sync.mjs");
    if (!fs.existsSync(syncJs)) return false;
    const env = { ...process.env };
    // --no-pricing-refresh means no fetch from anything this dashboard starts, and
    // sync refreshes rates itself.
    if (ARGS.noPricingRefresh) env.AI_USAGE_NO_PRICING_REFRESH = "1";
    // Someone opening the dashboard, or pressing refresh, wants today's rates: check any list
    // older than an hour rather than twelve. An unchanged list answers 304 or is a few KB.
    env.AI_USAGE_RATES_TTL_MS = String(DASHBOARD_RATES_TTL_MS);
    // The store this dashboard shows. Sync finds stores through transcripts, and a
    // project whose transcripts Claude Code has all deleted is reachable no other
    // way; named here, its stored rows are re-measured like any other.
    if (!process.env.AI_USAGE_DIR) env.AI_USAGE_PROJECT_STORE = path.join(DATA_DIR, "usage.ndjson");
    const child = spawn(process.execPath, [syncJs, "--days", "7"], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
    syncChild = child;
    syncStartedAt = Date.now();
    // Rows a sync imports reach the page through the data watcher as "change"; its end is its
    // own event, so the page's "syncing…" lasts until the sync is done, not the first write.
    const done = () => { if (syncChild === child) syncChild = null; notifyClients(); clients.send("synced"); };
    child.once("exit", done);
    child.once("error", done);
    console.log(`  sync: refreshing last 7 days in the background — the page updates as rows arrive\n`);
    return true;
  } catch {
    return false;
  }
}

// Two guards keep other web pages out. A page on another site that rebinds its own hostname to
// this machine (DNS rebinding) reads and writes as if it were this dashboard, so every request
// must name this machine in its Host header: localhost, *.localhost or an IP address — a
// rebinding attack always needs a hostname. And a page that just posts here cross-site needs no
// permission for a "simple" request, so every request that changes or exports data must carry
// x-ai-usage-dashboard: 1, which turns another site's request into a preflighted one this
// server never approves.
function localHost(req) {
  // "localhost." is the same name written fully qualified.
  const host = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  return host === "localhost" || host.endsWith(".localhost")
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /^\[[0-9a-f:.]+\]$/.test(host);
}
const fromDashboard = (req) => req.headers["x-ai-usage-dashboard"] === "1";

/** The refresh button's sync: one at a time, and only for this dashboard's own page. */
function requestSync(req) {
  if (!fromDashboard(req) || !localHost(req)) {
    return { status: 403, body: { started: false, reason: "forbidden" } };
  }
  if (ARGS.noSync) return { status: 200, body: { started: false, reason: "disabled" } };
  if (syncChild) return { status: 200, body: { started: false, reason: "running" } };
  if (Date.now() - syncStartedAt < SYNC_MIN_GAP_MS) return { status: 200, body: { started: false, reason: "recent" } };
  return { status: 200, body: { started: autoSync(), reason: null } };
}

// Refresh the shared pricing caches — Claude rates from Anthropic's public
// docs, OpenAI Standard rates from its docs (models.dev fills missing ids) —
// when this dashboard runs without a sync. Like the sync it would start, it
// checks a list older than an hour (the worker waits twelve), keeps the failure
// backoff, and an unchanged list answers 304 or is a few KB; the result is
// content-diffed, so a cache and its log line
// only move when a rate actually changed. Skipped when this project isn't
// tracking cost. Non-blocking, best-effort, offline-safe.
async function refreshPricing() {
  if (!PRICING.length) return;
  if (!loadConfig().fields.cost) return;
  for (const { label, mod } of PRICING) {
    await mod
      .refreshPricing({ ttlMs: DASHBOARD_RATES_TTL_MS })
      .then((r) => {
        if (r.status === "updated") {
          const changes = r.changes || [];
          const shown = changes.slice(0, 8).map((c) =>
            c.type === "changed"
              ? `${c.id} ${c.from.input}/${c.from.output}→${c.to.input}/${c.to.output}`
              : c.type === "window"
                ? `${c.id} window ${c.from ? `${c.from}→` : ""}${c.to}`
                : `${c.id} ${c.type}`,
          );
          const more = changes.length > 8 ? ` (+${changes.length - 8} more)` : "";
          console.log(`  pricing: updated ${label} rates — ${shown.join(", ")}${more}`);
        } else if (r.status === "offline") {
          console.log(`  pricing: ${label} offline — using cached/built-in rates`);
        }
      })
      .catch(() => {});
  }
}

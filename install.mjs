#!/usr/bin/env node
// Installer for AI Usage Inspector — records every AI coding-agent prompt
// (tokens, model, cost, context %) and shows it in a local dashboard.
//
//   node install.mjs                register hooks for every detected agent
//   node install.mjs --claude       Claude Code only
//   node install.mjs --codex        OpenAI Codex only
//   node install.mjs --cursor       Cursor only (needs Node >= 22.5)
//   node install.mjs --opencode     OpenCode only (needs Node >= 22.5)
//   node install.mjs --cline         Cline (VS Code, scan-only — no hook)
//   node install.mjs --roo           Roo Code (VS Code, scan-only)
//   node install.mjs --kilo          Kilo Code (VS Code, scan-only)
//   node install.mjs --all          all providers, whether detected or not
//   node install.mjs --local        Claude Code: this project only (settings.local.json)
//   node install.mjs --sync         also import existing session history
//   node install.mjs --dashboard    sync everything + open one dashboard across all projects
//   node install.mjs --update        refresh the app to the latest version
//   node install.mjs --uninstall     remove the hooks (add a provider flag to pick)
//
// Copies the app into ~/.ai-usage-inspector/app and points each agent's hook
// there, so tracking keeps working even if this repo moves. Existing settings
// are preserved.
import { refreshPricing as refreshZaiPricing } from "./src/lib/vendors/zai/pricing.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getProvider, listProviders, detectInstalled } from "./src/providers/index.mjs";
import { copyViewerSidecars, launcherName } from "./src/lib/ingest.mjs";
import { recordInstall } from "./src/lib/scan-state.mjs";

const REPO = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const APP = path.join(HOME, ".ai-usage-inspector", "app");
const GLOBAL_CFG = path.join(HOME, ".ai-usage-inspector", "config.json");

// ---- console styling (zero-dep ANSI; auto-off when not a TTY or NO_COLOR) ----
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : `${s}`);
const bold = sgr(1), dim = sgr(2), green = sgr("32;1"), red = sgr("31;1"), cyan = sgr(36), gray = sgr(90);
const ok = (msg) => console.log(`  ${green("✓")} ${msg}`);
const skip = (msg) => console.log(`  ${gray("•")} ${dim(msg)}`);
const fail = (msg) => console.log(`  ${red("✗")} ${msg}`);
const cmd = (s) => cyan(s);
const rule = () => console.log(gray("  ────────────────────────────────────────────"));
function banner(subtitle) {
  console.log();
  console.log(`  ${bold(cyan("AI Usage Inspector"))}  ${dim("·")}  ${dim(subtitle)}`);
  rule();
}

const args = new Set(process.argv.slice(2));
const explicitScope = args.has("--local") ? "local" : args.has("--global") ? "global" : null;
const uninstall = args.has("--uninstall");
const update = args.has("--update");
const scope = explicitScope || "global"; // bare invocation installs globally
const VERSION = readJson(path.join(REPO, "package.json")).version || "0";

const KNOWN_FLAGS = new Set([
  "--help",
  "-h",
  "--claude",
  "--codex",
  "--cursor",
  "--opencode",
  "--cline",
  "--roo",
  "--kilo",
  "--all",
  "--local",
  "--global",
  "--sync",
  "--dashboard",
  "--update",
  "--uninstall",
]);

function validateArgs() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    fail(`unknown option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    console.log();
    help();
    process.exit(1);
  }
  if (args.has("--local") && (args.has("--codex") || args.has("--cursor") || args.has("--all"))) {
    fail("--local is only supported for Claude Code project settings");
    console.log();
    help();
    process.exit(1);
  }
}

// Which providers to act on: explicit flags > --all > auto-detect. For
// uninstall, default to every provider so nothing is stranded.
function selectedProviders(defaultAll) {
  const picked = [];
  if (args.has("--claude")) picked.push(getProvider("claude"));
  if (args.has("--codex")) picked.push(getProvider("codex"));
  if (args.has("--cursor")) picked.push(getProvider("cursor"));
  if (args.has("--opencode")) picked.push(getProvider("opencode"));
  if (args.has("--cline")) picked.push(getProvider("cline"));
  if (args.has("--roo")) picked.push(getProvider("roo"));
  if (args.has("--kilo")) picked.push(getProvider("kilo"));
  if (picked.length) return picked;
  if (scope === "local") return [getProvider("claude")];
  if (args.has("--all") || defaultAll) return listProviders();
  const detected = detectInstalled();
  return detected.length ? detected : [getProvider("claude")];
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// Returns whether this replaced an app that was already installed.
function copyApp() {
  const upgrading = fs.existsSync(path.join(APP, "src"));
  fs.rmSync(APP, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });
  fs.cpSync(path.join(REPO, "src"), path.join(APP, "src"), { recursive: true });
  fs.cpSync(path.join(REPO, "viewer"), path.join(APP, "viewer"), { recursive: true });
  // The per-project bundle ships viewer/ only (no src/), so the modules the
  // bundled server imports are copied next to the viewer. ensureBundle copies the
  // whole viewer/ dir into each project, so these ride along automatically — and
  // puts them there itself when the tree it runs from has none.
  copyViewerSidecars(path.join(APP, "viewer"), path.join(REPO, "src"));
  return upgrading;
}

// An upgrade across a change in how turns are identified or costed owes each agent
// one full read of its history, so rows stored the old way are rewritten.
async function noteInstall(upgrading) {
  try { await refreshZaiPricing({ timeoutMs: 5_000 }); } catch {}
  try {
    if (await recordInstall({ upgrading, providerIds: detectInstalled().map((p) => p.id) })) {
      skip("history  read in full once more on the next sweep, to repair stored rows");
    }
  } catch {}
  // Current Claude rates and context windows, so a machine that only ever runs
  // the hook still prices and measures models released after this version. The
  // hook itself never fetches; it reads what this leaves on disk. Bounded, and
  // an install never fails over it.
  try {
    const r = await getProvider("claude").refreshPricing({ timeoutMs: 5_000 });
    if (r && ["updated", "unchanged", "not-modified", "fresh"].includes(r.status)) ok("rates    current Claude prices and context windows cached");
    else if (r) skip(`rates    could not fetch current Claude prices (${r.status}); using the built-in table`);
  } catch {}
}

const FIELD_GROUPS = ["text", "tokens", "cost", "context", "timing", "skills", "counts", "meta"];
function allFields() {
  const f = {};
  for (const g of FIELD_GROUPS) f[g] = true;
  return f;
}
function globalDefaults() {
  const c = readJson(GLOBAL_CFG);
  const fields = allFields();
  if (c.fields && typeof c.fields === "object") for (const g of FIELD_GROUPS) if (typeof c.fields[g] === "boolean") fields[g] = c.fields[g];
  return { enabledDefault: typeof c.enabledDefault === "boolean" ? c.enabledDefault : true, fields };
}

// Create the global defaults TEMPLATE the first time only — projects inherit a
// copy of it. Never overwrite user edits.
function seedGlobalConfig() {
  if (fs.existsSync(GLOBAL_CFG)) return GLOBAL_CFG;
  const cfg = { schema: 2, enabledDefault: true, fields: allFields() };
  fs.mkdirSync(path.dirname(GLOBAL_CFG), { recursive: true });
  fs.writeFileSync(GLOBAL_CFG, JSON.stringify(cfg, null, 2) + "\n");
  return GLOBAL_CFG;
}

// A --local install makes the project self-contained: write its tracking + field
// config into <cwd>/.ai-usage/config.json (enabled, seeded from global).
function seedProjectConfig(cwd) {
  const base = path.join(cwd, ".ai-usage");
  const file = path.join(base, "config.json");
  const def = globalDefaults();
  const c = readJson(file);
  if (!c.title) c.title = path.basename(cwd);
  if (!c.ui || typeof c.ui !== "object") c.ui = {};
  c.tracking = { enabled: true, ...(c.tracking || {}) };
  c.fields = { ...def.fields, ...(c.fields || {}) };
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
  return file;
}

function installProvider(p) {
  try {
    const r = p.install({ appPath: APP, scope, cwd: process.cwd() });
    if (r.action === "unsupported-node") {
      fail(`${p.displayName}: needs Node >= 22.5 for node:sqlite (you have ${r.node}) — hook NOT installed`);
    } else if (r.action === "scan-only") {
      // VS Code extensions (Cline/Roo/Kilo/Continue) have no turn-end hook; they
      // are read on sync + every dashboard open.
      ok(`${p.displayName}: ${p.detect() ? "detected" : "no data yet"} — captured on sync (no hook needed)`);
    } else if (r.action === "exists") skip(`${p.displayName}: hook already registered  ${gray(r.file)}`);
    else ok(`${p.displayName}: registered hook  ${gray(r.file)}`);
    if (r.migrated) ok(`${p.displayName}: safely migrated legacy config.toml hook`);
    if (r.trustRequired) {
      skip(`${p.displayName}: open /hooks in Codex and trust the AI Usage Inspector Stop hook`);
    }
  } catch (e) {
    skip(`${p.displayName}: could not register hook (${e.message})`);
  }
}

function uninstallProvider(p) {
  try {
    const r = p.uninstall({ scope, cwd: process.cwd() });
    // Scan-only providers (the VS Code agents) never registered a hook, so they
    // have no file to name — say that, rather than printing "null" at the user.
    const where = r.file ? `  ${gray(r.file)}` : "";
    if (r.removed) ok(`${p.displayName}: removed hook${where}`);
    else if (!r.file) skip(`${p.displayName}: nothing to remove (scan-only, never had a hook)`);
    else skip(`${p.displayName}: no matching hook${where}`);
  } catch (e) {
    skip(`${p.displayName}: uninstall skipped (${e.message})`);
  }
}

// Antigravity (Google's agentic IDE) is recognized but NOT supported: it keeps
// usage server-side (credits model) and encrypts local conversation bodies, so
// there is no local token/cost data to record. Surface this once, if present.
function noteUnsupportedIfPresent() {
  try {
    if (fs.existsSync(path.join(HOME, ".gemini", "antigravity"))) {
      skip("Antigravity: detected but not supported — usage is stored server-side / encrypted locally (nothing to record)");
    }
  } catch {}
}

function help() {
  banner("installer");
  console.log();
  console.log(`  ${bold("Usage")}`);
  console.log(`    ${cmd("npx -y github:Kud0o/ai-usage-inspector")}   ${dim("one-line install (auto-detects agents)")}`);
  console.log(`    ${cmd("node install.mjs")}              ${dim("install for every detected agent")}`);
  console.log(`    ${cmd("node install.mjs --claude")}     ${dim("Claude Code only")}`);
  console.log(`    ${cmd("node install.mjs --codex")}      ${dim("OpenAI Codex only")}`);
  console.log(`    ${cmd("node install.mjs --cursor")}     ${dim("Cursor only (needs Node >= 22.5)")}`);
  console.log(`    ${cmd("node install.mjs --opencode")}   ${dim("OpenCode only (needs Node >= 22.5)")}`);
  console.log(`    ${cmd("node install.mjs --cline/--roo/--kilo")}  ${dim("Cline / Roo Code / Kilo Code (VS Code, scan-only)")}`);
  console.log(`    ${cmd("node install.mjs --dashboard")}  ${dim("sync everything + open one dashboard across all projects")}`);
  console.log(`    ${cmd("node install.mjs --local")}      ${dim("Claude Code: this project only")}`);
  console.log(`    ${cmd("node install.mjs --update")}     ${dim("refresh app to the latest version")}`);
  console.log(`    ${cmd("node install.mjs --uninstall")}  ${dim("remove the hooks")}`);
  console.log(`    ${cmd("node install.mjs --sync")}       ${dim("also import existing session history")}`);
  console.log();
  console.log(`  ${bold("Backfill history")}  ${dim("(hooks only record from install time forward)")}`);
  console.log(`    ${cmd(`node "${path.join("~", ".ai-usage-inspector", "app", "src", "sync.mjs")}"`)}   ${dim("[--provider claude|codex|cursor|opencode|cline|roo|kilo] [--days N]")}`);
  console.log();
  console.log(`  ${bold("View a project")}  ${dim("(after its first prompt)")}`);
  console.log(`    ${cmd(path.join(".ai-usage", launcherName()))}   ${dim("← open this file")}`);
  console.log(`    ${cmd("node .ai-usage/viewer/server.mjs")}   ${dim("or run it yourself → http://localhost:4317")}`);
  console.log();
  console.log(dim(`  Each project records into its own  .ai-usage/  folder (data + a`));
  console.log(dim(`  bundled viewer + saved settings). Add it to the project's .gitignore.`));
  console.log(dim(`  Set AI_USAGE_DIR to pool every project into one shared dashboard.`));
  console.log();
}

validateArgs();

if (args.has("--help") || args.has("-h")) {
  help();
} else if (args.has("--dashboard")) {
  // One dashboard across every project: sync all providers into the shared
  // aggregate dir (existing AI_USAGE_DIR pooling), then serve the viewer on it.
  banner("dashboard · all projects");
  console.log();
  if (!fs.existsSync(path.join(APP, "src", "sync.mjs"))) {
    const upgrading = copyApp();
    ok(`copied app v${VERSION}  ${gray(APP)}`);
    await noteInstall(upgrading);
  }
  const AGG = path.join(HOME, ".ai-usage-inspector", "aggregate");
  fs.mkdirSync(AGG, { recursive: true });
  const env = { ...process.env, AI_USAGE_DIR: AGG };
  console.log(`  ${bold("Syncing all providers")}${dim(" …")}`);
  const r = spawnSync(process.execPath, [path.join(APP, "src", "sync.mjs")], {
    env,
    encoding: "utf8",
  });
  process.stdout.write(r.stdout || "");
  console.log();
  console.log(`  ${bold("Opening dashboard")} ${dim(`(data: ${AGG})`)}`);
  const child = spawn(process.execPath, [path.join(APP, "viewer", "server.mjs")], {
    env,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code || 0));
} else if (update) {
  banner("update");
  console.log();
  const upgrading = copyApp();
  ok(`updated app to v${VERSION}  ${gray(APP)}`);
  await noteInstall(upgrading);
  for (const p of selectedProviders(false)) installProvider(p); // ensure hooks exist
  noteUnsupportedIfPresent();
  const gc = seedGlobalConfig();
  skip(`config  ${gray(gc)}`);
  console.log();
  console.log(`  ${green("✓")} ${bold("Up to date.")} ${dim("Open projects refresh their viewer on the next prompt.")}`);
  console.log();
} else if (uninstall) {
  banner("uninstall");
  console.log();
  for (const p of selectedProviders(true)) uninstallProvider(p);
  console.log();
  console.log(`  ${bold("Done.")}`);
  console.log(dim(`  App + recorded data left in  ~/.ai-usage-inspector  — delete manually if desired.`));
  console.log();
} else {
  const providers = selectedProviders(false);
  banner(`install · ${scope} · ${providers.map((p) => p.id).join("+")}`);
  console.log();
  const upgrading = copyApp();
  ok(`copied app v${VERSION}  ${gray(APP)}`);
  await noteInstall(upgrading);
  for (const p of providers) installProvider(p);
  noteUnsupportedIfPresent();
  const gc = seedGlobalConfig();
  ok(`global defaults  ${gray(gc)}`);
  if (args.has("--sync")) {
    console.log();
    console.log(`  ${bold("Importing existing history")}${dim(" …")}`);
    for (const p of providers) {
      const r = spawnSync(process.execPath, [path.join(APP, "src", "sync.mjs"), "--provider", p.id], {
        encoding: "utf8",
      });
      process.stdout.write(r.stdout || "");
      if (r.status !== 0) skip(`${p.displayName}: sync failed`);
    }
  }
  if (scope === "local") {
    const pc = seedProjectConfig(process.cwd());
    ok(`project config  ${gray(pc)}`);
    console.log();
    console.log(`  ${green("✓")} ${bold("This project is tracked.")} ${dim("Its config lives in the folder; tune it in ⚙ settings.")}`);
  } else {
    console.log();
    console.log(`  ${green("✓")} ${bold("Tracking on by default.")} ${dim("Each project inherits an editable copy of the global defaults.")}`);
    console.log(dim(`  Disable or tune a project from its dashboard ⚙ settings (writes that project's config).`));
  }
  console.log();
  console.log(`  ${bold("View a project")}  ${dim("(after its first prompt)")}`);
  console.log(`    ${cmd(path.join(".ai-usage", launcherName()))}   ${dim("← open this file; no terminal needed")}`);
  console.log(`    ${cmd("node .ai-usage/viewer/server.mjs")}   ${dim("or run it yourself → http://localhost:4317")}`);
  console.log();
  console.log(dim(`  Tip: add  .ai-usage/  to that project's .gitignore.`));
  console.log();
}

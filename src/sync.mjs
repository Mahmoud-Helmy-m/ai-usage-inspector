#!/usr/bin/env node
// Backfill/sync: import existing session history from each AI tool's own
// storage into the per-project .ai-usage records. The hooks only record turns
// from install time forward — this scans what's already on disk:
//
//   node sync.mjs                      # all detected providers, full history
//   node sync.mjs --provider codex     # one provider
//   node sync.mjs --days 30            # only transcripts modified in the last N days
//   node sync.mjs --reprice            # recompute stored costs at today's rates
//   node sync.mjs --relabel            # refresh cost provenance, keep the amounts
//
// Idempotent: each transcript replaces what it stored before, so re-running never
// duplicates. Re-syncing also does NOT rewrite costs this tool computed for old
// turns while their tokens are unchanged — what a turn cost is a fact about the
// rates when it ran — unless --reprice is passed. A repair owed after an upgrade
// widens the window to a provider's whole history, once.
// Per-project tracking config still gates every project (disabled = skipped),
// exactly like the hook path.
import { refreshPricing as refreshZaiPricing } from "./lib/vendors/zai/pricing.mjs";
import path from "node:path";
import { getProvider, detectInstalled } from "./providers/index.mjs";
import { ingestTranscript } from "./lib/ingest.mjs";
import { markRepaired, repairDue, claimScan, recordScanResult } from "./lib/scan-state.mjs";
import { backupCandidateStores, candidateStores, cleanUpCopies } from "./lib/copies.mjs";
import { correctEstimatedCosts } from "./lib/estimates.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function help() {
  console.log(`
  AI Usage Inspector sync

  Usage
    node src/sync.mjs
    node src/sync.mjs --provider claude|codex|cursor|opencode|cline|roo|kilo
    node src/sync.mjs --days 30
    node src/sync.mjs --reprice
    node src/sync.mjs --relabel

  Imports existing provider history into per-project .ai-usage records.

  Costs this tool computed for turns already recorded are kept as-is on a
  re-sync while the turn's tokens are unchanged; pass --reprice to recompute
  them at today's rates, or --relabel to refresh only their provenance and
  leave the amounts as recorded.

  After an upgrade that owes a repair, the first sync reads each agent's whole
  history once. For Claude it then removes turns older versions stored twice —
  in another folder's store, or under a branch — after backing up every file it
  changes, and lists any folder left holding no rows.
`);
}

function validateArgs() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h" || a === "--reprice" || a === "--relabel") continue;
    if (a === "--provider" || a === "--days") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) {
        throw new Error(`${a} requires a value`);
      }
      i++;
      continue;
    }
    if (a.startsWith("--provider=") || a.startsWith("--days=")) continue;
    throw new Error(`unknown option: ${a}`);
  }

  const wanted = arg("--provider", null);
  if (wanted && !getProvider(wanted)) throw new Error(`unknown provider: ${wanted}`);

  const rawDays = arg("--days", null);
  if (rawDays != null) {
    const days = Number(rawDays);
    if (!Number.isFinite(days) || days < 0) throw new Error("--days must be a non-negative number");
  }
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    help();
    return;
  }

  validateArgs();

  const wanted = arg("--provider", null);
  const days = Number(arg("--days", 0)) || 0;
  const sinceMs = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  // Opt in to recomputing costs we already stored (see upsertSession).
  const reprice = process.argv.includes("--reprice");
  const relabel = process.argv.includes("--relabel");
  // Opposite instructions about the same field; accepting both printed a promise
  // about amounts that repricing then broke.
  if (reprice && relabel) {
    console.error("  --reprice and --relabel do opposite things; pass one");
    process.exit(2);
  }
  if (reprice) {
    process.env.AI_USAGE_REPRICE = "1";
    console.log("  repricing: stored costs will be recomputed at today's rates");
  }
  if (relabel) {
    process.env.AI_USAGE_RELABEL = "1";
    console.log("  relabelling: cost provenance refreshed, amounts left as recorded");
  }

  const providers = wanted
    ? [getProvider(wanted)].filter(Boolean)
    : detectInstalled().filter((p) => typeof p.discoverTranscripts === "function");
  if (!providers.length) {
    console.error(wanted ? `unknown provider: ${wanted}` : "no providers detected");
    process.exit(1);
  }

  // Current rates and context windows before anything is priced. A machine that
  // only ever runs the hook never opens the dashboard, which is otherwise the only
  // thing that fetches them — so a model released after this version shipped
  // would be priced and measured on a guess for good. Skipped when fetched within
  // the last 12 hours; bounded, and never fatal. Claude only: the other
  // providers' refreshers take no timeout and refetch on every call, which a
  // sync run on every sweep must not wait on.
  let ratesLearned = false;
  try {
    const z = await refreshZaiPricing({ timeoutMs: 5_000 });
    if (z && z.status === "updated") ratesLearned = true;
  } catch {}
  for (const p of providers) {
    if (p.id !== "claude" || typeof p.refreshPricing !== "function") continue;
    try {
      const r = await p.refreshPricing({ timeoutMs: 5_000 });
      if (r && r.status === "updated") {
        ratesLearned = true;
        console.log(`  ${p.id}: rates and context windows updated from the provider's docs`);
      }
    } catch {}
  }
  // New rates can price turns stored with a guessed one; re-read just those.
  const claudeProvider = providers.find((p) => p.id === "claude");
  if (ratesLearned && claudeProvider && process.env.AI_USAGE_RELABEL !== "1") {
    try {
      const c = await correctEstimatedCosts(claudeProvider);
      if (c.priced) console.log(`  claude: ${c.priced} estimated turn(s) priced at real rates, from ${c.reread} transcript(s)`);
    } catch {}
  }

  for (const p of providers) {
    if (typeof p.discoverTranscripts !== "function") {
      console.log(`  ${p.id}: no sync support`);
      continue;
    }
    if (typeof p.nodeSupported === "function" && !p.nodeSupported()) {
      console.log(`  ${p.id}: needs Node >= 22.5 for node:sqlite (you have ${process.versions.node}) — skipped`);
      continue;
    }
    const leaseId = await claimScan(p.id);
    if (!leaseId) {
      console.log(`  ${p.id}: scan already running; skipped`);
      continue;
    }
    try {
      // A repair owed after an upgrade reads this provider's whole history once,
      // whatever window was asked for. The dashboard runs this at start, and on a
      // --local or autoSweep:false machine nothing else would.
      const repair = repairDue(p.id);
      if (repair !== null) console.log(`  ${p.id}: reading full history once, to repair stored rows`);
      const since = repair === null ? sinceMs : 0;
      let found = [];
      let storeOk = true;
      if (typeof p.discoverTranscriptsStatus === "function") {
        const result = await p.discoverTranscriptsStatus({ sinceMs: since });
        found = result.transcripts || [];
        storeOk = (result.status || "ok") === "ok";
      } else {
        found = await p.discoverTranscripts({ sinceMs: since });
      }
      let backup = null;
      if (repair !== null && p.id === "claude") {
        try {
          backup = await backupCandidateStores({ transcripts: found });
        } catch (err) {
          console.error(`  ${p.id}: backup failed; repair remains owed: ${err.message}`);
          continue;
        }
      }
      let files = 0;
      let turns = 0;
      let failed = false;
      for (const t of found) {
        try {
          const n = await ingestTranscript(p, t);
          if (n > 0) {
            files++;
            turns += n;
          }
        } catch (err) {
          // One still being written is read again by its hook; anything else is not.
          if (!(err && err.transcriptMoved)) failed = true;
        }
      }
      console.log(`  ${p.id}: ${found.length} transcript(s) scanned, ${turns} turn(s) from ${files} session(s) imported`);
      // Settles the repair only for where this run wrote: the projects, or one
      // aggregate directory.
      if (repair !== null && storeOk && !failed) {
        let settled = true;
        if (p.id === "claude") {
          // Every session is now whole in its own store, so what older versions
          // stored twice can go.
          try {
            const report = await cleanUpCopies({ transcripts: found, backup });
            const removed = report.copiesRemoved + report.branchCopiesRemoved;
            if (removed) {
              console.log(`  ${p.id}: removed ${removed} turn(s) stored twice; the files as they were are in ${report.backup}`);
              for (const store of report.emptyStores) console.log(process.env.AI_USAGE_DIR
                ? `    store holds no rows; its aggregate file can be deleted: ${store}`
                : `    store holds no rows; its .ai-usage folder can be deleted: ${store}`);
            }
          } catch {
            settled = false;
          }
          // Rows whose transcripts are gone were not re-read; their context is
          // measured again from the request size each one stores.
          if (typeof p.repairStoredContext === "function") {
            try {
              const fixed = await p.repairStoredContext(withProjectStore([...candidateStores(found).values()]));
              if (fixed) console.log(`  ${p.id}: context fill re-measured on ${fixed} stored turn(s) no transcript remains for`);
            } catch {
              settled = false;
            }
          }
        }
        if (settled) {
          try { await markRepaired(p.id, repair); } catch {}
        }
      }
      // The store a dashboard asked about is re-measured on every sync, not only
      // during the upgrade repair: a project whose transcripts are all gone is found
      // no other way, and may be opened long after that repair has finished. It is
      // a no-op once its rows are right.
      const named = process.env.AI_USAGE_PROJECT_STORE;
      if (repair === null && named && typeof p.repairStoredContext === "function") {
        try { await p.repairStoredContext([named]); } catch {}
      }
    } finally {
      // Explicit windows do not advance the automatic sweep's watermark.
      await recordScanResult(p.id, { leaseId, completed: false });
    }
  }
}

// Stores found through transcripts, plus the one a dashboard named, once.
function withProjectStore(files) {
  const named = process.env.AI_USAGE_PROJECT_STORE;
  if (!named) return files;
  const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  return files.some((f) => same(path.resolve(f), path.resolve(named))) ? files : [...files, named];
}

main().catch((e) => {
  console.error(e && e.message);
  process.exit(1);
});

// Lock-guarded, atomic mutation of per-workspace usage + tombstone files.
// Safe for concurrent agent sessions and viewer deletes. Zero deps.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const TOMBSTONE_FILE = "tombstones.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempName = (file) => `${file}.${process.pid}.${randomUUID()}.tmp`;

function readToken(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function removeOwned(file, token) {
  try {
    if (readToken(file) === token) fs.rmSync(file, { force: true });
  } catch {}
}

/** Run `fn` under an owner-token lock. Returns false when lock times out. */
export async function withFileLock(file, fn) {
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

      // Read owner before considering a steal, then re-read immediately before
      // removal. A replaced lock has a different token and is left untouched.
      try {
        const seen = readToken(lock);
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (seen !== null && age > LOCK_STALE_MS && readToken(lock) === seen) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished -- retry
      }
      if (Date.now() > deadline) return false;
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    const value = await fn();
    return value === undefined ? true : value;
  } finally {
    try { fs.closeSync(fd); } catch {}
    removeOwned(lock, token);
  }
}

function atomicWrite(file, text) {
  const tmp = tempName(file);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

/** Locked JSON read-modify-write using same owner-token lock + atomic temp path. */
export async function mutateJson(file, fn, fallback = {}) {
  return withFileLock(file, () => {
    let current = fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") current = parsed;
    } catch {}
    const changed = fn(current);
    const next = changed && Object.hasOwn(changed, "data") ? changed.data : changed;
    const value = changed && Object.hasOwn(changed, "data") ? changed.value : undefined;
    atomicWrite(file, JSON.stringify(next, null, 2) + "\n");
    return value === undefined ? true : value;
  });
}

export function readNdjson(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}

  const records = [];
  const malformed = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      records.push(JSON.parse(raw.trim()));
    } catch {
      malformed.push(raw); // carry byte-for-byte line content through rewrites
    }
  }
  return { text, records, malformed };
}

function encodeNdjson(records, malformed) {
  const lines = records.map((r) => JSON.stringify(r)).concat(malformed);
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Mutate valid records under the usage-file lock. Malformed lines never enter
 * the callback and are carried through unchanged at the end of the file.
 * Callback returns either records[] or { records, value }.
 */
export const ABORT = Symbol("abort-mutation");

export async function mutateNdjson(file, fn, { onBeforeWrite = null, lockHeld = false } = {}) {
  const mutate = async () => {
    const current = readNdjson(file);
    const changed = await fn(current.records.slice());
    // A caller can only decide "is this still worth writing?" while holding the
    // lock; checking beforehand leaves a window for the file to move.
    if (changed === ABORT) {
      return {
        value: ABORT,
        beforeBytes: Buffer.byteLength(current.text),
        afterBytes: Buffer.byteLength(current.text),
        malformed: current.malformed.length,
      };
    }
    const nextRecords = Array.isArray(changed) ? changed : changed.records;
    const value = Array.isArray(changed) ? undefined : changed.value;
    const out = encodeNdjson(nextRecords, current.malformed);
    if (onBeforeWrite) onBeforeWrite(current.text);
    atomicWrite(file, out);
    return {
      value,
      beforeBytes: Buffer.byteLength(current.text),
      afterBytes: Buffer.byteLength(out),
      malformed: current.malformed.length,
    };
  };
  return lockHeld ? mutate() : withFileLock(file, mutate);
}

export function tombstonePath(usageFile) {
  return path.join(path.dirname(usageFile), TOMBSTONE_FILE);
}

export function tombstoneKey(value) {
  const provider = value && value.provider ? String(value.provider) : "claude";
  const sessionId = value && value.sessionId != null ? String(value.sessionId) : "";
  const id = value && value.id != null ? String(value.id) : "";
  return JSON.stringify([provider, sessionId, id]);
}

function readTombstones(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

export function loadTombstoneKeys(file) {
  return new Set(readTombstones(file).map(tombstoneKey));
}

/** Add/dedupe composite tombstones. No expiry: expiry could resurrect history. */
export async function addTombstones(file, values, { lockHeld = false, reason = null } = {}) {
  if (!values || !values.length) return 0;
  const mutate = () => {
    const byKey = new Map(readTombstones(file).map((t) => [tombstoneKey(t), t]));
    let added = 0;
    for (const value of values) {
      if (!value || value.id == null) continue;
      const entry = {
        provider: value.provider || "claude",
        sessionId: value.sessionId == null ? "" : value.sessionId,
        id: value.id,
        deletedAt: new Date().toISOString(),
        ...(reason ? { reason } : {}),
      };
      const key = tombstoneKey(entry);
      // Cleanup must not demote a user deletion into weaker copy suppression.
      if (reason === "copy" && byKey.has(key) && byKey.get(key).reason !== "copy") continue;
      if (!byKey.has(key)) added++;
      byKey.set(key, entry);
    }
    atomicWrite(file, JSON.stringify({ schema: 1, entries: [...byKey.values()] }, null, 2) + "\n");
    return added;
  };
  return lockHeld ? mutate() : withFileLock(file, mutate);
}

// A cost WE computed from a rate table ("priced"/"estimated") must not silently
// change when history is re-scanned with today's rates — what a turn cost is a
// fact about when it ran. A cost the tool itself reported ("provider") is always
// taken fresh, since the tool is the authority on its own number. Set
// AI_USAGE_REPRICE=1 (sync --reprice) to deliberately recompute.
const COMPUTED_COST_SOURCES = new Set(["priced", "estimated"]);

const COST_AMOUNT_FIELDS = ["input", "output", "cacheWrite", "cacheRead", "total"];

/** Do two cost objects claim the same money? Provenance is ignored. */
function sameAmount(a, b) {
  return COST_AMOUNT_FIELDS.every((k) => {
    const x = a[k], y = b[k];
    // Only real numbers compare: a missing or NaN field means we do not know the
    // amounts match, and must not treat that as licence to relabel.
    return typeof x === "number" && typeof y === "number"
      && Number.isFinite(x) && Number.isFinite(y) && x === y;
  });
}

/** Do two usage objects count the same tokens? A field one of them lacks counts as zero. */
function sameTokens(a, b) {
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of fields) if ((Number(a[k]) || 0) !== (Number(b[k]) || 0)) return false;
  return true;
}

/** Every token a record accounts for, of whatever kind. */
export function tokenCount(r) {
  const u = r && r.usage;
  if (!u || typeof u !== "object") return 0;
  let n = 0;
  for (const v of Object.values(u)) n += Number(v) || 0;
  return n;
}

function preserveComputedCost(next, previous, preserveRuns = true) {
  // Endpoint evidence rules out API billing, including an older guessed amount.
  if (next?.endpoint === "local" && next.cost?.rateSource === "local") return next;
  if (process.env.AI_USAGE_REPRICE === "1") return next;
  if (!previous || !previous.cost || !next || !next.cost) return next;
  if (!COMPUTED_COST_SOURCES.has(previous.cost.source)) return next;
  if (!COMPUTED_COST_SOURCES.has(next.cost.source)) return next;
  // A cost worked out under rates since found wrong for its model is not kept.
  // The incoming cost names the table revision that corrected them; a stored
  // cost from before it was never the provider's price, so the promise to keep
  // what a turn cost at the time does not cover it. The corrected turn is taken
  // whole, its runs included: keeping a run's older figure inside a recomputed
  // total would leave the total and its parts disagreeing for good. --relabel
  // promises never to change an amount, so it leaves this to a plain sync.
  if (process.env.AI_USAGE_RELABEL !== "1"
      && typeof next.cost.supersedes === "number" && !(Number(previous.cost.rates) >= next.cost.supersedes)) {
    return next;
  }
  // An estimate is a placeholder for a rate nobody knew yet, not what the turn cost at the time,
  // so the promise to keep a computed cost does not cover a wrong one: once a re-read of the same
  // tokens prices the whole turn from real rates at a different amount, that price is taken —
  // runs included, as for a correction above. An estimate that happened to land on the real
  // amount keeps its cautious label (see below; --relabel clears it), so a process that loaded
  // the rates late cannot make the label flicker. --relabel never changes an amount, so it
  // leaves this to a plain sync.
  if (process.env.AI_USAGE_RELABEL !== "1"
      && previous.cost.source === "estimated" && next.cost.source === "priced"
      && !sameAmount(previous.cost, next.cost)
      && previous.usage && next.usage && sameTokens(previous.usage, next.usage)) {
    return next;
  }
  const preserved = (cost = previous.cost) => {
    const out = { ...next, cost };
    return preserveRuns ? preserveRunCosts(out, previous) : out;
  };
  // A version that stopped labelling some part of a cost wrongly names its revision
  // (`relabels`: a message with no tokens used to mark its turn estimated). A cost stored
  // before that revision takes the new label, once, when the amount and tokens are the same;
  // after that the stored cost carries the new revision and the ordinary rules apply.
  if (typeof next.cost.relabels === "number" && !(Number(previous.cost.rates) >= next.cost.relabels)
      && sameAmount(previous.cost, next.cost)
      && previous.usage && next.usage && sameTokens(previous.usage, next.usage)) {
    return preserved(next.cost);
  }
  // The amount is preserved, but its provenance is not part of that promise: if
  // we now know the same number came from a guessed rate, say so. Without this a
  // row mislabelled by an older version stays mislabelled forever, because the
  // only escape was --reprice, which also restates the amount at today's rates.
  // Automatic correction only ever moves toward the more cautious label: a row
  // known to rest on a guess stays marked, even if a later scan happens to price
  // it exactly. Otherwise the marker flickers as the rate cache warms and cools.
  if (sameAmount(previous.cost, next.cost)
      && previous.cost.source === "priced" && next.cost.source === "estimated") {
    return previous.usage && next.usage && !sameTokens(previous.usage, next.usage) ? next : preserved(next.cost);
  }
  // Asked for explicitly (sync --relabel): take the new provenance whenever the
  // amount is unchanged, in either direction. This is the escape hatch for a row
  // left estimated after the real rate became known — --reprice would fix the
  // label too, but only by restating what the turn cost at today's rates.
  // It never takes a new amount, not even for tokens that changed: that is what a
  // plain re-sync does.
  if (process.env.AI_USAGE_RELABEL === "1") {
    return sameAmount(previous.cost, next.cost) ? preserved(next.cost) : preserved();
  }
  // The promise is about rates, not tokens. When a re-read counts different
  // tokens for the turn, the stored figure was worked out for something that is
  // not this turn — a capture taken before it finished, a replay holding none of
  // its work, or a position an older parser gave to a different turn — so it is
  // worked out again instead of being carried forward.
  if (previous.usage && next.usage && !sameTokens(previous.usage, next.usage)) return next;
  return preserved();
}

function preserveRunCosts(next, previous) {
  if (!Array.isArray(next.subagents)) return next;
  const byAgent = new Map((previous.subagents || []).map((run) => [run.agentId, run]));
  return { ...next, subagents: next.subagents.map((run) => {
    const prior = run.agentId != null ? byAgent.get(run.agentId) : null;
    if (!prior) return run;
    const unchanged = prior.usage && run.usage && sameTokens(prior.usage, run.usage);
    const saved = unchanged ? preserveComputedCost(run, prior, false) : run;
    return preserveRunCosts(saved, prior);
  }) };
}

/**
 * Raised when the usage-file lock could not be taken. Callers must be able to
 * tell "the write never happened" from "nothing needed writing" — both used to
 * surface as 0, which let a failed write look like a completed one.
 */
export class LockTimeoutError extends Error {
  constructor(file) {
    super(`timed out waiting for lock on ${file}`);
    this.name = "LockTimeoutError";
    this.code = "ELOCKTIMEOUT";
  }
}

const rowProvider = (r) => (r && r.provider ? String(r.provider) : "claude");

// Claude Code names a turn by its prompt message's uuid, which is unique across
// sessions, so only such an id can be a copy of another session's turn. Fallback
// ids are built from the session and cannot collide.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const copyable = (r) => rowProvider(r) === "claude" && r.sessionId != null && typeof r.id === "string" && UUID_RE.test(r.id);

/**
 * Of two Claude sessions sharing turns, is `candidate` the one they were copied
 * from, rather than `stored`?
 *
 * `/branch` and `--fork-session` copy earlier turns into a new session and keep
 * each message's uuid, and neither transcript says which came first. A branch
 * holds the shared turns first and its own after them, so the session with its
 * own turns before the first shared one is the original. Failing that, it is the
 * one that went on first; a session with nothing of its own is never the copy;
 * and on a tie the session already stored stays the original, so re-reads never
 * trade turns back and forth.
 */
function firstEntryDirection(candidate, stored, shared) {
  // Each row names its source's first entry, not a claimed session birth. Use
  // the earliest known source across continuations, and require evidence on BOTH
  // sides. If neither source reaches back to the shared turn, direction is unknown.
  const first = (rows) => {
    const stamps = rows.map((r) => Date.parse(r.transcriptFirstTs)).filter(Number.isFinite);
    return stamps.length ? Math.min(...stamps) : null;
  };
  const a = first(candidate), b = first(stored);
  const turns = candidate.concat(stored).filter((r) => shared.has(String(r.id))).map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  if (a === null || b === null || a === b || !turns.length || Math.min(a, b) > Math.min(...turns)) return null;
  return a < b;
}

function isOriginalOf(candidate, stored, shared) {
  const direction = firstEntryDirection(candidate, stored, shared);
  if (direction !== null) return direction;
  const tsOf = (r) => (typeof r.ts === "string" ? r.ts : "");
  const isShared = (r) => shared.has(String(r.id));
  // The parser marks a turn its transcript copied from an earlier session. When only
  // one side's shared turns carry that mark, it settles which is the copy — timing
  // alone reads a branch that went on before its original did backwards.
  const marked = (rows) => rows.some((r) => r.copied === true && isShared(r));
  if (marked(candidate) !== marked(stored)) return marked(stored);
  // Rows an older version wrote carry no first entry at all. Until its own
  // transcript is read again, such a session can only be judged by timing, which
  // reads a branch that went on first backwards — and a batch skipped on that
  // reading is not written, so nothing later in the same repair can put it back.
  // So the side that has been read by this version is preferred while the other
  // has not: the repair reads every transcript, and the pass that reads the other
  // one settles the pair on evidence both sides now carry.
  const dated = (rows) => rows.some((r) => Number.isFinite(Date.parse(r.transcriptFirstTs)));
  const mineDated = dated(candidate), theirsDated = dated(stored);
  if (mineDated !== theirsDated) return mineDated;
  const firstShared = candidate.concat(stored).filter(isShared).map(tsOf).filter(Boolean).sort()[0] || "";
  const ownStart = (rows) => rows.filter((r) => !isShared(r)).map(tsOf).filter(Boolean).sort()[0] || null;
  const mine = ownStart(candidate);
  const theirs = ownStart(stored);
  const mineBefore = mine !== null && mine < firstShared;
  const theirsBefore = theirs !== null && theirs < firstShared;
  if (mineBefore !== theirsBefore) return mineBefore;
  if (theirs === null) return false;
  if (mine === null) return true;
  return mine < theirs;
}

/**
 * Settle which turns of an incoming Claude batch are copies of turns another
 * session in this file already holds. Returns the incoming keys to drop, the
 * other sessions' rows this batch takes back, the sessions that turn out to be
 * branches of this one, and the session this one is a branch of.
 */
function resolveCopies(existing, incoming, sessionId, blocked) {
  const sid = String(sessionId);
  const mine = [...incoming.values(), ...existing.filter((r) => rowProvider(r) === "claude" && String(r.sessionId) === sid)];
  const mineById = new Map([...incoming.values()].filter(copyable).map((r) => [r.id, r]));
  const theirRows = new Map();
  const shared = new Map();
  const share = (other, id) => {
    if (!shared.has(other)) shared.set(other, new Set());
    shared.get(other).add(id);
  };
  for (const row of existing) {
    if (rowProvider(row) !== "claude" || row.sessionId == null || String(row.sessionId) === sid) continue;
    const other = String(row.sessionId);
    if (!theirRows.has(other)) theirRows.set(other, []);
    theirRows.get(other).push(row);
    if (mineById.has(String(row.id))) share(other, String(row.id));
  }

  const skip = new Set();
  const take = new Map();
  const branches = new Set();
  const resolution = new Map();
  let branchOf = null;
  let latestShared = "";
  // A turn deleted under another session stays deleted when a copy of it arrives.
  // That session held the turn, so it still counts as shared with it when
  // deciding which of the two is the original.
  for (const key of blocked) {
    let entry;
    try { entry = JSON.parse(key); } catch { continue; }
    const [p, other, id] = entry;
    if (p !== "claude" || other === sid || !mineById.has(String(id))) continue;
    skip.add(tombstoneKey(mineById.get(String(id))));
    share(String(other), String(id));
  }
  for (const [other, ids] of shared) {
    const theirs = theirRows.get(other) || [];
    resolution.set(other, firstEntryDirection(mine, theirs, ids) === null ? "unresolved" : "resolved");
    if (isOriginalOf(mine, theirs, ids)) {
      for (const row of theirs) if (ids.has(String(row.id))) {
        const next = mineById.get(String(row.id));
        if (tokenCount(next) >= tokenCount(row)) take.set(tombstoneKey(row), row);
        else skip.add(tombstoneKey(next));
      }
      branches.add(other);
      continue;
    }
    for (const id of ids) {
      const next = mineById.get(id);
      const holders = theirs.filter((r) => String(r.id) === id);
      if (holders.some((r) => tokenCount(r) >= tokenCount(next))) skip.add(tombstoneKey(next));
      else for (const row of holders) take.set(tombstoneKey(row), row);
    }
    // A branch of a branch shares turns with both; the one holding the latest of
    // them is the session it was branched from.
    const last = theirs.filter((r) => ids.has(String(r.id))).map((r) => String(r.ts || "")).sort().pop() || "";
    if (branchOf === null || last > latestShared) {
      branchOf = other;
      latestShared = last;
    }
  }
  return { skip, take, branches, branchOf, resolution };
}

/**
 * Replace what one transcript wrote for one session, filtering persistent
 * tombstones. Returns how many records were accepted; THROWS LockTimeoutError if
 * the lock was never acquired, so the caller can retry instead of recording a
 * phantom success.
 *
 * Without `transcriptId` the batch is taken to be the whole session, which holds
 * for every provider that keeps one source per session. With it, the batch
 * replaces only what that transcript wrote: Codex continues a reverted thread in
 * a new rollout under the same thread id, and reading one file must not delete
 * the other's turns.
 */
export async function upsertSession(file, sessionId, records, {
  precondition = null,
  preserveFields = (r) => r,
  transcriptId = null,
} = {}) {
  // Which provider this batch replaces. Session ids are only unique within a
  // provider, so replacing on the id alone would let one provider delete
  // another's rows — the same composite identity tombstoneKey() uses.
  const provider = records.length ? (records[0].provider ? String(records[0].provider) : "claude") : null;
  const transcript = transcriptId == null ? null : String(transcriptId);
  // Rows an older version wrote with no session at all got the id
  // "undefined:<startTs>". The turn now arriving with that same timestamp IS that
  // row, so it may replace it — but only that one. Matching the prefix alone
  // would delete every unrelated orphan in the file on any write.
  // The parser knows exactly which legacy id a turn used to carry; inferring it
  // from ts guessed wrong whenever the old id was built from a promptId.
  const supersededOrphanIds = new Set(
    records.map((r) => (r && r.legacyId ? String(r.legacyId) : null)).filter(Boolean),
  );
  const providerOf = rowProvider;

  const result = await mutateNdjson(file, (existing) => {
    // Re-checked under the lock: whatever these records were parsed from may have
    // moved on while we queued for it.
    if (precondition && precondition() === false) return ABORT;
    // A live OpenCode session can temporarily lose its per-turn allocation.
    // Keep the completed turns (and their deletion scope) until a complete read.
    if (provider === "opencode" && records.some((r) => r.quality === "session-rollup")
        && existing.some((r) => providerOf(r) === provider && r.sessionId === sessionId && r.quality !== "session-rollup")) {
      return ABORT;
    }
    // Read while holding usage lock. Viewer writes tombstone before waiting for
    // this lock, closing delete-vs-upsert resurrection races.
    const blocked = loadTombstoneKeys(tombstonePath(file));
    // Only a turn's own key blocks it. An old, position-based name is ambiguous —
    // it may be another transcript's turn — and honouring it hid every later
    // revert's turn at a position the user had once deleted. A continuation turn
    // deleted under its old name can reappear once; deleting it again sticks.
    const deleted = (r) => blocked.has(tombstoneKey(r));

    // A batch can carry the same turn twice. A re-parse appends the more complete
    // version, so the later copy wins — unless it carries fewer tokens: after
    // /compact, Claude Code writes earlier prompts again, and a replay holds none
    // of the turn's work.
    const incoming = new Map();
    for (const r of records) {
      if (deleted(r)) continue;
      const key = tombstoneKey(r);
      const held = incoming.get(key);
      if (held && tokenCount(held) > tokenCount(r)) continue;
      incoming.set(key, r);
    }
    const renamed = new Set();
    for (const r of incoming.values()) if (r.legacyId != null) renamed.add(String(r.legacyId));

    // `/branch` and `--fork-session` copy earlier turns into a new session under
    // the same message uuids, and counting them under both sessions paid for the
    // same work twice. Each copied turn stays with the session it came from.
    const copies = provider === "claude" && sessionId != null
      ? resolveCopies(existing, incoming, sessionId, new Set(readTombstones(tombstonePath(file)).filter((r) => r.reason !== "copy").map(tombstoneKey)))
      : null;
    if (copies) for (const key of copies.skip) incoming.delete(key);

    const replaced = [];
    const kept = [];
    // Turns another transcript already holds with at least as much work.
    const outranked = new Set();
    for (const row of existing) {
      if (copies && copies.take.has(tombstoneKey(row))) continue; // it came from this session
      if (copies && providerOf(row) === "claude" && copies.branches.has(String(row.sessionId))) {
        kept.push({ ...row, branchOf: String(sessionId), branchResolution: copies.resolution.get(String(row.sessionId)) });
        continue;
      }
      if (provider === null || providerOf(row) !== provider) {
        kept.push(row);
      } else if (row.sessionId !== sessionId) {
        const orphan = row.sessionId == null && typeof row.id === "string" && supersededOrphanIds.has(row.id);
        (orphan ? replaced : kept).push(row);
      } else if (transcript === null) {
        replaced.push(row);
      } else if (row.transcriptId != null) {
        const key = tombstoneKey(row);
        const mine = incoming.get(key);
        if (String(row.transcriptId) === transcript) {
          // This transcript read again: a turn that has left it goes too.
          replaced.push(row);
        } else if (mine && tokenCount(mine) > tokenCount(row)) {
          replaced.push(row);
        } else {
          // Another transcript's turn. When both carry it, keep the copy with the
          // work; on a tie the stored one stays, so two files never trade it back
          // and forth.
          if (mine) outranked.add(key);
          kept.push(row);
        }
      } else if (transcript === String(sessionId)
          || incoming.has(tombstoneKey(row))
          || (typeof row.id === "string" && renamed.has(row.id))) {
        // Stored before rows named their transcript. The session's own transcript
        // takes all of them, as every write used to: such rows can carry ids and
        // timestamps today's parser no longer produces, and only wholesale
        // replacement clears those. Any other transcript takes only the turns it
        // can name.
        replaced.push(row);
      } else {
        kept.push(row);
      }
    }

    // A turn inherits preserved fields and its cost only from a replaced row with
    // its own key — or from the copy of it this session takes back. A row claimed
    // through an old name is removed but passes on nothing: that name may have
    // belonged to a different turn.
    const priorByKey = new Map(replaced.map((row) => [tombstoneKey(row), row]));
    const takenById = new Map(copies ? [...copies.take.values()].map((row) => [String(row.id), row]) : []);
    const accepted = [];
    for (const [key, r] of incoming) {
      if (outranked.has(key)) continue;
      const prior = priorByKey.get(key) || takenById.get(String(r.id));
      let named = transcript === null ? r : { ...r, transcriptId: transcript };
      if (copies && copies.branchOf !== null) named = { ...named, branchOf: copies.branchOf, branchResolution: copies.resolution.get(copies.branchOf) };
      accepted.push(preserveComputedCost(preserveFields(named, prior), prior));
    }
    return {
      records: kept.concat(accepted),
      value: accepted.length,
    };
  });
  if (result === false) throw new LockTimeoutError(file);
  if (result.value === ABORT) return ABORT;
  return result.value;
}

/**
 * Collapse copies already stored under more than one Claude session.
 *
 * Versions before 2.6.0 stored a branch's copied turns under the branch too, and
 * a transcript Claude Code has since deleted is never read again to settle it.
 * For each shared turn, keep the holder with the most tokens; the original wins
 * ties. Branch labels follow the arbitration even when a branch holds more work.
 * Returns { drop, parentOf }; the input array is not modified.
 */
export function planCollapseCopies(records) {
  const bySession = new Map();
  const holders = new Map();
  for (const r of records) {
    if (rowProvider(r) !== "claude" || r.sessionId == null || r.id == null) continue;
    const s = String(r.sessionId);
    if (!bySession.has(s)) bySession.set(s, []);
    bySession.get(s).push(r);
    if (!copyable(r)) continue;
    if (!holders.has(r.id)) holders.set(r.id, new Set());
    holders.get(r.id).add(s);
  }
  const order = [...bySession.keys()].sort();
  const decided = new Map();
  // The original of two holders; `a` sorts before `b`, independent of discovery.
  const originalOf = (a, b) => {
    const key = `${a}\n${b}`;
    if (!decided.has(key)) {
      const theirs = new Set(bySession.get(a).filter(copyable).map((r) => r.id));
      const shared = new Set(bySession.get(b).filter(copyable).map((r) => r.id).filter((id) => theirs.has(id)));
      decided.set(key, isOriginalOf(bySession.get(b), bySession.get(a), shared) ? b : a);
    }
    return decided.get(key);
  };
  const winner = (x, y) => (order.indexOf(x) < order.indexOf(y) ? originalOf(x, y) : originalOf(y, x));

  const drop = new Set();
  const parentOf = new Map();
  for (const [id, sessions] of holders) {
    if (sessions.size < 2) continue;
    const list = order.filter((s) => sessions.has(s));
    const original = list.find((s) => list.every((o) => o === s || winner(s, o) === s)) || list[0];
    const work = (s) => Math.max(...bySession.get(s).filter((r) => r.id === id).map(tokenCount));
    const keep = list.reduce((best, s) => work(s) > work(best) ? s : best, original);
    for (const s of list) {
      const copy = bySession.get(s).filter((r) => String(r.id) === id);
      if (s !== keep) for (const r of copy) drop.add(r);
      if (s === original) continue;
      const ts = copy.map((r) => String(r.ts || "")).sort().pop() || "";
      const held = parentOf.get(s);
      const shared = new Set(bySession.get(original).filter(copyable).map((r) => r.id).filter((id) => bySession.get(s).some((r) => r.id === id)));
      const resolution = firstEntryDirection(bySession.get(original), bySession.get(s), shared) === null ? "unresolved" : "resolved";
      if (!held || ts > held.last || (ts === held.last && original < held.original)) parentOf.set(s, { original, last: ts, resolution });
    }
  }
  return { drop, parentOf };
}

/** Apply a collapse plan without modifying the input; returns { records, removed }. */
export function collapseCopies(records) {
  const { drop, parentOf } = planCollapseCopies(records);
  if (!drop.size) return { records, removed: 0 };
  const out = [];
  for (const r of records) {
    if (drop.has(r)) continue;
    const branch = rowProvider(r) === "claude" && r.sessionId != null ? parentOf.get(String(r.sessionId)) : null;
    out.push(branch ? { ...r, branchOf: branch.original, branchResolution: branch.resolution } : r);
  }
  return { records: out, removed: drop.size };
}

/** collapseCopies() applied to one usage file under its lock. Returns rows removed. */
export async function collapseStoredCopies(file) {
  const result = await mutateNdjson(file, (records) => {
    const { records: next, removed } = collapseCopies(records);
    return removed ? { records: next, value: removed } : ABORT;
  });
  if (result === false) throw new LockTimeoutError(file);
  return result.value === ABORT ? 0 : result.value;
}

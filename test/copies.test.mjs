import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupCandidateStores, cleanUpCopies } from "../src/lib/copies.mjs";
import { ingestTranscript } from "../src/lib/ingest.mjs";
import { buildTurns } from "../src/providers/claude/transcript.mjs";

// Before 2.6.0 a hook stored a whole session under whatever folder the agent was
// in when a turn ended, leaving copies in subfolders beside the session's own store.

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-copies-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sub = path.join(root, "web");
  const state = path.join(root, "_state");
  fs.mkdirSync(sub);
  fs.mkdirSync(state);
  return {
    root,
    sub,
    options: { backupDir: path.join(state, "backups"), reportFile: path.join(state, "report.json") },
    transcript: path.join(state, "s1.jsonl"),
  };
}

const row = (sessionId, id, cwd, ts) => ({ provider: "claude", sessionId, id, cwd, ts, cost: { total: 2, source: "priced" } });
const storeFile = (folder) => path.join(folder, ".ai-usage", "usage.ndjson");
const writeStore = (folder, rows) => {
  fs.mkdirSync(path.dirname(storeFile(folder)), { recursive: true });
  fs.writeFileSync(storeFile(folder), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
};
const readStore = (folder) => fs.readFileSync(storeFile(folder), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const keys = (folder) => readStore(folder).map((r) => `${r.sessionId}:${r.id}`);
// A transcript whose entries name these folders, as a session moved between them.
const naming = (p, folders) => {
  fs.writeFileSync(p.transcript, folders.map((cwd) => JSON.stringify({ type: "user", cwd })).join("\n") + "\n");
  return [{ transcriptPath: p.transcript }];
};

test("cleanup rechecks the home row's work after acquiring the copy lock", async (t) => {
  const p = project(t);
  const r = { ...row("s", "x", p.root, "2026-07-01"), usage: { input: 10 } };
  writeStore(p.root, [r]);
  writeStore(p.sub, [r]);
  const open = fs.openSync;
  t.after(() => { fs.openSync = open; });
  fs.openSync = (file, ...args) => {
    if (file === storeFile(p.sub) + ".lock") writeStore(p.root, [{ ...r, usage: { input: 1 } }]);
    return open(file, ...args);
  };
  await cleanUpCopies({ transcripts: naming(p, [p.root, p.sub]), ...p.options });
  assert.equal(readStore(p.sub)[0]?.usage.input, 10);
});

test("cleanup backs up the exact replacement bytes while holding the store lock", async (t) => {
  const p = project(t);
  const r = row("s", "x", p.root, "2026-07-01");
  writeStore(p.root, [r]);
  writeStore(p.sub, [r]);
  const open = fs.openSync, write = fs.writeFileSync, copy = fs.copyFileSync;
  let lockedBytes;
  t.after(() => { fs.openSync = open; fs.writeFileSync = write; fs.copyFileSync = copy; });
  fs.openSync = (file, ...args) => {
    if (file === storeFile(p.sub) + ".lock") {
      fs.appendFileSync(storeFile(p.sub), "  {torn line\n");
      lockedBytes = fs.readFileSync(storeFile(p.sub), "utf8");
    }
    return open(file, ...args);
  };
  const check = (file) => {
    if (typeof file === "string" && file.startsWith(p.options.backupDir) && file.endsWith(".ndjson")) {
      assert.ok(fs.existsSync(storeFile(p.sub) + ".lock"), "backup must be inside the source lock");
    }
  };
  fs.writeFileSync = (file, ...args) => { check(file); return write(file, ...args); };
  fs.copyFileSync = (source, target, ...args) => { check(target); return copy(source, target, ...args); };
  const report = await cleanUpCopies({ transcripts: naming(p, [p.root, p.sub]), ...p.options });
  const manifest = JSON.parse(fs.readFileSync(path.join(report.backup, "manifest.json")));
  assert.equal(fs.readFileSync(manifest.files[0].backup, "utf8"), lockedBytes);
});

test("cleanup keeps richer copies and leaves other providers alone", async (t) => {
  const p = project(t);
  const r = { ...row("s", "x", p.root, "2026-07-01"), usage: { input: 10 } };
  const codex = { ...r, provider: "codex" };
  writeStore(p.root, [r, codex]);
  writeStore(p.sub, [{ ...r, usage: { input: 10, output: 1 } }, codex]);
  const report = await cleanUpCopies({ transcripts: naming(p, [p.root, p.sub]), ...p.options });
  assert.equal(readStore(p.sub).length, 2);
  assert.equal(report.keptRicher, 1);
});

test("an interrupted second backup leaves the first changed file in the recovery manifest", async (t) => {
  const p = project(t);
  const extra = path.join(p.root, "extra");
  fs.mkdirSync(extra);
  const r = row("s", "x", p.root, "2026-07-01");
  for (const folder of [p.root, p.sub, extra]) writeStore(folder, [r]);
  const write = fs.writeFileSync, copy = fs.copyFileSync, rename = fs.renameSync;
  t.after(() => { fs.writeFileSync = write; fs.copyFileSync = copy; fs.renameSync = rename; });
  const fail = (file) => {
    if (typeof file === "string" && file.startsWith(p.options.backupDir) && path.basename(file) === "2.ndjson") throw new Error("interrupted backup");
  };
  fs.writeFileSync = (file, ...args) => { fail(file); return write(file, ...args); };
  fs.copyFileSync = (source, target, ...args) => { fail(target); return copy(source, target, ...args); };
  fs.renameSync = (source, target, ...args) => {
    if ([storeFile(p.sub), storeFile(extra)].includes(target)) {
      const dir = path.join(p.options.backupDir, fs.readdirSync(p.options.backupDir)[0]);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
      assert.ok(manifest.files.some((f) => f.source === target), "manifest must identify the source before replacement");
    }
    return rename(source, target, ...args);
  };
  await assert.rejects(cleanUpCopies({ transcripts: naming(p, [p.root, p.sub, extra]), ...p.options }), /interrupted backup/);
  const dir = path.join(p.options.backupDir, fs.readdirSync(p.options.backupDir)[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json")));
  assert.equal(manifest.files.length, 1);
  assert.equal(fs.readFileSync(manifest.files[0].source, "utf8"), "");
  assert.ok(fs.readFileSync(manifest.files[0].backup, "utf8").includes('"id":"x"'));
});

test("branch copies collapse across project stores and label the branch's own turns", async (t) => {
  const p = project(t);
  const x = "00000000-0000-4000-8000-000000000001";
  const y = "00000000-0000-4000-8000-000000000002";
  writeStore(p.root, [row("O", x, p.root, "2026-07-01")]);
  writeStore(p.sub, [{ ...row("B", x, p.root, "2026-07-01"), copied: true }, row("B", y, p.sub, "2026-07-02")]);
  const original = path.join(path.dirname(p.transcript), "O.jsonl");
  const branch = path.join(path.dirname(p.transcript), "B.jsonl");
  const prompt = (sessionId, uuid, cwd, timestamp) => ({ type: "user", sessionId, uuid, cwd, timestamp, message: { content: "work" } });
  fs.writeFileSync(original, JSON.stringify(prompt("O", x, p.root, "2026-07-01T10:00:00Z")) + "\n");
  fs.writeFileSync(branch, [
    { type: "system", timestamp: "2026-07-02T10:00:00Z" },
    prompt("B", x, p.root, "2026-07-01T10:00:00Z"), prompt("B", y, p.sub, "2026-07-02T10:00:01Z"),
  ].map(JSON.stringify).join("\n") + "\n");
  const transcripts = [original, branch].map((transcriptPath) => ({ transcriptPath }));
  const backup = await backupCandidateStores({ transcripts, ...p.options });
  for (const transcript of transcripts) await ingestTranscript({ id: "claude", buildTurns }, transcript);
  const report = await cleanUpCopies({ transcripts, ...p.options, backup });
  assert.equal(report.branchCopiesRemoved, 1);
  assert.deepEqual(readStore(p.root).map((r) => r.id), [x]);
  assert.deepEqual(readStore(p.sub).map((r) => [r.id, r.branchOf]), [[y, "O"]]);
});

test("rows copied into a subfolder's store go once the session's own store holds them", async (t) => {
  const p = project(t);
  const session = [row("s1", "a", p.root, "2026-07-01T10:00:00.000Z"), row("s1", "b", p.sub, "2026-07-01T10:05:00.000Z")];
  writeStore(p.root, session);
  writeStore(p.sub, [...session, row("s2", "x", p.sub, "2026-07-02T09:00:00.000Z")]);
  const before = fs.readFileSync(storeFile(p.sub), "utf8");

  const report = await cleanUpCopies({ transcripts: naming(p, [p.root, p.sub]), ...p.options });
  assert.deepEqual(keys(p.sub), ["s2:x"], "the subfolder keeps the session that started there");
  assert.deepEqual(keys(p.root), ["s1:a", "s1:b"], "the session's own store is untouched");
  assert.equal(report.copiesRemoved, 2);
  assert.equal(report.copiesCost, 4);
  assert.deepEqual(report.emptyStores, []);
  const manifest = JSON.parse(fs.readFileSync(path.join(report.backup, "manifest.json"), "utf8"));
  assert.equal(fs.readFileSync(manifest.files[0].backup, "utf8"), before, "the file as it was is backed up");
  assert.ok(fs.existsSync(p.options.reportFile));
});

test("a dry run reports what would go and changes nothing", async (t) => {
  const p = project(t);
  const session = [row("s1", "a", p.root, "2026-07-01T10:00:00.000Z")];
  writeStore(p.root, session);
  writeStore(p.sub, session);
  const before = fs.readFileSync(storeFile(p.sub), "utf8");
  const report = await cleanUpCopies({ transcripts: naming(p, [p.root, p.sub]), ...p.options, dryRun: true });
  assert.equal(report.copiesRemoved, 1);
  assert.deepEqual(report.emptyStores, [path.join(p.sub, ".ai-usage")]);
  assert.equal(fs.readFileSync(storeFile(p.sub), "utf8"), before);
  assert.equal(fs.existsSync(p.options.backupDir), false);
  assert.equal(fs.existsSync(p.options.reportFile), false);
});

test("a copy its session's own store lacks is kept", async (t) => {
  const p = project(t);
  writeStore(p.root, [row("s1", "a", p.root, "2026-07-01T10:00:00.000Z")]);
  writeStore(p.sub, [row("s1", "a", p.root, "2026-07-01T10:00:00.000Z"), row("s1", "b", p.root, "2026-07-01T10:05:00.000Z")]);
  await cleanUpCopies({ transcripts: naming(p, [p.sub]), ...p.options });
  assert.deepEqual(keys(p.sub), ["s1:b"]);
});

test("a session whose transcript is gone is placed by its earliest stored row", async (t) => {
  const p = project(t);
  const session = [row("s1", "b", p.sub, "2026-07-01T10:05:00.000Z"), row("s1", "a", p.root, "2026-07-01T10:00:00.000Z")];
  writeStore(p.root, session);
  writeStore(p.sub, session);
  // No transcript names the start folder; the copy's own rows lead to it.
  const report = await cleanUpCopies({ transcripts: naming(p, [p.sub]), ...p.options });
  assert.equal(fs.existsSync(storeFile(p.root)), true);
  assert.deepEqual(keys(p.root).sort(), ["s1:a", "s1:b"]);
  assert.deepEqual(keys(p.sub), []);
  assert.deepEqual(report.emptyStores, [path.join(p.sub, ".ai-usage")], "only the empty usage directory is offered for deletion");
});

test("a second run changes nothing and backs up nothing", async (t) => {
  const p = project(t);
  const session = [row("s1", "a", p.root, "2026-07-01T10:00:00.000Z")];
  writeStore(p.root, session);
  writeStore(p.sub, session);
  const transcripts = naming(p, [p.root, p.sub]);
  const first = await cleanUpCopies({ transcripts, ...p.options, now: new Date("2026-09-15T10:00:00.000Z") });
  const after = fs.readFileSync(storeFile(p.sub), "utf8");
  const second = await cleanUpCopies({ transcripts, ...p.options, now: new Date("2026-09-15T11:00:00.000Z") });
  assert.equal(first.copiesRemoved, 1);
  assert.equal(second.copiesRemoved + second.branchCopiesRemoved, 0);
  assert.equal(second.backup, null);
  assert.equal(fs.readFileSync(storeFile(p.sub), "utf8"), after);
  assert.deepEqual(fs.readdirSync(p.options.backupDir).length, 1, "no second backup");
});

test("turns stored under a branch as well as its original are collapsed in the same pass", async (t) => {
  const p = project(t);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  writeStore(p.root, [
    row("O", id(1), p.root, "2026-07-18T10:00:00.000Z"),
    row("B", id(1), p.root, "2026-07-18T10:00:00.000Z"),
    row("B", id(2), p.root, "2026-07-21T12:55:00.000Z"),
  ]);
  const report = await cleanUpCopies({ transcripts: naming(p, [p.root]), ...p.options });
  assert.equal(report.branchCopiesRemoved, 1);
  assert.deepEqual(readStore(p.root).map((r) => `${r.sessionId}:${r.id.slice(-1)}:${r.branchOf || "-"}`), ["O:1:-", "B:2:O"]);
});

// Repair backups were kept for good (14 copies, 458 MB on one machine): only the newest few stay.
import { pruneBackups, BACKUPS_KEPT } from "../src/lib/copies.mjs";

function backupsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-backups-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const ours = (dir, day, manifest = true) => {
  const name = `2026-09-${day}T10-00-00-000Z-00000000-0000-4000-8000-0000000000${day}`;
  fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, name, "1.ndjson"), "{}\n");
  if (manifest) fs.writeFileSync(path.join(dir, name, "manifest.json"), "{}");
  return name;
};

test("old repair backups are pruned to the newest few; nothing else is touched", (t) => {
  const dir = backupsDir(t);
  const names = ["10", "11", "12", "13", "14"].map((d) => ours(dir, d));
  const unmanifested = ours(dir, "09", false);
  fs.mkdirSync(path.join(dir, "my-own-copy"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
  assert.equal(BACKUPS_KEPT, 3);
  assert.deepEqual(pruneBackups({ backupDir: dir }), names.slice(0, 2), "the two oldest");
  assert.deepEqual(fs.readdirSync(dir).sort(), [...names.slice(2), unmanifested, "my-own-copy", "notes.txt"].sort());
  assert.deepEqual(pruneBackups({ backupDir: dir }), [], "a second run removes nothing");
  assert.deepEqual(pruneBackups({ backupDir: path.join(dir, "absent") }), [], "a missing folder is fine");
});

test("taking a repair backup prunes the older ones", async (t) => {
  const dir = backupsDir(t);
  for (const d of ["10", "11", "12", "13"]) ours(dir, d);
  await backupCandidateStores({ transcripts: [], backupDir: dir });
  assert.equal(fs.readdirSync(dir).length, BACKUPS_KEPT);
});

test("pruning never removes the backup a repair just took, nor the one the cleanup report names", (t) => {
  const dir = backupsDir(t);
  const report = path.join(dir, "..", `report-${path.basename(dir)}.json`);
  t.after(() => fs.rmSync(report, { force: true }));
  const names = ["10", "11", "12", "13", "14", "15"].map((d) => ours(dir, d));
  // The report names the oldest; a repair just took "10" again under a clock set back.
  fs.writeFileSync(report, JSON.stringify({ backup: path.join(dir, names[1]) }));
  const removed = pruneBackups({ backupDir: dir, protect: [path.join(dir, names[0])], reportFile: report });
  assert.deepEqual(removed, names.slice(2, 3), "only the oldest unprotected one beyond the newest three");
  for (const kept of [names[0], names[1], ...names.slice(3)]) assert.ok(fs.existsSync(path.join(dir, kept)), kept);
});

#!/usr/bin/env node
// Stop-hook launcher. Keep this file builtins-only and fire-and-forget: all
// provider parsing, rescans, locking, and usage writes belong in worker.mjs.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hookPricing } from "./lib/hook-pricing.mjs";

const MAX_STDIN_BYTES = 1024 * 1024;
// Idle cap: how long to wait with NO new data before giving up. Reset by every
// chunk, so a payload arriving in pieces is never truncated mid-stream, while a
// hook that leaves stdin open with nothing to say still releases the agent fast.
const STDIN_IDLE_MS = 150;
// Absolute ceiling regardless of activity — the hook must never hang the agent.
const MAX_STDIN_WAIT_MS = 2000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((value) => value.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function spoolDir() {
  return process.env.AI_USAGE_SPOOL_DIR
    || path.join(os.homedir(), ".ai-usage-inspector", "spool");
}

function readStdinBounded() {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;

    let idleTimer = null;

    const finish = (truncated = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      process.stdin.pause();
      process.stdin.removeAllListeners();
      resolve({ raw: Buffer.concat(chunks, bytes).toString("utf8"), truncated });
    };

    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(true), STDIN_IDLE_MS);
      idleTimer.unref();
    };

    const hardTimer = setTimeout(() => finish(true), MAX_STDIN_WAIT_MS);
    hardTimer.unref();
    armIdle();

    process.stdin.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = MAX_STDIN_BYTES - bytes;
      if (buf.length >= remaining) {
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        bytes += Math.max(remaining, 0);
        finish(true);
        return;
      }
      chunks.push(buf);
      bytes += buf.length;
      armIdle(); // more data may still be coming — don't cut the stream short
    });
    process.stdin.once("end", () => finish(false));
    process.stdin.once("error", () => finish(true));
    process.stdin.resume();
  });
}

export function writeSpool(envelope, dir = spoolDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stem = `event-${Date.now()}-${process.pid}-${randomUUID()}-a0`;
  const finalFile = path.join(dir, `${stem}.event`);
  const tempFile = path.join(dir, `${stem}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(envelope) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(tempFile, finalFile);
    return finalFile;
  } catch (error) {
    try { fs.rmSync(tempFile, { force: true }); } catch {}
    throw error;
  }
}

function launchWorker() {
  const child = spawn(process.execPath, [path.join(__dirname, "worker.mjs")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", () => {});
  child.unref();
}

export async function runLauncher({
  input,
  dir,
  provider = arg("--provider", "claude"),
  cwd = process.cwd(),
  spawnWorker = true,
} = {}) {
  try {
    const { raw, truncated } = input === undefined
      ? await readStdinBounded()
      : { raw: String(input), truncated: false };
    let payload;
    try { payload = JSON.parse(raw); } catch {}
    // Best-effort evidence: a malformed payload must never cost the event itself.
    let pricing = {};
    try { pricing = hookPricing(provider, typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : cwd); } catch {}
    writeSpool({
      pricing,
      schema: 1,
      provider,
      cwd,
      raw,
      truncated,
      createdAt: Date.now(),
      attempts: 0,
      aiUsageDir: process.env.AI_USAGE_DIR || null,
    }, dir);
    if (spawnWorker) launchWorker();
  } catch {}
  return 0;
}

const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  runLauncher()
    .catch(() => {})
    .finally(() => process.exit(0));
}

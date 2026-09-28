// Capture only billing classifications before a hook is queued; never spool endpoints.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function normalizeServiceTier(value) {
  if (value === "priority" || value === "fast") return "fast";
  return value === "flex" ? "flex" : "standard";
}

export function readServiceTier(file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml")) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const match = /^\s*service_tier\s*=\s*(["'])([^"']*)\1\s*(?:#.*)?$/.exec(line);
      if (match) return match[2];
    }
  } catch {}
  return null;
}

export function classifyEndpoint(value) {
  if (value == null || value === "") return "anthropic";
  let host;
  try { host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, ""); }
  catch { return "remote"; }
  if (host === "api.anthropic.com") return "anthropic";
  // An IPv4-mapped IPv6 address is that IPv4 address; URL writes it as ::ffff:hhhh:hhhh.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    host = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "host.docker.internal"
      || host === "::1" || /^(fc|fd)[0-9a-f]{2}:/.test(host)) return "local";
  // URL canonicalizes IPv4 and IPv6, including expanded loopback addresses.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (host === "0.0.0.0" || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 168) || (a === 169 && b === 254)) return "local";
  }
  return "remote";
}

/**
 * The endpoint Claude Code's settings chain names now, and when any file in that chain last
 * changed. Never throws.
 */
export function settingsEvidence(cwd, home = os.homedir()) {
  const files = typeof cwd === "string" && cwd
    ? [path.join(cwd, ".claude", "settings.local.json"), path.join(cwd, ".claude", "settings.json")] : [];
  files.push(path.join(home, ".claude", "settings.json"));
  let endpoint = null, changedAt = 0;
  for (const file of files) {
    try { changedAt = Math.max(changedAt, fs.statSync(file).mtimeMs); } catch { continue; }
    if (endpoint) continue;
    try {
      const env = JSON.parse(fs.readFileSync(file, "utf8"))?.env;
      if (env && Object.hasOwn(env, "ANTHROPIC_BASE_URL")) endpoint = classifyEndpoint(env.ANTHROPIC_BASE_URL);
    } catch {}
  }
  return { endpoint, changedAt };
}

/**
 * The settings' endpoint, as evidence for a turn that ran at `at` (ms). Today's settings say
 * nothing about a turn that ran before any file in the chain last changed: pointing Claude
 * Code at a local model today must not turn a history of API use into $0. The hook passes
 * no `at`, since it records the turn that just ended.
 */
export function settingsEndpoint(cwd, home = os.homedir(), at = Infinity) {
  const { endpoint, changedAt } = settingsEvidence(cwd, home);
  return endpoint && changedAt <= at ? endpoint : null;
}

export function hookPricing(provider, cwd) {
  if (provider === "codex") return { serviceTier: normalizeServiceTier(readServiceTier()) };
  if (provider === "claude") return { endpoint: process.env.ANTHROPIC_BASE_URL !== undefined
    ? classifyEndpoint(process.env.ANTHROPIC_BASE_URL) : settingsEndpoint(cwd) || "anthropic" };
  return {};
}

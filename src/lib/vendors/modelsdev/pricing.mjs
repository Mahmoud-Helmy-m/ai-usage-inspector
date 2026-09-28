import fs from "node:fs";
import { CACHE_FILE, readCachedRates } from "./remote-pricing.mjs";

// Routing is deliberately by model family, never a search across resellers.
const FIRST_PARTY = [
  [/^kimi/i, "moonshotai"], [/^deepseek/i, "deepseek"], [/^(qwen|qwq)/i, "alibaba"],
  [/^minimax/i, "minimax"], [/^grok/i, "xai"], [/^gemini/i, "google"],
  [/^(mistral|devstral|codestral|magistral)/i, "mistral"], [/^command/i, "cohere"], [/^llama/i, "llama"],
];
export function platformOf(modelId) {
  const id = String(modelId || "").toLowerCase();
  if (/^(?:(?:us|eu|apac|jp|au|global|us-gov)\.)?anthropic\.claude-/.test(id)) return "amazon-bedrock";
  if (/^claude-.*@\d{8}$/.test(id)) return "google-vertex-anthropic";
  return null;
}
export function anthropicId(modelId) {
  return String(modelId || "").toLowerCase()
    .replace(/^(?:us|eu|apac|jp|au|global|us-gov)\./, "").replace(/^anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "").replace(/@\d{8}$/, "").replace(/-\d{8}$/, "");
}
export function providerForId(modelId) {
  const id = String(modelId || "").trim().toLowerCase();
  return platformOf(id) || (id.includes("/") ? "openrouter" : FIRST_PARTY.find(([re]) => re.test(id))?.[1]) || null;
}
let signature = null, rates = {};
function cachedRates() {
  // The worker may refresh after imports, and the dashboard may refresh in another
  // process. Observe the new file without reparsing it for every message.
  try {
    const s = fs.statSync(CACHE_FILE);
    const next = `${s.mtimeMs}:${s.ctimeMs}:${s.size}`;
    if (next !== signature) { rates = readCachedRates() || {}; signature = next; }
  } catch { rates = {}; signature = null; }
  return rates;
}
export function lookup(modelId, providers = null, promptSize = 0) {
  const id = String(modelId || "").trim().toLowerCase();
  const platform = platformOf(id);
  const candidates = providers || (platform === "google-vertex-anthropic"
    ? [platform, "google-vertex"] : platform ? [platform]
      : [providerForId(id)]);
  const table = cachedRates();
  for (const provider of candidates) {
    const r = table[provider]?.[id];
    if (r && Number.isFinite(r.input) && r.input >= 0 && Number.isFinite(r.output) && r.output >= 0) {
      // Context boundaries are exclusive; cache prices belong to the selected tier.
      const tier = Array.isArray(r.tiers) ? r.tiers.filter((t) => promptSize > t.size).at(-1) : null;
      return { ...r, ...tier, provider, rateSource: "models.dev", windowKnown: r.contextMax > 0 };
    }
  }
  return null;
}

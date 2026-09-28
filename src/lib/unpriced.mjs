// Successful checks for unpublished prices must not turn every turn into an
// hourly download. This is refresh state, deliberately outside pricing-*.json.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const UNPRICED_FILE = path.join(os.homedir(), ".ai-usage-inspector", "unpriced.json");
export function readUnpriced(file = UNPRICED_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
export function writeUnpriced(value, file = UNPRICED_FILE) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); } catch {}
}

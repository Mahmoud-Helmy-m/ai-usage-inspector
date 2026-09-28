import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach } from "node:test";

// Set defaults before provider imports, and isolate each test's environment too.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-tests-"));
const directories = ["APPDATA", "LOCALAPPDATA", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"];
const keys = ["HOME", "USERPROFILE", "CODEX_HOME", "AI_USAGE_DIR", "AI_USAGE_SCAN_STATE_FILE", "ANTHROPIC_BASE_URL", ...directories];
const initial = keys.map((key) => process.env[key]);
const restore = (values) => keys.forEach((key, i) => {
  if (values[i] === undefined) delete process.env[key];
  else process.env[key] = values[i];
});
process.env.HOME = process.env.USERPROFILE = base;
// No test reaches the network, and child processes the tests start inherit this.
process.env.AI_USAGE_NO_PRICING_REFRESH = "1";
process.env.CODEX_HOME = path.join(base, ".codex");
delete process.env.AI_USAGE_DIR;
delete process.env.ANTHROPIC_BASE_URL;
process.env.AI_USAGE_SCAN_STATE_FILE = path.join(base, "scan-state.json");
for (const key of directories) {
  process.env[key] = path.join(base, key);
  fs.mkdirSync(process.env[key]);
}
let saved;
beforeEach(() => {
  saved = keys.map((key) => process.env[key]);
  delete process.env.AI_USAGE_DIR;
  delete process.env.ANTHROPIC_BASE_URL;
  process.env.CODEX_HOME = path.join(base, ".codex");
});
afterEach(() => restore(saved));
process.on("exit", () => {
  restore(initial);
  fs.rmSync(base, { recursive: true, force: true });
});

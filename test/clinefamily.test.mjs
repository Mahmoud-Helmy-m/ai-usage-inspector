import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { kilo } from "../src/providers/clinefamily/index.mjs";

function makeTask(uiMessages, history) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-cline-"));
  fs.writeFileSync(path.join(dir, "ui_messages.json"), JSON.stringify(uiMessages));
  if (history) fs.writeFileSync(path.join(dir, "api_conversation_history.json"), JSON.stringify(history));
  return dir;
}
const apiReq = (o) => ({ type: "say", say: "api_req_started", text: JSON.stringify(o) });

test("Cline-family segments user prompts and sums agentic api_reqs", () => {
  const ui = [
    { ts: 1000, type: "say", say: "text", text: "do the thing" }, // task prompt
    { ts: 1001, ...apiReq({ tokensIn: 1000, tokensOut: 50, cacheWrites: 10, cacheReads: 200, cost: 0.01 }) },
    { ts: 1002, type: "ask", ask: "tool", text: "readFile" },
    { ts: 1003, type: "say", say: "text", text: "partial answer" }, // assistant text (not first)
    { ts: 1004, ...apiReq({ tokensIn: 2000, tokensOut: 80, cacheWrites: 0, cacheReads: 300, cost: 0.02 }) },
    { ts: 2000, type: "say", say: "user_feedback", text: "now do more" }, // new turn
    { ts: 2001, ...apiReq({ tokensIn: 1500, tokensOut: 60, cacheWrites: 0, cacheReads: 100, cost: 0.015 }) },
  ];
  const history = [{
    role: "user",
    content: [
      { type: "text", text: "<task>do the thing</task>" },
      { type: "text", text: "<environment_details>\n<model>anthropic/claude-sonnet-4</model>\n# Current Workspace Directory (K:/proj) Files\n</environment_details>" },
    ],
  }];
  const dir = makeTask(ui, history);
  try {
    const turns = kilo.buildTurns({ taskId: "t1", dir }, {});
    assert.equal(turns.length, 2);

    const a = turns[0];
    assert.equal(a.provider, "kilo");
    assert.equal(a.prompt, "do the thing");
    assert.equal(a.response, "partial answer");
    assert.equal(a.model, "anthropic/claude-sonnet-4");
    assert.equal(a.cwd, "K:/proj");
    assert.equal(a.counts.apiCalls, 2);
    assert.equal(a.counts.toolCalls, 1);
    assert.equal(a.usage.input, 3000); // 1000 + 2000 summed
    assert.equal(a.usage.cacheRead, 500); // 200 + 300
    assert.equal(a.usage.cacheCreate, 10); // cacheWrites
    assert.equal(a.cost.total, 0.03); // 0.01 + 0.02
    // context fill uses the PEAK single call (2000+300), not the sum
    assert.equal(a.contextTokens, 2300);

    const b = turns[1];
    assert.equal(b.prompt, "now do more");
    assert.equal(b.counts.apiCalls, 1);
    assert.equal(b.usage.input, 1500);
    assert.equal(b.cost.total, 0.015);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Cline-family skips tasks with no usable api_req usage", () => {
  const dir = makeTask([
    { ts: 1, type: "say", say: "text", text: "hi" },
    { ts: 2, ...apiReq({ tokensIn: 0, tokensOut: 0, cost: 0 }) },
  ], null);
  try {
    assert.deepEqual(kilo.buildTurns({ taskId: "t2", dir }, {}), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("Kilo stores null context window and fill when the model window is unknown", () => {
  const dir = makeTask([
    { ts: 1000, type: "say", say: "text", text: "hello" },
    { ts: 1001, ...apiReq({ tokensIn: 42, tokensOut: 1, cost: .01 }) },
  ], [{ role: "user", content: [{ type: "text", text: "<environment_details><model>unknown-model</model></environment_details>" }] }]);
  try {
    const [row] = kilo.buildTurns({ taskId: "unknown", dir }, {});
    assert.equal(row.contextTokens, 42);
    assert.equal(row.contextMax, null); assert.equal(row.contextFillPct, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("zai: Cline Roo Kilo retain reported cost and use vendor windows", async (t) => {
  const { cline, roo } = await import("../src/providers/clinefamily/index.mjs");
  for (const provider of [cline, roo, kilo]) for (const [model, window] of [["zai/GLM-5.3-Flash", 1000000], ["glm-5.2", null], ["glm-unknown", null]]) {
    const dir = makeTask([
      { ts: 1000, type: "say", say: "text", text: "synthetic" },
      { ts: 1001, ...apiReq({ model, tokensIn: 10000, tokensOut: 100, cost: 7.25 }) },
    ]);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const [row] = provider.buildTurns({ taskId: "glm", dir }, {});
    assert.equal(row.provider, provider.id);
    assert.equal(row.vendor, "z.ai");
    assert.equal(row.cost.total, 7.25);
    assert.equal(row.cost.source, "provider");
    assert.equal(row.contextMax, window);
    assert.equal(row.contextFillPct, window ? 1 : null);
  }
});

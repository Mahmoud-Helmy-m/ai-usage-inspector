import "../test-support/isolate.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSseRegistry } from "../viewer/sse.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("failed SSE notifications use the idempotent drop path", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.write = () => { throw new Error("closed"); };
  let drops = 0;
  const clients = createSseRegistry({ onDrop: () => drops++, heartbeatMs: 1000, notifyDelayMs: 1 });
  clients.add(req, res);
  clients.notify();
  await pause(15);
  req.emit("close");
  req.emit("error", new Error("also closed"));

  assert.equal(clients.size, 0);
  assert.equal(drops, 1, "later request events cannot arm cleanup twice");
});

test("failed SSE heartbeats remove the client and arm cleanup", async () => {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.write = () => { throw new Error("closed"); };
  let drops = 0;
  const clients = createSseRegistry({ onDrop: () => drops++, heartbeatMs: 2 });
  clients.add(req, res);
  await pause(15);

  assert.equal(clients.size, 0);
  assert.equal(drops, 1);
});

test("a named event reaches every client at once, apart from data changes", async (t) => {
  const written = [];
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.write = (chunk) => { written.push(chunk); };
  const clients = createSseRegistry({ onDrop: () => {}, heartbeatMs: 60_000, notifyDelayMs: 1 });
  const drop = clients.add(req, res);
  t.after(drop);
  clients.send("synced");
  assert.deepEqual(written, ["event: synced\ndata: {}\n\n"], "sent at once, as its own event");
  const broken = new EventEmitter();
  broken.write = () => { throw new Error("closed"); };
  clients.add(new EventEmitter(), broken);
  clients.send("synced");
  assert.equal(clients.size, 1, "a client that cannot be written to is dropped");
});

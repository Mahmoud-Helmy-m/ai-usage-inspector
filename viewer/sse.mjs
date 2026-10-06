// Node can surface one disconnect through several events. One guarded cleanup
// keeps those duplicates harmless and ensures none bypasses idle shutdown.
export function createSseRegistry({
  onDrop,
  heartbeatMs = 25_000,
  notifyDelayMs = 400,
}) {
  const clients = new Map();
  let notifyTimer = null;

  function add(req, res) {
    let dropped = false;
    let beat = null;
    const drop = () => {
      if (dropped) return;
      dropped = true;
      clearInterval(beat);
      clients.delete(res);
      onDrop();
    };

    clients.set(res, drop);
    beat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        drop();
      }
    }, heartbeatMs);
    if (beat.unref) beat.unref();
    req.on("close", drop);
    req.on("error", drop);
    res.on("error", drop);
    return drop;
  }

  function notify() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      for (const [res, drop] of clients) {
        try {
          res.write("event: change\ndata: {}\n\n");
        } catch {
          drop();
        }
      }
    }, notifyDelayMs);
    if (notifyTimer.unref) notifyTimer.unref();
  }

  // A named event, sent at once: news that is not "the data changed" (a sync finishing).
  function send(event) {
    for (const [res, drop] of clients) {
      try {
        res.write(`event: ${event}\ndata: {}\n\n`);
      } catch {
        drop();
      }
    }
  }

  return {
    add,
    notify,
    send,
    get size() { return clients.size; },
  };
}

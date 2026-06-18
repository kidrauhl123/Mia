// src/main/tasks-routes.js
const { computeNextFire } = require("./scheduler.js");

function writeJSON(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(body));
}

function createTasksRoutes({ store, events, runNow, onChange }) {
  async function handle(req, res, body) {
    const url = req.url;
    const method = req.method;

    if (method === "GET" && url === "/api/tasks") {
      const now = Date.now();
      const tasks = store.list().map((t) => ({
        ...t,
        nextFireAt: computeNextFire(t.trigger, t.timezone, now)
      }));
      writeJSON(res, 200, { tasks });
      return true;
    }
    if (method === "GET" && url.startsWith("/api/tasks/")) {
      const id = url.slice("/api/tasks/".length);
      const task = store.get(id);
      if (!task) { writeJSON(res, 404, { error: "task not found" }); return true; }
      writeJSON(res, 200, { task });
      return true;
    }
    if (method === "POST" && url === "/api/tasks") {
      try {
        const task = store.create(body || {});
        const taskWithNextFire = {
          ...task,
          nextFireAt: computeNextFire(task.trigger, task.timezone, Date.now())
        };
        events.emit("created", { taskId: task.id, task: taskWithNextFire });
        onChange?.();
        writeJSON(res, 201, { task: taskWithNextFire });
      } catch (e) {
        writeJSON(res, 400, { error: String(e?.message || e) });
      }
      return true;
    }
    const idMatch = url.match(/^\/api\/tasks\/([^/]+)(?:\/(run-now|pause|resume))?$/);
    if (idMatch) {
      const id = idMatch[1];
      const action = idMatch[2];
      if (method === "PATCH" && !action) {
        try {
          const task = store.update(id, body || {});
          events.emit("updated", { taskId: id, task });
          onChange?.();
          writeJSON(res, 200, { task });
        } catch (e) {
          writeJSON(res, 400, { error: String(e?.message || e) });
        }
        return true;
      }
      if (method === "DELETE" && !action) {
        store.delete(id);
        events.emit("deleted", { taskId: id });
        onChange?.();
        writeJSON(res, 200, { ok: true });
        return true;
      }
      if (method === "POST" && action === "run-now") {
        try {
          const result = await runNow(id);
          writeJSON(res, 200, result);
        } catch (e) {
          writeJSON(res, 500, { error: String(e?.message || e) });
        }
        return true;
      }
      if (method === "POST" && action === "pause") {
        const task = store.pause(id);
        events.emit("updated", { taskId: id, task });
        onChange?.();
        writeJSON(res, 200, { task });
        return true;
      }
      if (method === "POST" && action === "resume") {
        const task = store.resume(id);
        events.emit("updated", { taskId: id, task });
        onChange?.();
        writeJSON(res, 200, { task });
        return true;
      }
    }
    return false;
  }

  function handleEventsStream(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*"
    });
    res.write(": connected\n\n");
    const unsubscribe = events.subscribe((envelope) => {
      if (res.destroyed || res.writableEnded) return;
      res.write(`event: ${envelope.type}\n`);
      res.write(`data: ${JSON.stringify(envelope.payload)}\n\n`);
    });
    req.on("close", () => { try { unsubscribe(); } catch {} });
  }

  return { handle, handleEventsStream };
}

module.exports = { createTasksRoutes };

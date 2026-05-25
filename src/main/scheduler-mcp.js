// src/main/scheduler-mcp.js
// MCP server bridge for scheduler. Writes a manifest into the bridge directory
// so Claude Code / Codex can discover the schedule.* tools, and exposes a
// handler that the bridge invokes.

const SCHEDULER_MCP_NAME = "mia-scheduler";

function makeManifest() {
  return {
    name: SCHEDULER_MCP_NAME,
    version: "0.1.0",
    description: "Mia scheduler — create / list / update / pause / resume / delete cron and one-shot tasks.",
    tools: [
      {
        name: "schedule.create",
        description: "Create a scheduled task. Returns { taskId }.",
        input: {
          title: { type: "string", description: "Short human-readable label" },
          fellowId: { type: "string", description: "Fellow that will execute the task" },
          sessionId: { type: "string", description: "Session where the originating conversation lives" },
          originMessageId: { type: "string", description: "Message id of the user instruction that prompted creation" },
          trigger: {
            type: "object",
            description: "{ type: 'cron'|'oneshot', cron?: string, at?: ISO-8601 }"
          },
          timezone: { type: "string", description: "IANA tz name; defaults to UTC" },
          prompt: { type: "string", description: "What the fellow should do each time the task fires" }
        }
      },
      { name: "schedule.list",   description: "List all tasks.",   input: {} },
      { name: "schedule.update", description: "Patch a task by id.", input: { id: { type: "string" }, partial: { type: "object" } } },
      { name: "schedule.delete", description: "Delete a task by id.", input: { id: { type: "string" } } },
      { name: "schedule.pause",  description: "Pause a task by id.",  input: { id: { type: "string" } } },
      { name: "schedule.resume", description: "Resume a task by id.", input: { id: { type: "string" } } }
    ]
  };
}

function createSchedulerMcp({ store, scheduler, events }) {
  async function invoke(toolName, args = {}) {
    switch (toolName) {
      case "schedule.create": {
        const task = store.create(args);
        events.emit("created", { taskId: task.id, task });
        scheduler.rescan();
        return { taskId: task.id };
      }
      case "schedule.list": {
        return { tasks: store.list() };
      }
      case "schedule.update": {
        const task = store.update(args.id, args.partial || {});
        events.emit("updated", { taskId: task.id, task });
        scheduler.rescan();
        return { task };
      }
      case "schedule.delete": {
        store.delete(args.id);
        events.emit("deleted", { taskId: args.id });
        scheduler.rescan();
        return { ok: true };
      }
      case "schedule.pause": {
        const task = store.pause(args.id);
        events.emit("updated", { taskId: task.id, task });
        scheduler.rescan();
        return { task };
      }
      case "schedule.resume": {
        const task = store.resume(args.id);
        events.emit("updated", { taskId: task.id, task });
        scheduler.rescan();
        return { task };
      }
      default:
        throw new Error("unknown tool: " + toolName);
    }
  }
  return { name: SCHEDULER_MCP_NAME, manifest: makeManifest(), invoke };
}

module.exports = { createSchedulerMcp, SCHEDULER_MCP_NAME };

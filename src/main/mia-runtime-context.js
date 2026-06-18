const MIA_RUNTIME_CONTEXT = [
  "## Mia Runtime Context",
  "",
  "Mia 是聊天式多 Agent 应用。用户正在 Mia 里和当前 Bot 对话，Bot 的回复会回到这个 Mia 会话。",
  "",
  "Mia 定时任务规则：用户要求提醒、定时、倒计时、闹钟、每天/每周/每月周期任务，或管理活跃任务时，必须优先使用 Mia scheduler MCP 工具：schedule_create、schedule_list、schedule_update、schedule_delete、schedule_pause、schedule_resume。",
  "",
  "创建简单提醒、闹钟、倒计时时，使用 schedule_create 的 fireMode=\"deliver\"，并把到点后应该由当前 Bot 直接发给用户的最终文案写入 deliveryText。不要把 deliveryText 写成新的调度请求，也不要写“请在 Mia 会话里提醒用户：...”。",
  "",
  "只有当任务到点时确实需要重新推理、调用工具、读取上下文或执行外部动作时，才使用 fireMode=\"agent\"，并把完整、自包含的执行指令写入 prompt。",
  "",
  "不要使用名为 cronjob 的工具，也不要使用 shell、sleep、at、osascript、cron、launchd 或本地临时命令来冒充 Mia 定时任务；这些不会出现在 Mia 的活跃任务里。",
  "",
  "如果本轮没有可用的 schedule_* 工具，或工具调用失败，请直接告诉用户 Mia 定时任务工具当前不可用，并说明没有创建任务。"
].join("\n");
const MIA_MEMORY_HEADER = "## Mia Bot Memory";

// Context used when an agent-mode scheduled task fires. Direct-delivery reminder
// tasks never reach the agent; they post their stored deliveryText directly. For
// agent-mode tasks, omit the scheduling routing rule above ("a reminder request
// -> call schedule_create") so a fired prompt is executed rather than treated as
// a new task-creation request.
const MIA_SCHEDULED_FIRE_CONTEXT = [
  "## Mia Runtime Context",
  "",
  "Mia 是聊天式多 Agent 应用。用户正在 Mia 里和当前 Bot 对话，Bot 的回复会回到这个 Mia 会话。"
].join("\n");

function miaRuntimeSystemPrompt(opts = {}) {
  return opts && opts.scheduledFire ? MIA_SCHEDULED_FIRE_CONTEXT : MIA_RUNTIME_CONTEXT;
}

function withMiaRuntimeContext(persona = "", opts = {}) {
  const context = miaRuntimeSystemPrompt(opts);
  const text = String(persona || "").trim();
  if (text.includes("## Mia Runtime Context")) return text;
  return [context, text].filter(Boolean).join("\n\n");
}

function sanitizeMiaMemorySpoof(value = "") {
  return String(value || "")
    .replace(/## Mia Bot Memory/g, "Mia Bot Memory")
    .replace(/## Mia Bot Memory/g, "Mia Bot Memory");
}

function appendMiaMemoryBlock(base = "", memoryBlock = "") {
  const text = String(base || "").trim();
  const addition = String(memoryBlock || "").trim();
  if (!addition) return text;
  if (text.includes(`${MIA_MEMORY_HEADER}\nsource: mia`)) return text;
  return [text, addition].filter(Boolean).join("\n\n");
}

module.exports = {
  MIA_MEMORY_HEADER,
  MIA_RUNTIME_CONTEXT,
  MIA_SCHEDULED_FIRE_CONTEXT,
  appendMiaMemoryBlock,
  miaRuntimeSystemPrompt,
  sanitizeMiaMemorySpoof,
  withMiaRuntimeContext
};

const { spawnSync: defaultSpawnSync } = require("node:child_process");
const fs = require("node:fs");

function hermesSlashCommandScript() {
  return `
import asyncio, json, sys
from agent import i18n as _mia_i18n
from gateway.config import Platform
from gateway.platforms.base import MessageEvent, MessageType
from gateway.run import GatewayRunner
from gateway.session import SessionSource

payload = json.loads(sys.argv[1])

_MIA_ZH_I18N = {
    "gateway.help.header": "可用命令：",
    "gateway.help.skill_header": "技能命令（{count} 个）：",
    "gateway.help.more_use_commands": "还有 {count} 个技能命令，输入 /commands 查看更多。",
    "gateway.commands.header": "命令列表（共 {total} 条，第 {page}/{total_pages} 页）",
    "gateway.commands.skill_header": "技能命令：",
    "gateway.commands.default_desc": "无描述",
    "gateway.commands.none": "没有可用命令。",
    "gateway.commands.usage": "用法：/commands [页码]",
    "gateway.commands.nav_prev": "上一页：/commands {page}",
    "gateway.commands.nav_next": "下一页：/commands {page}",
    "gateway.commands.out_of_range": "第 {requested} 页不存在，已显示第 {page} 页。",
    "gateway.model.current_label": "当前模型：{model}（{provider}）",
    "gateway.model.current_tag": "（当前）",
    "gateway.model.more_models_suffix": " 等 {count} 个模型",
    "gateway.model.usage_switch_model": "切换模型：/model <模型名>",
    "gateway.model.usage_switch_provider": "切换提供商：/model --provider <提供商>",
    "gateway.model.usage_persist": "保存为默认：/model <模型名> --global",
    "gateway.model.provider_label": "提供商：{provider}",
    "gateway.model.context_label": "上下文：{tokens} tokens",
    "gateway.model.max_output_label": "最大输出：{tokens} tokens",
    "gateway.model.cost_label": "价格：{cost}",
    "gateway.model.capabilities_label": "能力：{capabilities}",
    "gateway.model.session_only_hint": "仅对当前会话生效。",
    "gateway.model.switched": "已切换到 {model}（{provider}）。",
    "gateway.model.saved_global": "已保存为默认模型。",
    "gateway.model.error_prefix": "模型切换失败：",
    "gateway.model.warning_prefix": "提示：",
    "gateway.status.header": "会话状态",
    "gateway.status.session_id": "会话 ID：{session_id}",
    "gateway.status.title": "标题：{title}",
    "gateway.status.created": "创建时间：{created}",
    "gateway.status.last_activity": "最近活动：{last_activity}",
    "gateway.status.tokens": "Token：{tokens}",
    "gateway.status.platforms": "平台：{platforms}",
    "gateway.status.agent_running": "Agent 正在运行。",
    "gateway.status.state_yes": "是",
    "gateway.status.state_no": "否",
    "gateway.stop.no_active": "没有正在运行的任务。",
    "gateway.stop.stopped": "已停止当前任务。",
    "gateway.stop.stopped_pending": "已停止正在启动的任务。",
    "gateway.retry.no_previous": "没有可重试的上一条消息。",
    "gateway.undo.nothing": "没有可撤销的消息。",
    "gateway.undo.removed": "已撤销上一轮对话。",
    "gateway.title.current_no_title": "当前会话还没有标题。",
    "gateway.title.current_with_title": "当前标题：{title}",
    "gateway.title.empty_after_clean": "标题不能为空。",
    "gateway.title.set_to": "标题已设置为：{title}",
    "gateway.profile.header": "当前配置",
    "gateway.profile.home": "Hermes Home：{home}",
    "gateway.usage.no_data": "当前会话还没有用量数据。",
    "gateway.usage.header_session": "当前会话用量",
    "gateway.usage.header_session_info": "会话信息",
    "gateway.usage.label_model": "模型",
    "gateway.usage.label_messages": "消息",
    "gateway.usage.label_input_tokens": "输入 tokens",
    "gateway.usage.label_output_tokens": "输出 tokens",
    "gateway.usage.label_total": "总计",
    "gateway.usage.label_cost": "费用",
    "gateway.usage.rate_limits": "速率限制",
}
with _mia_i18n._catalog_lock:
    _mia_i18n._catalog_cache.setdefault("zh", {}).update(_MIA_ZH_I18N)
    _mia_i18n._catalog_cache.setdefault("en", {}).update(_MIA_ZH_I18N)

async def main():
    runner = GatewayRunner()
    source = SessionSource(
        platform=Platform.WEBHOOK,
        chat_id=payload["sessionKey"],
        chat_name=payload.get("chatName") or "Mia",
        chat_type="dm",
        user_id="mia-user",
        user_name=payload.get("userName") or "Mia",
    )
    event = MessageEvent(
        text=payload["text"],
        message_type=MessageType.TEXT,
        source=source,
        internal=True,
    )
    result = await runner._handle_message(event)
    if isinstance(result, dict):
        content = result.get("final_response") or result.get("content") or json.dumps(result, ensure_ascii=False)
    elif result is None:
        content = ""
    else:
        content = str(result)
    print(json.dumps({"content": content}, ensure_ascii=False))

asyncio.run(main())
`;
}

function createHermesSlashCommandService(deps = {}) {
  const runtimePaths = deps.runtimePaths;
  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");

  const fsImpl = deps.fs || fs;
  const readJson = deps.readJson || ((filePath, fallback) => {
    try {
      return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
    } catch {
      return fallback;
    }
  });
  const defaultUserProfile = deps.defaultUserProfile || (() => ({ displayName: "Mia" }));
  const cleanRunSessionId = deps.cleanRunSessionId || ((sessionId, fellowKey) => sessionId || fellowKey || "default");
  const enginePython = deps.enginePython || (() => "python3");
  const effectiveHermesHome = deps.effectiveHermesHome || (() => runtimePaths().home);
  const buildPythonPath = deps.buildPythonPath || (() => "");
  const spawnSync = deps.spawnSync || defaultSpawnSync;
  const env = deps.env || process.env;

  function run({ text, fellow = {}, sessionId = "" }) {
    const p = runtimePaths();
    const sessionKey = cleanRunSessionId(sessionId, fellow.key);
    const payload = JSON.stringify({
      text,
      sessionKey,
      chatName: fellow.name || "Mia",
      userName: readJson(p.userProfile, defaultUserProfile()).displayName || "Mia"
    });
    const result = spawnSync(enginePython(), ["-c", hermesSlashCommandScript(), payload], {
      cwd: p.engine,
      env: {
        ...env,
        HERMES_HOME: effectiveHermesHome(),
        MIA_HOME: p.home,
        HERMES_LANGUAGE: env.HERMES_LANGUAGE || "zh",
        GATEWAY_ALLOW_ALL_USERS: "true",
        PYTHONPATH: buildPythonPath()
      },
      encoding: "utf8",
      timeout: 45000
    });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || result.stderr || `Hermes command exited ${result.status}`);
    }
    const lines = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1] || "{}");
    return String(parsed.content || "");
  }

  return { run, hermesSlashCommandScript };
}

module.exports = { createHermesSlashCommandService, hermesSlashCommandScript };

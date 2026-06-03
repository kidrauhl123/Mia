const MIA_SCHEDULER_SKILL_ID = "mia-scheduler";

function lastUserText(messages = []) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    return String(message.content ?? message.text ?? "").trim();
  }
  return "";
}

function dedupeSkillIds(ids = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(ids) ? ids : []) {
    const id = String(value || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isSchedulerIntent(text = "") {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/(提醒我|提醒一下|叫我|通知我|定时|定个?任务|倒计时|闹钟|remind me|reminder|schedule|timer|cron)/i.test(value)) {
    return true;
  }
  return /(\d+\s*(秒|分钟|小时|天|周|个月)后|今天|明天|后天|每天|每周|每月|早上|上午|中午|下午|晚上|凌晨|\d+\s*点)/.test(value)
    && /(提醒|通知|叫|任务)/.test(value);
}

function schedulerSkillIdsForTurn({ messages = [], activeSkillIds = [], utility = false, group = false, background = false } = {}) {
  const ids = dedupeSkillIds(activeSkillIds);
  const canAutoActivate = !background && (!utility || Boolean(group));
  if (canAutoActivate && isSchedulerIntent(lastUserText(messages)) && !ids.includes(MIA_SCHEDULER_SKILL_ID)) {
    ids.push(MIA_SCHEDULER_SKILL_ID);
  }
  return ids;
}

module.exports = {
  MIA_SCHEDULER_SKILL_ID,
  isSchedulerIntent,
  schedulerSkillIdsForTurn
};

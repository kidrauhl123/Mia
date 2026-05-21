(function (global) {
  function parseMentions(content, fellows) {
    const result = [];
    const seen = new Set();
    const nameToId = new Map(fellows.map((f) => [f.name.toLowerCase(), f.id]));
    // \\@ 转义跳过；其他 @name 匹配（name = 字母数字下划线+中日韩字符）
    const regex = /(\\@|@([A-Za-z0-9_一-龥぀-ヿ]+))/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1] === "\\@") continue;
      const name = match[2].toLowerCase();
      const id = nameToId.get(name);
      if (id && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  function filterRecentTurnsForFellow(messages, fellowId, k) {
    const turnsTouchingFellow = [];
    const seenTurns = new Set();
    for (const msg of messages) {
      if (seenTurns.has(msg.turnId)) continue;
      const touches =
        (msg.mentions && msg.mentions.includes(fellowId)) ||
        msg.senderFellowId === fellowId;
      if (touches) {
        turnsTouchingFellow.push(msg.turnId);
        seenTurns.add(msg.turnId);
      }
    }
    const lastK = new Set(turnsTouchingFellow.slice(-k));
    return messages.filter((m) => lastK.has(m.turnId));
  }

  function formatMessagesForPrompt(messages, fellowNamesById) {
    return messages.map((m) => {
      if (m.role === "user") return "用户: " + m.content;
      const name = fellowNamesById[m.senderFellowId] || m.senderFellowId || "Fellow";
      return name + ": " + m.content;
    }).join("\n");
  }

  function formatMembersForPrompt(members) {
    return members.map((m) => `- ${m.name} (id=${m.id})`).join("\n");
  }

  function fillTemplate(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : "";
    });
  }

  function buildDispatchPrompt(template, ctx) {
    return fillTemplate(template, {
      members: formatMembersForPrompt(ctx.members),
      summary: ctx.summary || "（暂无摘要）",
      recent: formatMessagesForPrompt(ctx.recentMessages, ctx.fellowNamesById),
      userMessage: ctx.userMessage,
    });
  }

  function buildSummarizePrompt(template, ctx) {
    return fillTemplate(template, {
      oldSummary: ctx.oldSummary || "（首次摘要）",
      newMessages: formatMessagesForPrompt(ctx.newMessages, ctx.fellowNamesById),
    });
  }

  function buildFellowGroupContext(ctx) {
    const recent = formatMessagesForPrompt(ctx.recentForFellow, ctx.fellowNamesById);
    return [
      "[群上下文]",
      "群名：" + ctx.groupName,
      "群摘要：" + (ctx.summary || "（暂无摘要）"),
      "最近相关消息：",
      recent || "（无）",
      "[/群上下文]",
    ].join("\n");
  }

  function userTurnsIn(messages) {
    const seen = new Set();
    for (const m of messages) {
      if (m.role === "user") seen.add(m.turnId);
    }
    return seen;
  }

  function userTurnsAfter(messages, msgId) {
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return userTurnsIn(messages);
    return userTurnsIn(messages.slice(idx + 1));
  }

  function shouldSummarize(group, messages) {
    const card = group && group.contextCard;
    const turns = card
      ? userTurnsAfter(messages, card.summaryUpToMsgId)
      : userTurnsIn(messages);
    return turns.size >= 4;
  }

  const __exports = {
    parseMentions,
    filterRecentTurnsForFellow,
    buildDispatchPrompt,
    buildSummarizePrompt,
    buildFellowGroupContext,
    shouldSummarize,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = __exports;
  }
  if (typeof global !== "undefined") {
    global.aimashiGroupPrompts = __exports;
  }
})(typeof window !== "undefined" ? window : globalThis);

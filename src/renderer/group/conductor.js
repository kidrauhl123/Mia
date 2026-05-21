(function (global) {
  const promptsModule = (typeof global !== "undefined" && global.aimashiGroupPrompts)
    ? global.aimashiGroupPrompts
    : (typeof require !== "undefined" ? require("./group-prompts.js") : {});
  const { buildDispatchPrompt, buildSummarizePrompt } = promptsModule;

  function safeParseJSON(text) {
    if (!text || typeof text !== "string") return null;
    try {
      const match = text.match(/\{[^}]*"speak"[^}]*\}/);
      if (!match) return null;
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  function createConductor({ engineCall, dispatchTemplate, summarizeTemplate, relayTemplate }) {
    async function decideDispatch(ctx) {
      if (ctx.userMessage.mentions && ctx.userMessage.mentions.length > 0) {
        const valid = ctx.userMessage.mentions.filter((id) =>
          ctx.group.members.some((m) => m.fellowId === id)
        );
        return { speak: valid };
      }
      const prompt = buildDispatchPrompt(dispatchTemplate, {
        members: ctx.members,
        summary: ctx.group.contextCard ? ctx.group.contextCard.summary : null,
        recentMessages: (ctx.messages || []).slice(-6),
        fellowNamesById: ctx.fellowNamesById,
        userMessage: ctx.userMessage.content,
      });
      let raw;
      try {
        raw = await engineCall({ kind: "dispatch", prompt, group: ctx.group });
      } catch {
        return { speak: [], degraded: true };
      }
      const parsed = safeParseJSON(raw);
      if (!parsed || !Array.isArray(parsed.speak)) {
        return { speak: [], degraded: true };
      }
      const valid = parsed.speak.filter((id) => ctx.group.members.some((m) => m.fellowId === id));
      return { speak: valid };
    }

    async function summarize(ctx) {
      const oldCard = ctx.group.contextCard;
      const oldSummary = oldCard ? oldCard.summary : null;
      const cutoff = oldCard ? oldCard.summaryUpToMsgId : null;
      const newMessages = cutoff
        ? ctx.messages.slice(ctx.messages.findIndex((m) => m.id === cutoff) + 1)
        : ctx.messages;
      if (newMessages.length === 0) return null;

      const prompt = buildSummarizePrompt(summarizeTemplate, {
        oldSummary,
        newMessages,
        fellowNamesById: ctx.fellowNamesById,
      });

      let raw;
      try {
        raw = await engineCall({ kind: "summarize", prompt, group: ctx.group });
      } catch {
        return null;
      }
      if (!raw || typeof raw !== "string") return null;
      const lastMsg = ctx.messages[ctx.messages.length - 1];
      return {
        summary: raw.trim(),
        summaryUpToMsgId: lastMsg.id,
        updatedAt: Date.now(),
      };
    }

    async function decideRelay(ctx) {
      if (!relayTemplate) return { speak: [] };
      const prompt = buildDispatchPrompt(relayTemplate, {
        members: ctx.members,
        summary: ctx.group.contextCard ? ctx.group.contextCard.summary : null,
        recentMessages: (ctx.messages || []).slice(-8),
        fellowNamesById: ctx.fellowNamesById,
        userMessage: "",
      });
      let raw;
      try {
        raw = await engineCall({ kind: "relay", prompt, group: ctx.group });
      } catch {
        return { speak: [], degraded: true };
      }
      const parsed = safeParseJSON(raw);
      if (!parsed || !Array.isArray(parsed.speak)) {
        return { speak: [], degraded: true };
      }
      const valid = parsed.speak.filter((id) => ctx.group.members.some((m) => m.fellowId === id));
      return { speak: valid };
    }

    return { decideDispatch, summarize, decideRelay };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createConductor };
  }
  if (typeof global !== "undefined") {
    global.aimashiConductor = { createConductor };
  }
})(typeof window !== "undefined" ? window : globalThis);

const {
  DEFAULT_BOT_ID,
  botConversationId,
  defaultCloudBotCapabilities
} = require("../shared/bot-identity.js");

const DEFAULT_CLOUD_BOT_ID = DEFAULT_BOT_ID;

function defaultCloudBotConversationId(ownerUserId, botId) {
  return botConversationId(`${ownerUserId}_${botId}`);
}

function sameJson(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function ensureDefaultCloudBot(context, ownerUserId, botId = DEFAULT_CLOUD_BOT_ID) {
  const userId = String(ownerUserId || "").trim();
  if (!userId) throw new Error("ensureDefaultCloudBot: ownerUserId required");
  const id = String(botId || DEFAULT_CLOUD_BOT_ID).trim();
  if (!id) throw new Error("ensureDefaultCloudBot: botId required");

  let bot = context.botsStore.getBot(id);
  if (!bot) {
    bot = context.botsStore.upsertBot(userId, {
      id,
      displayName: "Mia",
      bio: "Mia Bot",
      capabilities: defaultCloudBotCapabilities(),
      personaText: "You are Mia."
    });
  }

  const binding = context.runtimeBindingsStore.upsertBinding({
    userId,
    botId: id,
    runtimeKind: "cloud-hermes",
    enabled: true,
    config: {}
  });

  const conversationId = defaultCloudBotConversationId(userId, id);
  let conversation = context.socialStore.getConversation(conversationId);
  if (!conversation) {
    conversation = context.socialStore.createConversation({
      id: conversationId,
      type: "bot",
      name: bot.displayName || bot.name || "Mia",
      decorations: { botId: id, runtimeKind: "cloud-hermes" }
    });
  } else {
    const decorations = {
      ...(conversation.decorations || {}),
      botId: conversation.decorations?.botId || id,
      runtimeKind: conversation.decorations?.runtimeKind || "cloud-hermes"
    };
    const patch = {};
    if (!conversation.name && (bot.displayName || bot.name)) patch.name = bot.displayName || bot.name;
    if (!sameJson(conversation.decorations, decorations)) patch.decorations = decorations;
    if (Object.keys(patch).length) {
      conversation = context.socialStore.updateConversation(conversationId, patch);
    }
  }

  context.socialStore.addConversationMember({ conversationId, memberKind: "user", memberRef: userId });
  context.socialStore.addConversationMember({ conversationId, memberKind: "bot", memberRef: id, ownerId: userId });

  return {
    bot,
    binding,
    conversation: context.socialStore.getConversation(conversationId),
    members: context.socialStore.listConversationMembers(conversationId)
  };
}

module.exports = {
  DEFAULT_CLOUD_BOT_ID,
  ensureDefaultCloudBot
};

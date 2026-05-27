const DEFAULT_CLOUD_FELLOW_ID = "mia";

function defaultPersonaText() {
  return [
    "你是 Mia，一个运行在 Mia Cloud 的 Fellow。",
    "你和运行在用户设备上的 Fellow 使用同一套对话语义；区别只是运行位置。",
    "你可以帮助用户整理想法、处理文件、写代码、推进任务，并保持简洁直接。"
  ].join("\n");
}

function ensureDefaultCloudFellow(context, userId, options = {}) {
  const ownerUserId = String(userId || "").trim();
  if (!ownerUserId) throw new Error("ensureDefaultCloudFellow: userId required");
  const fellowId = String(options.fellowId || DEFAULT_CLOUD_FELLOW_ID).trim();
  const conversationId = `fellow:${ownerUserId}:${fellowId}`;

  let fellow = context.fellowsStore.getFellow(ownerUserId, fellowId);
  if (!fellow) {
    fellow = context.fellowsStore.upsertFellow(ownerUserId, {
      id: fellowId,
      name: options.name || "Mia",
      color: options.color || "#2563eb",
      avatarImage: options.avatarImage || "",
      avatarCrop: null,
      bio: options.bio || "Mia Fellow",
      capabilities: options.capabilities || ["chat", "files", "terminal", "code"],
      personaText: options.personaText || defaultPersonaText()
    });
  }

  const binding = context.runtimeBindingsStore.upsertBinding({
    userId: ownerUserId,
    fellowId,
    runtimeKind: "cloud-hermes",
    enabled: true,
    config: {
      workerScope: "user",
      sessionPrefix: "cloud"
    }
  });

  let conversation = context.socialStore.getConversation(conversationId);
  if (!conversation) {
    conversation = context.socialStore.createConversation({
      id: conversationId,
      type: "fellow",
      name: fellow.name,
      decorations: { fellowKey: fellowId, sessionId: fellowId, runtimeKind: "cloud-hermes" }
    });
  } else {
    const sameJson = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    const decorations = {
      ...(conversation.decorations || {}),
      fellowKey: conversation.decorations?.fellowKey || fellowId,
      sessionId: conversation.decorations?.sessionId || fellowId,
      runtimeKind: conversation.decorations?.runtimeKind || "cloud-hermes"
    };
    const patch = {};
    if (!conversation.name && fellow.name) patch.name = fellow.name;
    if (!sameJson(conversation.decorations, decorations)) patch.decorations = decorations;
    if (Object.keys(patch).length) {
      conversation = context.socialStore.updateConversation(conversationId, patch);
    }
  }

  context.socialStore.addConversationMember({ conversationId, memberKind: "user", memberRef: ownerUserId });
  context.socialStore.addConversationMember({ conversationId, memberKind: "fellow", memberRef: fellowId, ownerId: ownerUserId });

  return {
    fellow,
    binding,
    conversation: context.socialStore.getConversation(conversationId),
    members: context.socialStore.listConversationMembers(conversationId)
  };
}

module.exports = {
  DEFAULT_CLOUD_FELLOW_ID,
  ensureDefaultCloudFellow
};

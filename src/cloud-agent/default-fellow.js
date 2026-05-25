const DEFAULT_CLOUD_FELLOW_ID = "mia";

function defaultPersonaText() {
  return [
    "你是 Mia 的云端 Fellow。",
    "你和本地运行的 Fellow 使用同一套对话语义；区别只是你运行在云端。",
    "你可以帮助用户整理想法、处理文件、写代码、推进任务，并保持简洁直接。"
  ].join("\n");
}

function ensureDefaultCloudFellow(context, userId, options = {}) {
  const ownerUserId = String(userId || "").trim();
  if (!ownerUserId) throw new Error("ensureDefaultCloudFellow: userId required");
  const fellowId = String(options.fellowId || DEFAULT_CLOUD_FELLOW_ID).trim();
  const roomId = `fellow:${ownerUserId}:${fellowId}`;

  let fellow = context.fellowsStore.getFellow(ownerUserId, fellowId);
  if (!fellow) {
    fellow = context.fellowsStore.upsertFellow(ownerUserId, {
      id: fellowId,
      name: options.name || "Mia",
      color: options.color || "#2563eb",
      avatarImage: options.avatarImage || "",
      avatarCrop: null,
      bio: options.bio || "云端 Agent",
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

  let room = context.socialStore.getRoom(roomId);
  if (!room) {
    room = context.socialStore.createRoom({
      id: roomId,
      type: "fellow",
      name: fellow.name,
      decorations: { fellowKey: fellowId, sessionId: fellowId, runtimeKind: "cloud-hermes" }
    });
  } else {
    const decorations = {
      ...(room.decorations || {}),
      fellowKey: room.decorations?.fellowKey || fellowId,
      sessionId: room.decorations?.sessionId || fellowId,
      runtimeKind: room.decorations?.runtimeKind || "cloud-hermes"
    };
    room = context.socialStore.updateRoom(roomId, {
      name: room.name || fellow.name,
      decorations
    });
  }

  context.socialStore.addRoomMember({ roomId, memberKind: "user", memberRef: ownerUserId });
  context.socialStore.addRoomMember({ roomId, memberKind: "fellow", memberRef: fellowId, ownerId: ownerUserId });

  return {
    fellow,
    binding,
    room: context.socialStore.getRoom(roomId),
    members: context.socialStore.listRoomMembers(roomId)
  };
}

module.exports = {
  DEFAULT_CLOUD_FELLOW_ID,
  ensureDefaultCloudFellow
};

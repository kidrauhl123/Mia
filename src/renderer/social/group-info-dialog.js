// Typed React adapter for cloud-group settings.
// This module owns data loading and mutations; React owns the dialog DOM.
(function (global) {
  "use strict";

  const { MemberKind } = (typeof window !== "undefined" && window.miaConversationKinds)
    || require("../../shared/conversation-kinds");

  let context = null;
  let activeConversationId = null;
  let pendingAvatarConversationId = null;

  function attach(internalContext) {
    context = internalContext;
  }

  function statusBadgeFrom(...sources) {
    for (const source of sources) {
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "statusBadge")) {
        return source.statusBadge;
      }
      if (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "status_badge")) {
        return source.status_badge;
      }
    }
    return null;
  }

  function firstDisplayName(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (!text || /^wx_[a-f0-9]{8,16}$/i.test(text)) continue;
      return text;
    }
    return "";
  }

  function conversationPublicId(conversation = {}) {
    const explicit = String(conversation.publicId || conversation.public_id || "").trim();
    if (explicit) return explicit;
    const id = String(conversation.id || "").trim();
    return id.startsWith("g_") ? id.slice(2) : id;
  }

  function adapterContext() {
    return context?.adapterCtx?.() || { bots: [], friends: [], self: {} };
  }

  function conversationById(conversationId) {
    return context?.moduleState?.conversations?.find?.((conversation) => conversation.id === conversationId) || null;
  }

  function replaceConversation(conversationId, incoming) {
    if (!incoming || !context?.moduleState?.conversations) return;
    context.moduleState.conversations = context.moduleState.conversations.map((conversation) => (
      conversation.id === conversationId ? { ...conversation, ...incoming } : conversation
    ));
  }

  function botForRef(bots, memberRef) {
    return (bots || []).find((bot) => (bot.id || bot.key) === memberRef) || null;
  }

  function friendForRef(friends, memberRef) {
    return (friends || []).find((friend) => friend.id === memberRef) || null;
  }

  function botName(member, bot) {
    return firstDisplayName(bot?.name, member.bot_name, member.identity?.displayName, member.member_ref)
      || "Agent";
  }

  function userName(member, friend, self) {
    if (member.member_ref === self?.id) {
      return firstDisplayName(
        self?.displayName,
        member.identity?.displayName,
        member.user?.displayName,
        self?.username,
        self?.account
      ) || "我";
    }
    return firstDisplayName(
      friend?.displayName,
      member.identity?.displayName,
      member.user?.displayName,
      friend?.username,
      friend?.account,
      member.member_ref
    ) || "用户";
  }

  function botAvatar(member, bot) {
    return global.miaAvatarResolve.resolveAvatarForContact({
      id: global.miaContact?.botAvatarIdentityId?.(member.member_ref, {
        ...(bot || {}),
        id: bot?.id || bot?.key || member.identity?.id || member.member_ref
      }) || member.member_ref,
      displayName: bot?.name || member.identity?.displayName || member.bot_name || member.member_ref,
      avatarImage: bot?.avatarImage || member.identity?.avatar?.image || member.bot_avatar_image || "",
      avatarCrop: bot?.avatarCrop || member.identity?.avatar?.crop || member.bot_avatar_crop || null,
      color: bot?.color || bot?.avatarColor || bot?.avatar_color || member.identity?.avatar?.color || member.bot_color || ""
    });
  }

  function userAvatar(member, friend, self) {
    return global.miaContact.resolveContact(
      { kind: global.miaContact.IdentityKind?.User || "user", ref: member.member_ref },
      { self, friends: friend ? [friend] : [] }
    ).avatar;
  }

  async function reload(conversationId) {
    const response = await global.mia.social.getConversation(conversationId);
    if (!response?.ok) return response?.error || "群设置加载失败";
    const data = response.data || {};
    if (data.conversation) replaceConversation(conversationId, data.conversation);
    if (Array.isArray(data.members)) context.conversationMembersCache.set(conversationId, data.members);
    if (activeConversationId === conversationId) publishDialog(conversationId);
    context?.deps?.render?.();
    return "";
  }

  async function patchDecorations(conversationId, patch) {
    const conversation = conversationById(conversationId);
    if (!conversation) return "群聊不存在";
    const decorations = { ...(conversation.decorations || {}), ...patch };
    const response = await global.mia.social.updateConversation(conversationId, { decorations });
    if (!response?.ok) return response?.error || "保存失败";
    replaceConversation(conversationId, response.data?.conversation || response.data);
    return reload(conversationId);
  }

  async function patchName(conversationId, requestedName) {
    const conversation = conversationById(conversationId);
    if (!conversation) return "群聊不存在";
    const name = String(requestedName || "").trim() || "未命名群聊";
    if (name === String(conversation.name || "")) return "";
    const response = await global.mia.social.updateConversation(conversationId, { name });
    if (!response?.ok) return "保存群名失败：" + (response?.error || "");
    replaceConversation(conversationId, response.data?.conversation || response.data);
    return reload(conversationId);
  }

  function memberView(conversation, member, members, bots, friends, self) {
    const isBot = member.member_kind === MemberKind.Bot;
    const bot = isBot ? botForRef(bots, member.member_ref) : null;
    const friend = !isBot ? friendForRef(friends, member.member_ref) : null;
    const name = isBot ? botName(member, bot) : userName(member, friend, self);
    const hostBotId = conversation.decorations?.hostMember?.botId || null;
    const host = isBot && member.member_ref === hostBotId;
    const key = `${member.member_kind}:${member.member_ref}`;
    return {
      avatar: isBot ? botAvatar(member, bot) : userAvatar(member, friend, self),
      badge: statusBadgeFrom(bot, friend, member.identity, member),
      canRemove: members.length > 1,
      canSetHost: isBot,
      host,
      key,
      name,
      removeLabel: !isBot && member.member_ref === self?.id ? "退出群聊" : "移出群聊",
      remove: async () => {
        if (!global.confirm(`确定移除「${name}」？`)) return "";
        const response = await global.mia.social.removeConversationMember(conversation.id, {
          memberKind: member.member_kind,
          memberRef: member.member_ref
        });
        if (!response?.ok) return "移除失败：" + (response?.error || "");
        return reload(conversation.id);
      },
      setHost: async () => patchDecorations(conversation.id, {
        hostMember: { kind: "bot", botId: member.member_ref }
      })
    };
  }

  function addableViews(conversation, members, bots, friends) {
    const existing = new Set(members.map((member) => `${member.member_kind}:${member.member_ref}`));
    const values = [];
    for (const friend of friends || []) {
      const key = `${MemberKind.User}:${friend.id}`;
      if (!friend.id || existing.has(key)) continue;
      const name = firstDisplayName(friend.displayName, friend.username, friend.account, friend.id) || "用户";
      values.push({
        avatar: global.miaContact.resolveContact(
          { kind: global.miaContact.IdentityKind?.User || "user", ref: friend.id },
          { self: {}, friends: [friend] }
        ).avatar,
        badge: statusBadgeFrom(friend),
        key,
        name,
        add: async () => {
          const response = await global.mia.social.addConversationMember(conversation.id, {
            memberKind: MemberKind.User,
            memberRef: friend.id
          });
          if (!response?.ok) return "添加失败：" + (response?.error || "");
          return reload(conversation.id);
        }
      });
    }
    for (const bot of bots || []) {
      const id = bot.id || bot.key;
      const key = `${MemberKind.Bot}:${id}`;
      if (!id || existing.has(key)) continue;
      const name = firstDisplayName(bot.name, id) || "Agent";
      values.push({
        avatar: global.miaAvatarResolve.resolveAvatarForContact({
          id: global.miaContact?.botAvatarIdentityId?.(id, bot) || id,
          displayName: name,
          avatarImage: bot.avatarImage || "",
          avatarCrop: bot.avatarCrop || null,
          color: bot.color || bot.avatarColor || bot.avatar_color || ""
        }),
        badge: statusBadgeFrom(bot),
        key,
        name,
        add: async () => {
          const response = await global.mia.social.addConversationMember(conversation.id, {
            memberKind: MemberKind.Bot,
            memberRef: id
          });
          if (!response?.ok) return "添加失败：" + (response?.error || "");
          return reload(conversation.id);
        }
      });
    }
    return values;
  }

  function closeDialog() {
    activeConversationId = null;
    pendingAvatarConversationId = null;
    global.miaReactDialogs?.publish?.({ dialog: { kind: "closed" } });
  }

  function publishDialog(conversationId) {
    const conversation = conversationById(conversationId);
    if (!conversation) return;
    const members = context?.conversationMembersCache?.get?.(conversationId) || [];
    const actx = adapterContext();
    const bots = actx.bots || [];
    const friends = actx.friends || context?.moduleState?.friends || [];
    const self = actx.self || {};
    const customAvatar = conversation.decorations?.avatar;
    const mosaic = global.miaGroupTiles.resolveGroupMemberTiles(members, actx);

    global.miaReactDialogs?.publish?.({
      dialog: {
        addable: addableViews(conversation, members, bots, friends),
        avatar: customAvatar?.image
          ? {
              color: "#5e5ce6",
              crop: customAvatar.crop || null,
              image: customAvatar.image,
              text: conversation.name || ""
            }
          : null,
        chooseAvatar: (dataUrl) => {
          if (!dataUrl) return;
          pendingAvatarConversationId = conversationId;
          global.miaBotDialog.openAvatarCropEditor(
            dataUrl,
            { x: 50, y: 50, zoom: 1.12 },
            "groupConversation"
          );
        },
        close: closeDialog,
        goal: conversation.decorations?.pinnedGoal || "",
        kind: "group-info",
        members: members.map((member) => memberView(conversation, member, members, bots, friends, self)),
        mosaic,
        name: conversation.name || "",
        publicId: conversationPublicId(conversation) || "未生成",
        resetAvatar: () => patchDecorations(conversationId, { avatar: null }),
        resetContext: async () => {
          if (!global.confirm("重置群上下文？已生成的摘要会清空，后续重新积累。")) return "";
          return patchDecorations(conversationId, { contextCard: null });
        },
        saveGoal: (goal) => {
          const next = String(goal || "").trim();
          if (next === String(conversation.decorations?.pinnedGoal || "")) return Promise.resolve("");
          return patchDecorations(conversationId, { pinnedGoal: next || null });
        },
        saveName: (name) => patchName(conversationId, name)
      }
    });
  }

  function openDialog(conversationOrId) {
    const conversationId = typeof conversationOrId === "string" ? conversationOrId : conversationOrId?.id;
    if (!conversationId) return;
    activeConversationId = conversationId;
    publishDialog(conversationId);
    reload(conversationId).catch(() => {
      if (activeConversationId === conversationId) publishDialog(conversationId);
    });
  }

  async function applyAvatarFromCropEditor(image, crop) {
    const conversationId = pendingAvatarConversationId || activeConversationId;
    pendingAvatarConversationId = null;
    if (!conversationId) return;
    await patchDecorations(conversationId, {
      avatar: {
        crop: global.miaAvatar.normalizeCrop(crop),
        image
      }
    });
  }

  global.miaGroupInfoDialog = {
    applyAvatarFromCropEditor,
    attach,
    open: openDialog
  };

  if (global.miaSocial && global.miaSocial._internalCtx) {
    attach(global.miaSocial._internalCtx);
  }
})(typeof window !== "undefined" ? window : globalThis);

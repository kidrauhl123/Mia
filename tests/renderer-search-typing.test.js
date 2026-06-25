const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} should exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${functionName}`);
}

function loadConversationCardSpecFromRow() {
  const appSource = fs.readFileSync(path.join(root, "src", "renderer", "app.js"), "utf8");
  return eval(`(
    function () {
      const state = { personaSearchFocus: { conversationId: "", messageId: "" } };
      const MemberKind = { Bot: "bot" };
      const runByConversation = new Map([
        ["botc_search", { status: "running", botId: "claude" }],
        ["g_search", { status: "running", botId: "claude" }]
      ]);
      const window = {
        miaSocial: {
          getActiveConversationId: () => "",
          isConversationPinned: () => false,
          isConversationMuted: () => false,
          getUnreadForConversation: () => 0,
          conversationRun: (conversationId) => runByConversation.get(conversationId) || null,
          getConversationMembers: () => [{ member_kind: "bot", member_ref: "claude", bot_name: "Claude" }],
          setActiveConversationId() {}
        },
        miaContact: {
          IdentityKind: { Bot: "bot" },
          resolveContact: () => ({ avatar: {} })
        },
        miaAvatarResolve: { resolveAvatarForContact: () => ({}) },
        miaConversationContextMenu: {
          openPrivateConversationMenu() {},
          openGroupConversationMenu() {}
        },
        miaGroupTiles: { resolveGroupMemberTiles: () => [] }
      };
      const sessionHistory = {
        botId: (conversation) => conversation.decorations?.botId || "claude",
        botDisplayTitle: (conversation) => conversation.name || "Claude"
      };
      function allOwnedBotsForIdentity() { return []; }
      function botAvatarIdentityId() { return "bot_global"; }
      function botMemberForConversation() { return null; }
      function botAvatarForConversation() { return {}; }
      function formatConversationTime() { return ""; }
      function groupTilesCtx() { return {}; }
      function showNarrowContent() {}
      function render() {}
      function openConversationSearchResult() { return true; }
      function conversationRunForSidebarPreview(social, conversation) {
        const run = social?.conversationRun?.(conversation?.id);
        return run?.status === "running" ? run : null;
      }
      function typingLabelForConversationRun(social, conversation, run = null) {
        const activeRun = run || conversationRunForSidebarPreview(social, conversation);
        const botId = activeRun?.botId || "";
        if (!botId || conversation?.type !== "group") return "";
        const member = (social?.getConversationMembers?.(conversation.id) || [])
          .find((m) => m.member_kind === MemberKind.Bot && m.member_ref === botId);
        return member?.bot_name || botId;
      }
      ${extractFunctionSource(appSource, "firstNonEmpty")}
      ${extractFunctionSource(appSource, "hasOwn")}
      ${extractFunctionSource(appSource, "statusBadgeFrom")}
      ${extractFunctionSource(appSource, "nameBadgeIdentity")}
      ${extractFunctionSource(appSource, "conversationCardSpecFromRow")}
      return conversationCardSpecFromRow;
    }
  )()`);
}

test("message search result cards suppress conversation typing state", () => {
  const conversationCardSpecFromRow = loadConversationCardSpecFromRow();

  const privateSpec = conversationCardSpecFromRow({
    type: "private-conversation",
    searchResult: true,
    searchMessageId: "m_private",
    updatedAt: "",
    conversation: {
      id: "botc_search",
      type: "bot",
      name: "Claude",
      lastMessagePreview: "命中的历史消息",
      decorations: { botId: "claude" }
    }
  }, []);
  const groupSpec = conversationCardSpecFromRow({
    type: "group-conversation",
    searchResult: true,
    searchMessageId: "m_group",
    updatedAt: "",
    conversation: {
      id: "g_search",
      type: "group",
      name: "群聊",
      lastMessagePreview: "另一条命中的历史消息"
    }
  }, []);

  assert.equal(privateSpec.typing, false);
  assert.equal(privateSpec.typingLabel, "");
  assert.equal(privateSpec.preview, "命中的历史消息");
  assert.equal(groupSpec.typing, false);
  assert.equal(groupSpec.typingLabel, "");
  assert.equal(groupSpec.preview, "另一条命中的历史消息");
});

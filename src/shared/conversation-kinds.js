(function attachConversationKinds(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaConversationKinds = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildConversationKinds() {
  const ConversationKind = Object.freeze({
    FellowPrivate: "fellow",
    LocalGroup: "local-group",
    CloudDM: "dm",
    CloudGroup: "group"
  });

  const MemberKind = Object.freeze({
    Fellow: "fellow",
    User: "user"
  });

  const SenderKind = Object.freeze({
    Fellow: "fellow",
    User: "user",
    System: "system"
  });

  function kindOf(conv) {
    if (!conv) return "";
    if (typeof conv === "string") return conv;
    return typeof conv.kind === "string" ? conv.kind : "";
  }

  function isGroup(conv) {
    const k = kindOf(conv);
    return k === ConversationKind.LocalGroup || k === ConversationKind.CloudGroup;
  }

  function isPrivate(conv) {
    const k = kindOf(conv);
    return k === ConversationKind.FellowPrivate || k === ConversationKind.CloudDM;
  }

  function isCloudBacked(conv) {
    const k = kindOf(conv);
    return k === ConversationKind.CloudDM || k === ConversationKind.CloudGroup;
  }

  return {
    ConversationKind,
    MemberKind,
    SenderKind,
    isGroup,
    isPrivate,
    isCloudBacked
  };
});

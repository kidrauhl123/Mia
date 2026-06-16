(function attachCloudEvents(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.miaCloudEvents = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildCloudEvents() {
  const CloudEvent = Object.freeze({
    SocialFriendRequestReceived: "social.friend_request_received",
    SocialFriendAdded: "social.friend_added",
    SocialConversationInvited: "social.conversation_invited",
    ConversationMessageAppended: "conversation.message_appended",
    ConversationBotInvocationRequested: "conversation.bot_invocation_requested",
    BotUpserted: "bot.upserted",
    BotDeleted: "bot.deleted",
    UserProfileUpdated: "user.profile_updated",
    TaskCreated: "task.created",
    TaskUpdated: "task.updated",
    TaskDeleted: "task.deleted",
    TaskStarted: "task.started",
    TaskFinished: "task.finished",
    TaskFailed: "task.failed",
    TaskMissed: "task.missed",
    TaskSkipped: "task.skipped",
    WorkspaceUpdated: "workspace_updated",
    MessageCreated: "message_created",
    BridgeRunUpdated: "bridge_run_updated",
    CloudAgentRunStarted: "cloud_agent_run_started",
    CloudAgentRunEvent: "cloud_agent_run_event",
    DeviceUpdated: "device_updated",
    EventsReady: "events_ready"
  });

  return { CloudEvent };
});

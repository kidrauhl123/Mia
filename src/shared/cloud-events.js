(function attachCloudEvents(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.aimashiCloudEvents = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : null), function buildCloudEvents() {
  const CloudEvent = Object.freeze({
    SocialFriendRequestReceived: "social.friend_request_received",
    SocialFriendAdded: "social.friend_added",
    SocialRoomInvited: "social.room_invited",
    RoomMessageAppended: "room.message_appended",
    RoomFellowInvocationRequested: "room.fellow_invocation_requested",
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

const CloudEvent = Object.freeze({
  SocialFriendRequestReceived: "social.friend_request_received",
  SocialFriendAdded: "social.friend_added",
  SocialRoomInvited: "social.room_invited",
  RoomMessageAppended: "room.message_appended",
  RoomFellowInvocationRequested: "room.fellow_invocation_requested",
  WorkspaceUpdated: "workspace_updated",
  MessageCreated: "message_created",
  BridgeRunUpdated: "bridge_run_updated",
  DeviceUpdated: "device_updated",
  EventsReady: "events_ready"
});

module.exports = { CloudEvent };
if (typeof window !== "undefined") window.aimashiCloudEvents = module.exports;

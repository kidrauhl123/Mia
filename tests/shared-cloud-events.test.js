const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CloudEvent } = require("../src/shared/cloud-events");

test("CloudEvent has all 10 known event types", () => {
  assert.equal(CloudEvent.SocialFriendRequestReceived, "social.friend_request_received");
  assert.equal(CloudEvent.SocialFriendAdded, "social.friend_added");
  assert.equal(CloudEvent.SocialRoomInvited, "social.room_invited");
  assert.equal(CloudEvent.RoomMessageAppended, "room.message_appended");
  assert.equal(CloudEvent.RoomFellowInvocationRequested, "room.fellow_invocation_requested");
  assert.equal(CloudEvent.WorkspaceUpdated, "workspace_updated");
  assert.equal(CloudEvent.MessageCreated, "message_created");
  assert.equal(CloudEvent.BridgeRunUpdated, "bridge_run_updated");
  assert.equal(CloudEvent.DeviceUpdated, "device_updated");
  assert.equal(CloudEvent.EventsReady, "events_ready");
});

test("CloudEvent is frozen", () => {
  const { CloudEvent } = require("../src/shared/cloud-events");
  assert.throws(() => { "use strict"; CloudEvent.NewType = "foo"; });
});

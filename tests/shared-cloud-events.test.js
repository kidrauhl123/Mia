const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CloudEvent } = require("../src/shared/cloud-events");

test("CloudEvent has known event types", () => {
  assert.equal(CloudEvent.SocialFriendRequestReceived, "social.friend_request_received");
  assert.equal(CloudEvent.SocialFriendAdded, "social.friend_added");
  assert.equal(CloudEvent.SocialConversationInvited, "social.conversation_invited");
  assert.equal(CloudEvent.ConversationMessageAppended, "conversation.message_appended");
  assert.equal(CloudEvent.ConversationBotInvocationRequested, "conversation.bot_invocation_requested");
  assert.equal(CloudEvent.BotUpserted, "bot.upserted");
  assert.equal(CloudEvent.BotDeleted, "bot.deleted");
  assert.equal(CloudEvent.UserProfileUpdated, "user.profile_updated");
  assert.equal(CloudEvent.TaskCreated, "task.created");
  assert.equal(CloudEvent.TaskFinished, "task.finished");
  assert.equal(CloudEvent.WorkspaceUpdated, "workspace_updated");
  assert.equal(CloudEvent.MessageCreated, "message_created");
  assert.equal(CloudEvent.BridgeRunUpdated, "bridge_run_updated");
  assert.equal(CloudEvent.CloudAgentRunStarted, "cloud_agent_run_started");
  assert.equal(CloudEvent.CloudAgentRunEvent, "cloud_agent_run_event");
  assert.equal(CloudEvent.MemoryUpdated, "memory.updated");
  assert.equal(CloudEvent.MemoryDeleted, "memory.deleted");
  assert.equal(CloudEvent.DeviceUpdated, "device_updated");
  assert.equal(CloudEvent.EventsReady, "events_ready");
});

test("CloudEvent is frozen", () => {
  const { CloudEvent } = require("../src/shared/cloud-events");
  assert.throws(() => { "use strict"; CloudEvent.NewType = "foo"; });
});

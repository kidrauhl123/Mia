"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { resolveSelfIdentity } = require("../packages/shared/self-identity.js");

// The rail account button, the chat-bubble self avatar, and the contact card
// all resolve "me" through this one function. These tests pin the precedence so
// they can never drift back into showing two different avatars for one user.

test("cloud account identity beats a stale global local profile name", () => {
  // The local profile is a single global file shared by every account, so a
  // name like "Boss" set on one account must not shadow the next account's
  // identity. Real bug: account "755439" (cloud username, no display_name)
  // showed the previous account's local "Boss" because local was preferred.
  const self = resolveSelfIdentity({
    cloudUser: { id: "u_me", username: "755439" },
    localUser: { displayName: "Boss" },
    myUserId: "u_me",
    myUsername: "755439"
  });
  assert.equal(self.displayName, "755439");
  assert.notEqual(self.displayName, "Boss");
});

test("cloud display_name (snake_case) wins over the @handle", () => {
  const self = resolveSelfIdentity({
    cloudUser: { id: "u_me", display_name: "12", username: "Bo" },
    localUser: {},
    myUserId: "u_me",
    myUsername: "Bo"
  });
  assert.equal(self.displayName, "12");
  assert.equal(self.username, "Bo");
});

test("local profile name is used only when there is no cloud account", () => {
  const self = resolveSelfIdentity({
    cloudUser: {},
    localUser: { displayName: "Boss" }
  });
  assert.equal(self.displayName, "Boss");
});

test("avatar text is the initials of the resolved name, never a stale cached value", () => {
  const self = resolveSelfIdentity({
    cloudUser: { id: "u_me", username: "755439" },
    localUser: { displayName: "Boss", avatarText: "B" }
  });
  assert.equal(self.avatarText, "75");
});

test("self avatar uses the cloud profile when signed in so stale local avatars cannot shadow other devices", () => {
  const both = resolveSelfIdentity({
    cloudUser: { id: "u_me", avatarImage: "data:cloud" },
    localUser: { avatarImage: "data:local" }
  });
  assert.equal(both.avatarImage, "data:cloud");

  const cloudOnly = resolveSelfIdentity({
    cloudUser: { id: "u_me", avatarImage: "data:cloud" },
    localUser: {}
  });
  assert.equal(cloudOnly.avatarImage, "data:cloud");

  const signedOut = resolveSelfIdentity({
    cloudUser: {},
    localUser: { avatarImage: "data:local" }
  });
  assert.equal(signedOut.avatarImage, "data:local");
});

test("id stays the server user id so message ownership matching holds", () => {
  const self = resolveSelfIdentity({
    cloudUser: { id: "u_cloud" },
    localUser: { id: "u_local" },
    myUserId: "u_me"
  });
  assert.equal(self.id, "u_cloud");

  const noCloudId = resolveSelfIdentity({ cloudUser: {}, localUser: {}, myUserId: "u_me" });
  assert.equal(noCloudId.id, "u_me");
});

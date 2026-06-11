import {
  groupCreatePayload,
  groupMemberKey,
  groupNameFromMembers,
  MAX_GROUP_MEMBERS,
  toggleGroupMemberKey,
} from "../src/logic/groupCreate";

test("groupMemberKey keeps friend and bot ids distinct", () => {
  expect(groupMemberKey({ kind: "friend", id: "mia" })).toBe("friend:mia");
  expect(groupMemberKey({ kind: "bot", id: "mia" })).toBe("bot:mia");
});

test("toggleGroupMemberKey toggles selection and respects max size", () => {
  const keys = Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) => `friend:u${i}`);
  expect(toggleGroupMemberKey(keys, { kind: "friend", id: "u1" })).not.toContain("friend:u1");
  expect(toggleGroupMemberKey(keys, { kind: "friend", id: "u9" })).toEqual(keys);
  expect(toggleGroupMemberKey(["friend:u1"], { kind: "bot", id: "mia" })).toEqual(["friend:u1", "bot:mia"]);
});

test("groupNameFromMembers uses explicit name or joins selected names", () => {
  expect(groupNameFromMembers("  计划组  ", [])).toBe("计划组");
  expect(groupNameFromMembers("", [
    { kind: "friend", id: "u1", name: "Alice" },
    { kind: "bot", id: "mia", name: "Mia" },
  ])).toBe("Alice · Mia");
});

test("groupCreatePayload splits friends and bots for the cloud API", () => {
  expect(groupCreatePayload("", [
    { kind: "friend", id: "u1", name: "Alice" },
    { kind: "bot", id: "mia", name: "Mia", runtimeKind: "cloud-hermes" },
    { kind: "bot", id: "codex", name: "Codex", runtimeKind: "desktop-local" },
  ])).toEqual({
    name: "Alice · Mia · Codex",
    memberFriendUserIds: ["u1"],
    memberBots: [
      { botId: "mia", runtimeKind: "cloud-hermes" },
      { botId: "codex", runtimeKind: "desktop-local" },
    ],
  });
});

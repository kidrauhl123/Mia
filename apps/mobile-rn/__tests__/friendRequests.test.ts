import { friendName, friendRequestPeerName } from "../src/logic/friendRequests";

test("friendName prefers display name then UID", () => {
  expect(friendName({ displayName: "Alice", username: "alice", account: "a@example.com", id: "u1" })).toBe("Alice");
  expect(friendName({ id: "u1" })).toBe("u1");
  expect(friendName(null, "未知")).toBe("未知");
});

test("friendRequestPeerName reads hydrated other side first", () => {
  expect(friendRequestPeerName({ id: "r1", from_user: "u1", other: { displayName: "Alice", id: "u1" } }, "incoming")).toBe("Alice");
  expect(friendRequestPeerName({ id: "r2", to_user: "u2", other: { id: "u2" } }, "outgoing")).toBe("u2");
});

test("friendRequestPeerName falls back by direction", () => {
  expect(friendRequestPeerName({ id: "r1", from_user: "u_from" }, "incoming")).toBe("u_from");
  expect(friendRequestPeerName({ id: "r2", to_user: "u_to" }, "outgoing")).toBe("u_to");
});

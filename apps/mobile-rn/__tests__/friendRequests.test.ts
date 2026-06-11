import { friendName, friendRequestPeerName } from "../src/logic/friendRequests";

test("friendName prefers username then account then id", () => {
  expect(friendName({ username: "alice", account: "a@example.com", id: "u1" })).toBe("alice");
  expect(friendName({ account: "a@example.com", id: "u1" })).toBe("a@example.com");
  expect(friendName({ id: "u1" })).toBe("u1");
  expect(friendName(null, "未知")).toBe("未知");
});

test("friendRequestPeerName reads hydrated other side first", () => {
  expect(friendRequestPeerName({ id: "r1", from_user: "u1", other: { username: "alice" } }, "incoming")).toBe("alice");
  expect(friendRequestPeerName({ id: "r2", to_user: "u2", other: { account: "bob@example.com" } }, "outgoing")).toBe("bob@example.com");
});

test("friendRequestPeerName falls back by direction", () => {
  expect(friendRequestPeerName({ id: "r1", from_user: "u_from" }, "incoming")).toBe("u_from");
  expect(friendRequestPeerName({ id: "r2", to_user: "u_to" }, "outgoing")).toBe("u_to");
});

import { resolveMeProfile } from "../src/logic/meProfile";

test("我的页优先展示昵称、徽章和公开 UID", () => {
  const badge = { kind: "emoji" as const, emoji: "🐑", label: "羊" };
  const profile = resolveMeProfile(
    {
      id: "100001",
      username: "wx_8067aabb7153",
      displayName: "我耳塞呢",
      statusBadge: badge,
    },
    { id: "session-id", username: "session_hash" }
  );

  expect(profile.displayName).toBe("我耳塞呢");
  expect(profile.uid).toBe("100001");
  expect(profile.username).toBe("wx_8067aabb7153");
  expect(profile.statusBadge).toBe(badge);
});

test("我的页兼容服务端 snake_case 身份字段", () => {
  const badge = { kind: "lottie" as const, assetId: "surprised-cat", label: "惊讶猫" };
  const profile = resolveMeProfile(
    {
      user_id: "100002",
      username: "wx_hash",
      display_name: "空铃",
      avatar_image: "https://example.test/a.png",
      avatar_crop: { x: 1 },
      status_badge: badge,
    },
    null
  );

  expect(profile.displayName).toBe("空铃");
  expect(profile.uid).toBe("100002");
  expect(profile.avatarImage).toBe("https://example.test/a.png");
  expect(profile.avatarCrop).toEqual({ x: 1 });
  expect(profile.statusBadge).toBe(badge);
});

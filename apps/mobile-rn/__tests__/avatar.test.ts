import {
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_CROP,
  identityDisplayText,
  isEmojiAvatar,
  emojiAvatarGlyph,
  emojiAvatarToken,
  memberAccentColor,
  normalizeAvatarDescriptor,
  normalizeAvatarImage,
  resolveAvatarForContact,
} from "../src/logic/avatar";

test("移动端头像 fallback 使用同一套两字文本和身份色", () => {
  const avatar = resolveAvatarForContact({ id: "user_123456", displayName: "123456" });
  expect(avatar).toEqual({
    image: "",
    crop: null,
    color: memberAccentColor("user_123456"),
    text: "12",
  });
});

test("移动端无 id 时使用共享默认色,不是局部随机色", () => {
  const avatar = resolveAvatarForContact({ displayName: "空铃" });
  expect(avatar.color).toBe(DEFAULT_AVATAR_COLOR);
  expect(avatar.text).toBe("空铃");
});

test("移动端过滤旧内置预设头像路径", () => {
  expect(normalizeAvatarImage("./assets/avatars/12.png")).toBe("");
  expect(normalizeAvatarImage("app:///assets/avatar-thumbs-pet/09.png")).toBe("");
  const avatar = resolveAvatarForContact({
    id: "fellow_legacy",
    displayName: "空铃",
    avatarImage: "./assets/avatars/12.png",
    avatarCrop: { x: 10 },
  });
  expect(avatar.image).toBe("");
  expect(avatar.crop).toBeNull();
  expect(avatar.text).toBe("空铃");
});

test("移动端真实头像保留默认裁剪", () => {
  const avatar = resolveAvatarForContact({
    id: "user_real",
    displayName: "Mia",
    avatarImage: "https://cdn.example.com/a.png",
  });
  expect(avatar.image).toBe("https://cdn.example.com/a.png");
  expect(avatar.crop).toEqual(DEFAULT_AVATAR_CROP);
});

test("移动端保留官方 emoji 头像来源且不裁剪", () => {
  const avatar = resolveAvatarForContact({
    id: "course-tutor",
    displayName: "课程助教",
    avatarImage: "emoji:books",
    avatarCrop: { x: 10, y: 20, zoom: 2 },
  });
  expect(isEmojiAvatar(avatar.image)).toBe(true);
  expect(emojiAvatarToken(avatar.image)).toBe("books");
  expect(emojiAvatarGlyph(avatar.image)).toBe("📚");
  expect(avatar.crop).toBeNull();
});

test("Avatar 组件输入 descriptor 时也会清理旧预设 image", () => {
  const avatar = normalizeAvatarDescriptor("123456", {
    image: "/assets/avatar-icons/01.png",
    color: "#123456",
  });
  expect(avatar.image).toBe("");
  expect(avatar.crop).toBeNull();
  expect(avatar.color).toBe("#123456");
  expect(avatar.text).toBe("12");
});

test("identityDisplayText 支持中英文和空值", () => {
  expect(identityDisplayText("空铃", "x")).toBe("空铃");
  expect(identityDisplayText("Mia", "x")).toBe("Mi");
  expect(identityDisplayText("", "123456")).toBe("12");
});

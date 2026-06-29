import { createTelegramTypography, localTypographyFontSizeFromStoredValue, normalizeTelegramFontSize } from "../src/theme";

test("telegram typography defaults to regular 16px chat text", () => {
  const typography = createTelegramTypography();
  expect(typography.fontSize).toBe(16);
  expect(typography.type.chatMessage.fontSize).toBe(16);
  expect(typography.type.listTitle.fontSize).toBe(16);
  expect(typography.type.listSubtitle.fontSize).toBe(15);
  expect(typography.type.search.fontSize).toBe(18);
  expect(typography.type.messageName.fontSize).toBe(14);
  expect(typography.type.messageMeta.fontSize).toBe(12);
  expect(typography.type.system.fontSize).toBe(14);
  expect(typography.type.body.fontWeight).toBe("400");
  expect(typography.type.bodyStrong.fontWeight).toBe("400");
});

test("telegram font size setting only scales chat text tokens", () => {
  const typography = createTelegramTypography(18);
  expect(typography.fontSize).toBe(18);
  expect(typography.type.chatMessage.fontSize).toBe(18);
  expect(typography.type.messageName.fontSize).toBe(15);
  expect(typography.type.system.fontSize).toBe(16);
  expect(typography.type.title.fontSize).toBe(20);
  expect(typography.type.listTitle.fontSize).toBe(16);
  expect(typography.type.search.fontSize).toBe(18);
});

test("telegram font size setting snaps to compact standard and large", () => {
  expect(normalizeTelegramFontSize(undefined)).toBe(16);
  expect(normalizeTelegramFontSize(13)).toBe(14);
  expect(normalizeTelegramFontSize(17)).toBe(16);
  expect(normalizeTelegramFontSize(19)).toBe(18);
});

test("local typography preference reads only device-local stored values", () => {
  expect(localTypographyFontSizeFromStoredValue("18")).toBe(18);
  expect(localTypographyFontSizeFromStoredValue(JSON.stringify({ fontSize: 14 }))).toBe(14);
  expect(localTypographyFontSizeFromStoredValue(JSON.stringify({ appearance: { mobileFontSize: 18 } }))).toBe(16);
});

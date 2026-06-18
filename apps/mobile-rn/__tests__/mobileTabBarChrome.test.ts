import { mobileTabBarChrome } from "../src/logic/mobileTabBarChrome";

function rgbaAlpha(value: string): number {
  const match = value.match(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)$/);
  return match ? Number(match[1]) : 1;
}

test("底部导航使用浮动卡片 chrome", () => {
  expect(mobileTabBarChrome.floating).toBe(true);
  expect(mobileTabBarChrome.reservesLayoutSpace).toBe(false);
  expect(mobileTabBarChrome.overlay.position).toBe("absolute");
  expect(mobileTabBarChrome.reservedLayoutStyle.height).toBe(0);
  expect(mobileTabBarChrome.reservedLayoutStyle.position).toBe("absolute");
  expect(mobileTabBarChrome.cardRadius).toBeGreaterThanOrEqual(22);
  expect(mobileTabBarChrome.horizontalMargin).toBeGreaterThanOrEqual(12);
  expect(mobileTabBarChrome.cardBackgroundColor).toMatch(/^rgba\(/);
  expect(mobileTabBarChrome.shadowOpacity).toBeGreaterThan(0);
  expect(mobileTabBarChrome.elevation).toBeGreaterThan(0);
});

test("底部导航玻璃质感不能像直接透明", () => {
  expect(rgbaAlpha(mobileTabBarChrome.cardBackgroundColor)).toBeGreaterThanOrEqual(0.9);
  expect(mobileTabBarChrome.frostedVeilColor).toMatch(/^rgba\(/);
  expect(rgbaAlpha(mobileTabBarChrome.frostedVeilColor)).toBeGreaterThanOrEqual(0.25);
  expect(mobileTabBarChrome.innerHighlightColor).toMatch(/^rgba\(/);
});

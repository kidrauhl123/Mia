import { bridgeStatusText, bridgeStatusTone, formatBridgeTime } from "../src/logic/bridgeStatus";

test("bridge status maps raw values to Chinese labels and tones", () => {
  expect(bridgeStatusText(true)).toBe("在线");
  expect(bridgeStatusText(false)).toBe("离线");
  expect(bridgeStatusText("running")).toBe("运行中");
  expect(bridgeStatusText("failed")).toBe("失败");
  expect(bridgeStatusTone("succeeded")).toBe("success");
});

test("bridge time formats compact local timestamps", () => {
  const now = new Date(2026, 5, 17, 12, 0, 0);
  expect(formatBridgeTime(new Date(2026, 5, 17, 10, 30, 0), now)).toMatch(/10:30/);
  expect(formatBridgeTime(new Date(2026, 5, 16, 10, 30, 0), now)).toMatch(/^昨天 /);
});

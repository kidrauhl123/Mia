const assert = require("node:assert/strict");
const { test } = require("node:test");

const { describeMobileScanClient } = require("../src/cloud/mobile-scan-client.js");

test("mobile scan client identifies WeChat and device from the user agent", () => {
  const client = describeMobileScanClient({
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Mobile MicroMessenger/8.0.50",
    declaredKind: "browser-web",
    deviceLabel: "伪造的 iPhone",
    platform: "ios"
  });

  assert.deepEqual(client, {
    clientKind: "wechat-web",
    deviceLabel: "微信 · Android",
    platform: "android"
  });
});

test("mobile scan client identifies common mobile browsers", () => {
  const client = describeMobileScanClient({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
  });

  assert.deepEqual(client, {
    clientKind: "browser-web",
    deviceLabel: "Safari · iPhone",
    platform: "ios"
  });
});

test("mobile scan client keeps native Mia App model information", () => {
  const client = describeMobileScanClient({
    declaredKind: "mia-app",
    deviceLabel: "iPhone 16 Pro",
    platform: "ios"
  });

  assert.deepEqual(client, {
    clientKind: "mia-app",
    deviceLabel: "Mia App · iPhone 16 Pro",
    platform: "ios"
  });
});

test("mobile scan client does not trust a Mia App claim from a browser user agent", () => {
  const client = describeMobileScanClient({
    userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36",
    declaredKind: "mia-app",
    deviceLabel: "伪造设备",
    platform: "ios"
  });

  assert.deepEqual(client, {
    clientKind: "browser-web",
    deviceLabel: "Chrome · Android",
    platform: "android"
  });
});

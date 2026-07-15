"use strict";

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function detectPlatform(userAgent = "") {
  const ua = String(userAgent || "");
  if (/iPad/i.test(ua)) return { platform: "ios", device: "iPad" };
  if (/iPhone|iPod/i.test(ua)) return { platform: "ios", device: "iPhone" };
  if (/Android/i.test(ua)) return { platform: "android", device: "Android" };
  if (/Windows/i.test(ua)) return { platform: "windows", device: "Windows" };
  if (/Macintosh|Mac OS X/i.test(ua)) return { platform: "macos", device: "Mac" };
  if (/Linux/i.test(ua)) return { platform: "linux", device: "Linux" };
  return { platform: "web", device: "未知设备" };
}

function detectBrowser(userAgent = "") {
  const ua = String(userAgent || "");
  if (/MicroMessenger/i.test(ua)) return { clientKind: "wechat-web", app: "微信" };
  if (/EdgA|EdgiOS|Edg\//i.test(ua)) return { clientKind: "browser-web", app: "Edge" };
  if (/SamsungBrowser/i.test(ua)) return { clientKind: "browser-web", app: "Samsung 浏览器" };
  if (/CriOS|Chrome\//i.test(ua)) return { clientKind: "browser-web", app: "Chrome" };
  if (/FxiOS|Firefox\//i.test(ua)) return { clientKind: "browser-web", app: "Firefox" };
  if (/Safari\//i.test(ua)) return { clientKind: "browser-web", app: "Safari" };
  return { clientKind: "browser-web", app: "浏览器" };
}

function describeMobileScanClient({
  userAgent = "",
  declaredKind = "",
  deviceLabel = "",
  platform = ""
} = {}) {
  const kind = cleanText(declaredKind, 40).toLowerCase();
  const browserUserAgent = /Mozilla\/\d/i.test(String(userAgent || ""));
  if (kind === "mia-app" && !browserUserAgent) {
    const nativePlatform = cleanText(platform, 40).toLowerCase() || "mobile";
    const nativeDevice = cleanText(deviceLabel, 80) || (nativePlatform === "ios" ? "iPhone" : "Android");
    return {
      clientKind: "mia-app",
      deviceLabel: `Mia App · ${nativeDevice}`,
      platform: nativePlatform
    };
  }

  const browser = detectBrowser(userAgent);
  let detected = detectPlatform(userAgent);
  if (
    detected.platform === "macos"
      && cleanText(platform, 40).toLowerCase() === "ios"
      && cleanText(deviceLabel, 80).toLowerCase() === "ipad"
  ) {
    detected = { platform: "ios", device: "iPad" };
  }
  return {
    clientKind: browser.clientKind,
    deviceLabel: `${browser.app} · ${detected.device}`,
    platform: detected.platform
  };
}

module.exports = {
  describeMobileScanClient,
  detectBrowser,
  detectPlatform
};

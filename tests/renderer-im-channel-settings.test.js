const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("IM settings are a dedicated Cloud-backed settings tab with a narrow preload surface", () => {
  const html = read("src/renderer/index.html");
  const app = read("src/renderer/app.js");
  const preload = read("src/preload.js");
  const ipc = read("src/shared/ipc-channels.js");
  const feature = read("src/renderer/settings/im-channel-settings.js");
  const css = read("src/renderer/styles/im-channels.css");

  assert.match(html, /data-settings-panel="im"/);
  assert.match(html, /src="\.\/settings\/im-channel-settings\.js"/);
  assert.match(html, /href="\.\/styles\/im-channels\.css"/);
  assert.match(app, /miaImChannelSettings\?\.initImChannelSettings/);
  assert.match(app, /activeSettingsTab === "im"/);
  assert.match(preload, /listImChannels: \(\) => ipcRenderer\.invoke\(IpcChannel\.SocialListImChannels\)/);
  assert.match(ipc, /SocialCreateImChannel: "social:create-im-channel"/);
  assert.match(feature, /im-channel-provider-card/);
  assert.match(feature, /连接飞书/);
  assert.match(feature, /连接微信/);
  assert.match(feature, /扫码连接当前设备的微信/);
  assert.match(feature, /function imReadErrorMessage/);
  assert.match(feature, /error\.status = Number\(result\.status\) \|\| 0;/);
  assert.match(feature, /Number\(error\?\.status\) === 404/);
  assert.match(feature, /loaded = true;\s*errorText = imReadErrorMessage\(error\);/);
  assert.doesNotMatch(feature, /wechat_official_account/);
  assert.doesNotMatch(feature, /微信公众号/);
  assert.doesNotMatch(feature, /setupGuide/);
  assert.match(preload, /startWechatClawbotLink/);
  assert.match(preload, /getWechatClawbotStatus/);
  assert.match(preload, /disconnectWechatClawbot/);
  assert.match(preload, /encodeWechatClawbotQr/);
  assert.match(ipc, /SocialEncodeWechatClawbotQr: "social:encode-wechat-clawbot-qr"/);
  assert.match(feature, /function displayableClawbotStatus/);
  assert.match(feature, /encodeWechatClawbotQr\(qrContent\)/);
  assert.doesNotMatch(feature, /require\("electron"/);
  assert.match(css, /\.im-channel-callback code[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(css, /\.im-channel-provider-card/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

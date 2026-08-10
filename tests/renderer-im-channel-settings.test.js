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
  assert.match(feature, /扫码的微信号会自动成为唯一可用的私聊账号/);
  assert.match(feature, /无需填写微信用户 ID/);
  assert.doesNotMatch(feature, /每行一个微信 ClawBot 用户 ID/);
  assert.match(feature, /微信 ClawBot/);
  assert.match(feature, /仅支持文本私聊/);
  assert.match(preload, /startWechatClawbotLink/);
  assert.match(preload, /getWechatClawbotStatus/);
  assert.match(preload, /disconnectWechatClawbot/);
  assert.doesNotMatch(feature, /require\("electron"/);
  assert.match(css, /\.im-channel-callback code[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

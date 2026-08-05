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
  assert.match(feature, /默认拒绝未列出的发送者/);
  assert.match(feature, /微信 ClawBot/);
  assert.doesNotMatch(feature, /require\("electron"/);
  assert.match(css, /\.im-channel-callback code[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

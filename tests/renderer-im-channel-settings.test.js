const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function flushPromises(turns = 4) {
  return Array.from({ length: turns }).reduce((chain) => chain.then(() => Promise.resolve()), Promise.resolve());
}

function loadImChannelSettings({ channels = [], bots = [], statuses = {}, onCreate = async () => ({}) } = {}) {
  const listeners = new Map();
  const container = {
    _html: "",
    addEventListener(type, listener) { listeners.set(type, listener); },
    set innerHTML(value) { this._html = String(value || ""); },
    get innerHTML() { return this._html; },
    click(dataset) {
      listeners.get("click")?.({ target: { closest: () => ({ dataset }) } });
    }
  };
  const mockWindow = {
    setTimeout: () => 0,
    clearTimeout() {},
    miaCloudRuntime: { normalizeRuntimeKind: (kind) => kind === "cloud-claude-code" ? kind : "" },
    miaAvatarResolve: {
      resolveAvatarForContact: (input) => ({
        image: input.avatarImage,
        crop: input.avatarCrop,
        color: input.color || "#5e5ce6",
        text: input.displayName
      })
    },
    miaAvatar: {
      avatarHtml: ({ className, text }) => `<span class="${className}" data-avatar="${text}"></span>`,
      hydrateAvatarMedia() {}
    },
    mia: {
      social: {
        listImChannels: async () => ({ ok: true, data: { channels, providers: [] } }),
        listBots: async () => ({ ok: true, data: { bots } }),
        getWechatClawbotStatus: async (channelId) => ({ ok: true, data: statuses[channelId] || { linked: false } }),
        getCloudWechatClawbotStatus: async (channelId) => ({ ok: true, data: { status: statuses[channelId] || { linked: false } } }),
        startWechatClawbotLink: async () => ({ ok: true, data: { linked: true } }),
        startCloudWechatClawbotLink: async () => ({ ok: true, data: { status: { linked: true } } }),
        submitWechatClawbotPairingCode: async () => ({ ok: true, data: { linked: true } }),
        submitCloudWechatClawbotPairingCode: async () => ({ ok: true, data: { status: { linked: true } } }),
        disconnectWechatClawbot: async () => ({ ok: true, data: {} }),
        disconnectCloudWechatClawbot: async () => ({ ok: true, data: { status: { linked: false } } }),
        createImChannel: onCreate,
        updateImChannel: async () => ({ ok: true, data: {} })
      }
    }
  };
  const context = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    console,
    Map,
    Set,
    Promise,
    String,
    Array,
    Object,
    Boolean,
    FormData
  });
  vm.runInContext(read("src/renderer/settings/im-channel-settings.js"), context, { filename: "im-channel-settings.js" });
  const feature = mockWindow.miaImChannelSettings;
  feature.initImChannelSettings({
    state: { runtime: { cloud: { enabled: true, deviceId: "device_1", user: { id: "u_1" } } } },
    els: { imChannelSettings: container },
    render() {},
    reportError() {}
  });
  return { container, feature };
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
  assert.match(feature, /function wechatProviderCard/);
  assert.match(feature, /im-channel-bot-avatar/);
  assert.match(feature, /function providerIconMarkup/);
  assert.match(feature, /\.\/assets\/brands\/wechat\.png/);
  assert.match(feature, /\.\/assets\/brands\/feishu\.png/);
  assert.doesNotMatch(feature, /<svg viewBox=/);
  for (const asset of ["wechat.png", "feishu.png"]) {
    const icon = path.join(root, "src/renderer/assets/brands", asset);
    assert.ok(fs.existsSync(icon));
    assert.ok(fs.statSync(icon).size > 1_000);
  }
  assert.match(feature, /function cloudBots/);
  assert.match(feature, /wechat-select-bot/);
  assert.match(feature, /data-im-action="wechat-connect"/);
  assert.doesNotMatch(feature, /扫码连接当前设备的微信/);
  assert.doesNotMatch(feature, /通过飞书应用收发消息/);
  assert.doesNotMatch(feature, /启用通道/);
  assert.doesNotMatch(feature, /添加微信/);
  assert.match(feature, /function imReadErrorMessage/);
  assert.match(feature, /error\.status = Number\(result\.status\) \|\| 0;/);
  assert.match(feature, /Number\(error\?\.status\) === 404/);
  assert.match(feature, /loaded = true;\s*errorText = imReadErrorMessage\(error\);/);
  assert.doesNotMatch(feature, /wechat_official_account/);
  assert.doesNotMatch(feature, /微信公众号/);
  assert.doesNotMatch(feature, /setupGuide/);
  assert.match(preload, /startWechatClawbotLink/);
  assert.match(preload, /startCloudWechatClawbotLink/);
  assert.match(preload, /getCloudWechatClawbotStatus/);
  assert.match(preload, /disconnectCloudWechatClawbot/);
  assert.match(preload, /getWechatClawbotStatus/);
  assert.match(preload, /disconnectWechatClawbot/);
  assert.match(preload, /encodeWechatClawbotQr/);
  assert.match(ipc, /SocialEncodeWechatClawbotQr: "social:encode-wechat-clawbot-qr"/);
  assert.match(feature, /function displayableClawbotStatus/);
  assert.match(feature, /function isCloudWechatChannel/);
  assert.match(feature, /startCloudWechatClawbotLink/);
  assert.match(feature, /encodeWechatClawbotQr\(qrContent\)/);
  assert.doesNotMatch(feature, /require\("electron"/);
  assert.match(css, /\.im-channel-callback code[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(css, /\.im-channel-provider-card/);
  assert.match(css, /@media \(max-width: 640px\)/);
});

test("WeChat uses one status, renders the selected Bot avatar, and defaults a new connection to a cloud Bot", async () => {
  const cloudBot = { id: "cloud_bot", displayName: "云端助教", runtimeKind: "cloud-claude-code" };
  const desktopBot = { id: "desktop_bot", displayName: "本机助教", runtimeKind: "desktop-local" };
  const connected = loadImChannelSettings({
    channels: [{
      id: "imc_wechat",
      provider: "wechat_clawbot",
      botId: "cloud_bot",
      enabled: true,
      settings: { relayDeviceId: "device_1" }
    }],
    bots: [desktopBot, cloudBot],
    statuses: { imc_wechat: { linked: true } }
  });
  await flushPromises();
  connected.feature.renderImChannelSettings();
  assert.equal((connected.container.innerHTML.match(/已连接/g) || []).length, 1);
  assert.match(connected.container.innerHTML, /data-avatar="云端助教"/);
  assert.doesNotMatch(connected.container.innerHTML, /添加微信|管理|启用通道/);

  const reauth = loadImChannelSettings({
    channels: [{
      id: "imc_wechat",
      provider: "wechat_clawbot",
      botId: "cloud_bot",
      enabled: true,
      settings: { relayDeviceId: "device_1" }
    }],
    bots: [cloudBot],
    statuses: {
      imc_wechat: {
        linked: false,
        state: "reauth_required",
        message: "微信授权已失效，请重新连接。"
      }
    }
  });
  await flushPromises();
  reauth.feature.renderImChannelSettings();
  assert.match(reauth.container.innerHTML, /需要重新连接/);
  assert.match(reauth.container.innerHTML, /微信授权已失效，请重新连接。/);

  const creates = [];
  const empty = loadImChannelSettings({
    bots: [desktopBot, cloudBot],
    onCreate: async (payload) => {
      creates.push(payload);
      return {
        ok: true,
        data: {
          channel: {
            id: "imc_new",
            provider: "wechat_clawbot",
            botId: payload.botId,
            enabled: true,
            settings: payload.settings
          }
        }
      };
    }
  });
  await flushPromises();
  empty.feature.renderImChannelSettings();
  empty.container.click({ imAction: "wechat-connect" });
  await flushPromises(8);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].botId, "cloud_bot");
  assert.equal(creates[0].enabled, true);
  assert.equal(JSON.stringify(creates[0].settings), "{}");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function el() {
  return {
    textContent: "",
    classList: {
      toggles: [],
      toggle(name, value) { this.toggles.push([name, value]); }
    },
    dataset: {}
  };
}

function loadSettingsRemote({ modelBalance } = {}) {
  const source = fs.readFileSync(path.join(root, "src/renderer/settings/settings-remote.js"), "utf8");
  const calls = [];
  const cloudCalls = [];
  const mockWindow = {
    miaCloud: {
      async fetchModelBalance() {
        cloudCalls.push({ path: "/api/me/model-balance" });
        if (modelBalance instanceof Error) throw modelBalance;
        return modelBalance || {
          balance: { balancePoints: 25 },
          recentUsage: [{ chargePoints: 0.05 }]
        };
      }
    },
    miaAvatar: {
      applyAvatarMedia(target, image, crop, color, text) {
        calls.push({ target, image, crop, color, text });
        target.dataset.avatarText = text;
      }
    },
    miaAvatarResolve: {
      resolveAvatarForContact(input) {
        return {
          image: input.avatarImage || "",
          crop: input.avatarCrop || null,
          color: input.color || "#65c2c8",
          text: "75"
        };
      }
    }
  };
  vm.runInNewContext(source, { window: mockWindow, console }, { filename: "settings-remote.js" });
  return { api: mockWindow.miaSettingsRemote, calls, cloudCalls };
}

test("settings account card renders signed-in avatar, name, and uid", () => {
  const { api, calls } = loadSettingsRemote();
  const state = { runtime: { cloud: {} } };
  const els = {
    cloudAccountHint: el(),
    cloudLogout: el(),
    cloudAccountProfile: el(),
    cloudAccountAvatar: el(),
    cloudAccountName: el(),
    cloudAccountUid: el()
  };
  api.initSettingsRemote({ state, els });

  api.renderCloudAccount({
    enabled: true,
    connected: true,
    user: {
      id: "8123456789",
      username: "755439",
      displayName: "Jung",
      avatarColor: "#65c2c8"
    }
  });

  assert.equal(els.cloudAccountName.textContent, "Jung");
  assert.equal(els.cloudAccountUid.textContent, "UID 8123456789");
  assert.deepEqual(els.cloudAccountProfile.classList.toggles.at(-1), ["hidden", false]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, els.cloudAccountAvatar);
  assert.equal(calls[0].text, "75");
});

test("settings account page exposes model balance fields and app wiring", () => {
  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "src/renderer/styles.css"), "utf8");
  const cloudActions = html.match(/<div class="cloud-actions">([\s\S]*?)<\/div>/)?.[1] || "";

  assert.equal((cloudActions.match(/<button\b/g) || []).length, 1);
  assert.match(cloudActions, /id="cloudLogout"/);
  assert.match(html, /id="cloudModelBalanceRow"/);
  assert.match(html, /id="cloudModelBalanceAmount"/);
  assert.match(html, /id="cloudModelBalanceMeta"/);
  assert.match(appSource, /cloudModelBalanceRow:\s*document\.getElementById\("cloudModelBalanceRow"\)/);
  assert.match(appSource, /cloudModelBalanceAmount:\s*document\.getElementById\("cloudModelBalanceAmount"\)/);
  assert.match(appSource, /cloudModelBalanceMeta:\s*document\.getElementById\("cloudModelBalanceMeta"\)/);
  assert.match(css, /\.cloud-model-balance-row\s*\{/);
});

test("settings account card hides internal cloud sync details", async () => {
  const { api } = loadSettingsRemote();
  const state = { runtime: { cloud: {} } };
  const els = {
    cloudAccountHint: el(),
    cloudLogout: el(),
    cloudAccountProfile: el(),
    cloudAccountAvatar: el(),
    cloudAccountName: el(),
    cloudAccountUid: el()
  };
  api.initSettingsRemote({ state, els });

  await api.renderCloudAccount({
    enabled: true,
    connected: false,
    connecting: false,
    lastError: "INTERNAL_STATUS_SHOULD_NOT_RENDER",
    workspaceRevision: "internal-revision",
    conversationCount: 42,
    user: { id: "100001", username: "wx_8067aabb7153" }
  });

  assert.equal(els.cloudAccountHint.textContent, "wx_8067aabb7153 已登录，云同步暂未连接。");
  assert.doesNotMatch(els.cloudAccountHint.textContent, /INTERNAL_STATUS_SHOULD_NOT_RENDER|internal-revision|42/);
});

test("settings account card fetches and renders the signed-in model balance", async () => {
  const { api, cloudCalls } = loadSettingsRemote({
    modelBalance: {
      balance: { balancePoints: 69.136 },
      recentUsage: [{ chargePoints: 0.025 }]
    }
  });
  const state = { runtime: { cloud: {} } };
  const els = {
    cloudAccountHint: el(),
    cloudLogout: el(),
    cloudAccountProfile: el(),
    cloudAccountAvatar: el(),
    cloudAccountName: el(),
    cloudAccountUid: el(),
    cloudModelBalanceRow: el(),
    cloudModelBalanceAmount: el(),
    cloudModelBalanceMeta: el()
  };
  api.initSettingsRemote({ state, els });

  await api.renderCloudAccount({
    enabled: true,
    connected: true,
    user: { id: "100001", username: "wx_8067aabb7153", displayName: "我耳塞呢" }
  });

  assert.equal(cloudCalls.length, 1);
  assert.equal(els.cloudModelBalanceAmount.textContent, "69.136 积分");
  assert.match(els.cloudModelBalanceMeta.textContent, /最近消耗 0\.025 积分/);
  assert.deepEqual(els.cloudModelBalanceRow.classList.toggles.at(-1), ["hidden", false]);
});

test("settings account card identifies a claimed new-user promotion", async () => {
  const { api } = loadSettingsRemote({
    modelBalance: {
      balance: { balancePoints: 20 },
      recentUsage: [],
      promotionClaims: [{ campaignName: "新用户欢迎积分", grantPoints: 20 }]
    }
  });
  const state = { runtime: { cloud: {} } };
  const els = {
    cloudAccountHint: el(),
    cloudLogout: el(),
    cloudAccountProfile: el(),
    cloudAccountAvatar: el(),
    cloudAccountName: el(),
    cloudAccountUid: el(),
    cloudModelBalanceRow: el(),
    cloudModelBalanceAmount: el(),
    cloudModelBalanceMeta: el()
  };
  api.initSettingsRemote({ state, els });

  await api.renderCloudAccount({
    enabled: true,
    connected: true,
    user: { id: "100001", username: "wx_8067aabb7153" }
  });

  assert.equal(els.cloudModelBalanceAmount.textContent, "20 积分");
  assert.equal(els.cloudModelBalanceMeta.textContent, "新用户欢迎积分已赠 20 积分");
});

test("settings account card hides model balance when signed out", async () => {
  const { api, cloudCalls } = loadSettingsRemote();
  const state = { runtime: { cloud: {} } };
  const els = {
    cloudAccountHint: el(),
    cloudLogout: el(),
    cloudAccountProfile: el(),
    cloudAccountAvatar: el(),
    cloudAccountName: el(),
    cloudAccountUid: el(),
    cloudModelBalanceRow: el(),
    cloudModelBalanceAmount: el(),
    cloudModelBalanceMeta: el()
  };
  api.initSettingsRemote({ state, els });

  await api.renderCloudAccount({ enabled: false, connected: false });

  assert.equal(cloudCalls.length, 0);
  assert.equal(els.cloudModelBalanceAmount.textContent, "");
  assert.equal(els.cloudModelBalanceMeta.textContent, "登录后可查看 Mia 模型积分。");
  assert.deepEqual(els.cloudModelBalanceRow.classList.toggles.at(-1), ["hidden", true]);
});

test("settings account card includes the mobile scan qr shell and shows it only when signed in", async () => {
  const { api } = loadSettingsRemote();
  const state = { runtime: { cloud: {} } };
  const els = {
    cloudAccountHint: el(),
    cloudLogout: el(),
    cloudAccountProfile: el(),
    cloudAccountAvatar: el(),
    cloudAccountName: el(),
    cloudAccountUid: el(),
    cloudModelBalanceRow: el(),
    cloudModelBalanceAmount: el(),
    cloudModelBalanceMeta: el(),
    cloudMobileScanCard: el(),
    cloudMobileScanMeta: el()
  };
  api.initSettingsRemote({ state, els });

  await api.renderCloudAccount({
    enabled: true,
    connected: true,
    mobileScan: {
      qrUrl: "https://mia.test/mobile-scan?grant=ms_1",
      expiresAt: "2026-07-03T00:05:00.000Z"
    },
    user: { id: "100001", username: "wx_8067aabb7153", displayName: "我耳塞呢" }
  });
  assert.deepEqual(els.cloudMobileScanCard.classList.toggles.at(-1), ["hidden", false]);
  assert.equal(els.cloudMobileScanMeta.textContent, "");

  await api.renderCloudAccount({ enabled: false, connected: false });
  assert.deepEqual(els.cloudMobileScanCard.classList.toggles.at(-1), ["hidden", true]);

  const html = fs.readFileSync(path.join(root, "src/renderer/index.html"), "utf8");
  assert.match(html, /id="cloudMobileScanCard"/);
  assert.match(html, />在手机端继续</);
  assert.match(html, /id="cloudMobileScanRefresh"/);
  assert.match(html, /id="cloudMobileScanQr"/);
  assert.match(html, /id="cloudLoginApproveDialog"/);
  assert.match(html, /允许这台设备登录当前账号/);
});

test("mobile scan confirmation polling stays responsive without hard-coded long delay", () => {
  const appSource = fs.readFileSync(path.join(root, "src/renderer/app.js"), "utf8");

  assert.match(appSource, /const CLOUD_MOBILE_SCAN_PENDING_POLL_MS = 700;/);
  assert.match(appSource, /pollCloudMobileScanPending\(\)\.catch\(\(\) => \{\}\);\s*\n\s*\}, CLOUD_MOBILE_SCAN_PENDING_POLL_MS\);/);
  assert.doesNotMatch(appSource, /pollCloudMobileScanPending\(\)\.catch\(\(\) => \{\}\);\s*\n\s*\}, 1500\);/);
});

test("settings account card caches stale-main IPC failures without flashing raw errors", async () => {
  const { api, cloudCalls } = loadSettingsRemote({
    modelBalance: new Error("Error invoking remote method 'cloud:model-balance': Error: No handler registered for 'cloud:model-balance'")
  });
  const state = { runtime: { cloud: {} } };
  const els = {
    cloudAccountHint: el(),
    cloudLogout: el(),
    cloudAccountProfile: el(),
    cloudAccountAvatar: el(),
    cloudAccountName: el(),
    cloudAccountUid: el(),
    cloudModelBalanceRow: el(),
    cloudModelBalanceAmount: el(),
    cloudModelBalanceMeta: el()
  };
  api.initSettingsRemote({ state, els });
  const cloud = {
    enabled: true,
    connected: true,
    user: { id: "100001", username: "wx_8067aabb7153", displayName: "我耳塞呢" }
  };

  await api.renderCloudAccount(cloud);
  await api.renderCloudAccount(cloud);

  assert.equal(cloudCalls.length, 1);
  assert.equal(els.cloudModelBalanceAmount.textContent, "暂不可用");
  assert.equal(els.cloudModelBalanceMeta.textContent, "重启 Mia 后可读取模型积分。");
  assert.doesNotMatch(els.cloudModelBalanceMeta.textContent, /No handler registered|cloud:model-balance/);
  assert.deepEqual(els.cloudModelBalanceRow.classList.toggles.at(-1), ["hidden", false]);
});

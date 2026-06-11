let sequence = 0;

function safeName(value) {
  return String(value || "user").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_") || "user";
}

function wechatProfile(name = "user", overrides = {}) {
  sequence += 1;
  const base = safeName(name);
  return {
    openid: `test_openid_${base}_${sequence}`,
    unionid: `test_union_${base}_${sequence}`,
    nickname: String(name || "Test User"),
    ...overrides
  };
}

function loginCloudUser(cloudStore, name = "user", overrides = {}) {
  const account = cloudStore.loginWithWechat(wechatProfile(name, overrides));
  const username = safeName(name);
  if (username && account?.user?.id) {
    cloudStore.getDb?.().prepare("UPDATE users SET username = ? WHERE id = ?").run(username, account.user.id);
    account.user = { ...account.user, username };
  }
  return account;
}

function createCloudUser(cloudStore, name = "user", overrides = {}) {
  return loginCloudUser(cloudStore, name, overrides).user;
}

function seedCloudAccountInDataDir(dataDir, name = "user", overrides = {}) {
  const { createCloudStore } = require("../../src/cloud/sqlite-store.js");
  const cloudStore = createCloudStore({ dataDir });
  try {
    return loginCloudUser(cloudStore, name, overrides);
  } finally {
    cloudStore.close?.();
  }
}

module.exports = {
  createCloudUser,
  loginCloudUser,
  seedCloudAccountInDataDir,
  wechatProfile
};

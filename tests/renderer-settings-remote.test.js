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

function loadSettingsRemote() {
  const source = fs.readFileSync(path.join(root, "src/renderer/settings/settings-remote.js"), "utf8");
  const calls = [];
  const mockWindow = {
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
  return { api: mockWindow.miaSettingsRemote, calls };
}

test("settings account card renders signed-in avatar, name, and uid", () => {
  const { api, calls } = loadSettingsRemote();
  const state = { runtime: { cloud: {} } };
  const els = {
    cloudAccountHint: el(),
    cloudLoginBox: el(),
    cloudSync: el(),
    cloudLogout: el(),
    cloudLoginHint: el(),
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

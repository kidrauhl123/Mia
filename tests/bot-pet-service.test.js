const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const {
  createBotPetService,
  botPetId
} = require("../src/main/bot-pet-service.js");

class FakePetWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
    this.loadedUrl = "";
    this.sent = [];
    this.visibleOnAllWorkspaces = null;
    this.alwaysOnTop = null;
    this.shown = false;
    this.webContents = {
      send: (channel, payload) => this.sent.push({ channel, payload })
    };
    FakePetWindow.instances.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }

  getBounds() {
    return { ...this.bounds };
  }

  setBounds(bounds) {
    this.bounds = { ...this.bounds, ...bounds };
  }

  setVisibleOnAllWorkspaces(value, options) {
    this.visibleOnAllWorkspaces = { value, options };
  }

  setAlwaysOnTop(value, level) {
    this.alwaysOnTop = { value, level };
  }

  loadURL(url) {
    this.loadedUrl = url;
  }

  showInactive() {
    this.shown = true;
  }

  close() {
    this.destroyed = true;
    this.emit("closed");
  }
}
FakePetWindow.instances = [];

function makeRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-pet-service-"));
  return {
    root,
    runtime: path.join(root, "runtime"),
    home: path.join(root, "runtime", "engine-home"),
    petDir: path.join(root, "runtime", "engine-home", "pets"),
    petJobsDir: path.join(root, "runtime", "engine-home", "pet-jobs"),
    petRemoteSettings: path.join(root, "runtime", "engine-home", "mia-pet-remote.json")
  };
}

function writePetPackage(root, id, overrides = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "spritesheet.webp"), "sheet");
  fs.writeFileSync(path.join(dir, "pet.json"), JSON.stringify({
    id,
    displayName: overrides.displayName || "Alice Pet",
    description: "pet",
    spritesheetPath: "spritesheet.webp"
  }, null, 2));
  return dir;
}

function makeService(overrides = {}) {
  const runtime = overrides.runtime || makeRuntime();
  const appPath = path.join(runtime.root, "app");
  const resourcesPath = path.join(runtime.root, "resources");
  fs.mkdirSync(path.join(appPath, "resources", "pet-generator"), { recursive: true });
  fs.mkdirSync(path.join(resourcesPath, "pet-generator"), { recursive: true });
  fs.writeFileSync(path.join(appPath, "resources", "pet-generator", "hatch_generate.py"), "# generator");
  FakePetWindow.instances = [];
  const timers = [];
  const service = createBotPetService({
    app: {
      getAppPath: () => appPath,
      getPath: () => path.join(runtime.root, "home")
    },
    BrowserWindow: FakePetWindow,
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 10, y: 20, width: 1000, height: 800 } })
    },
    dirname: path.join(runtime.root, "src", "main"),
    resourcesPath,
    runtimePaths: () => runtime,
    readJson: (filePath, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return fallback;
      }
    },
    dataUrlToBuffer: (value) => {
      const match = String(value || "").match(/^data:image\/png;base64,(.+)$/);
      return match ? { data: Buffer.from(match[1], "base64"), ext: ".png" } : null;
    },
    initializeRuntime: () => {},
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      return child;
    },
    randomUUID: () => "12345678-1234-4234-8234-123456789abc",
    nowIso: () => "2026-05-24T00:00:00.000Z",
    nowMs: () => 1234,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
    env: { MIA_PET_REMOTE_DISABLED: "1" },
    platform: "darwin",
    ...overrides
  });
  return { service, runtime, timers };
}

test("status, place, notify, and recall track a bot pet window lifecycle", () => {
  const { service, runtime, timers } = makeService();
  const petId = botPetId("alice_bot");
  writePetPackage(runtime.petDir, petId, { displayName: "Alice Desktop Pet" });

  assert.deepEqual(service.statusForBot("alice_bot"), {
    key: "alice_bot",
    petId,
    hasAsset: true,
    placed: false,
    displayName: "Alice Desktop Pet",
    packageDir: path.join(runtime.petDir, petId),
    spritesheetPath: path.join(runtime.petDir, petId, "spritesheet.webp")
  });

  const placed = service.place("alice_bot");
  const win = FakePetWindow.instances[0];
  assert.equal(placed.placed, true);
  assert.equal(win.options.width, 144);
  assert.match(win.loadedUrl, /pet\.html/);
  assert.match(decodeURIComponent(win.loadedUrl), /spritesheet\.webp/);

  service.notifyMessage("alice_bot", "hello");
  assert.equal(win.sent[0].channel, "pet:message");
  assert.equal(win.sent[0].payload.text, "hello");
  assert.equal(timers[0].ms, 8900);

  const recalled = service.recall("alice_bot");
  assert.equal(recalled.placed, false);
  assert.equal(win.destroyed, true);
  assert.equal(timers[0].cleared, true);
});

test("startGeneration materializes references, spawns hatch_generate, and completes when package appears", () => {
  const spawnCalls = [];
  let child;
  const { service, runtime } = makeService({
    spawnProcess: (command, args, options) => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      spawnCalls.push({ command, args, options });
      return child;
    }
  });

  const dataUrl = `data:image/png;base64,${Buffer.from("image").toString("base64")}`;
  const job = service.startGeneration({
    botKey: "alice_bot",
    bot: { key: "alice_bot", name: "Alice Bot" },
    prompt: "wear a scarf",
    stylePreset: "soft",
    referenceImages: [dataUrl]
  });

  const petId = botPetId("alice_bot");
  assert.equal(job.status, "running");
  assert.equal(job.botKey, "alice_bot");
  assert.equal(job.botName, "Alice Bot");
  assert.equal(job.petId, petId);
  assert.equal(spawnCalls[0].command, "python3");
  assert.ok(spawnCalls[0].args.includes("--prompt"));
  assert.match(spawnCalls[0].args[spawnCalls[0].args.indexOf("--prompt") + 1], /wear a scarf/);
  assert.ok(spawnCalls[0].args.includes("--reference"));
  assert.ok(fs.existsSync(spawnCalls[0].args[spawnCalls[0].args.indexOf("--reference") + 1]));
  assert.equal(spawnCalls[0].options.cwd, service.petGeneratorRoot());

  writePetPackage(runtime.petDir, petId);
  child.emit("close", 0);

  assert.equal(service.jobs()[0].status, "completed");
  assert.equal(service.jobs()[0].botKey, "alice_bot");
  assert.equal(service.jobs()[0].botName, "Alice Bot");
  assert.equal(Object.hasOwn(service.jobs()[0], "fellowKey"), false);
  assert.equal(Object.hasOwn(service.jobs()[0], "fellowName"), false);
  assert.equal(service.jobs()[0].packageDir, path.join(runtime.petDir, petId));
});

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const PET_JOB_STEPS = [
  { id: "base", label: "基础形象", rel: path.join("decoded", "base.png") },
  { id: "idle", label: "待机动作", rel: path.join("decoded", "idle.png") },
  { id: "waving", label: "招手动作", rel: path.join("decoded", "waving.png") },
  { id: "jumping", label: "跳跃动作", rel: path.join("decoded", "jumping.png") },
  { id: "failed", label: "失败动作", rel: path.join("decoded", "failed.png") },
  { id: "waiting", label: "等待动作", rel: path.join("decoded", "waiting.png") },
  { id: "review", label: "检查动作", rel: path.join("decoded", "review.png") }
];

const PET_WINDOW_COMPACT = { width: 144, height: 150 };
const PET_WINDOW_MESSAGE = { width: 260, height: 220 };
const PET_MESSAGE_DURATION_MS = 8500;
const DEFAULT_PET_REMOTE_HOST = "root@23.95.43.168";
const DEFAULT_PET_REMOTE_ROOT = "~/.mia/pet-runs";

function fellowPetId(key) {
  const cleaned = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `mia-${cleaned || "fellow"}`;
}

function legacyFellowPetId(key) {
  const cleaned = String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `mia-${cleaned || "fellow"}`;
}

function petIdAliasesForKey(key) {
  const raw = String(key || "").trim();
  const values = [
    fellowPetId(raw),
    legacyFellowPetId(raw),
    raw,
    raw.replace(/_/g, "-"),
    raw.replace(/-/g, "_")
  ].filter(Boolean);
  return [...new Set(values)];
}

function buildFellowPetPrompt(fellow, userPrompt = "") {
  const extra = String(userPrompt || "").trim();
  const base = [
    `把 Mia Fellow「${fellow.name}」做成可以放在桌面的本地小伙伴。`,
    "参考图是角色原始形象图；保留主要发色、脸部气质、服装和装饰识别点。",
    "做成小体积、清晰轮廓、适合 192x208 动画格子的 Q 版桌宠。",
    "不要加文字、背景、光效、场景或 UI 元素。"
  ].join("\n");
  return extra ? `${base}\n\n用户补充描述：\n${extra}` : base;
}

function createFellowPetService(deps = {}) {
  const app = deps.app;
  const BrowserWindow = deps.BrowserWindow;
  const screen = deps.screen;
  const runtimePaths = deps.runtimePaths;
  const readJson = deps.readJson;
  const loadFellowManifest = deps.loadFellowManifest || (() => ({ fellows: [] }));
  const dataUrlToBuffer = deps.dataUrlToBuffer || (() => null);
  const initializeRuntime = deps.initializeRuntime || (() => {});
  const spawnProcess = deps.spawnProcess || spawn;
  const randomUUID = deps.randomUUID || (() => require("node:crypto").randomUUID());
  const nowIso = deps.nowIso || (() => new Date().toISOString());
  const nowMs = deps.nowMs || (() => Date.now());
  const dirname = deps.dirname || __dirname;
  const resourcesPath = deps.resourcesPath || process.resourcesPath || "";
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;

  if (typeof runtimePaths !== "function") throw new Error("runtimePaths dependency is required.");
  if (typeof readJson !== "function") throw new Error("readJson dependency is required.");

  const petWindows = new Map();
  const petMessageTimers = new Map();
  const petJobs = new Map();

  function readPetManifest(petDir) {
    const manifestPath = path.join(petDir, "pet.json");
    const manifest = readJson(manifestPath, null);
    if (!manifest || typeof manifest !== "object") return null;
    const sheet = String(manifest.spritesheetPath || "spritesheet.webp").trim();
    const sheetPath = path.join(petDir, sheet);
    if (!fs.existsSync(sheetPath)) return null;
    return {
      id: String(manifest.id || path.basename(petDir)),
      displayName: String(manifest.displayName || manifest.name || path.basename(petDir)),
      description: String(manifest.description || ""),
      dir: petDir,
      manifestPath,
      spritesheetPath: sheetPath
    };
  }

  function petRootCandidates() {
    const p = runtimePaths();
    return [
      p.petDir,
      path.join(app.getPath("home"), ".alkaka", "pets"),
      path.join(app.getPath("home"), ".codex", "pets")
    ];
  }

  function findFellowPetPackage(key) {
    const ids = petIdAliasesForKey(key);
    for (const root of petRootCandidates()) {
      for (const id of ids) {
        const pet = readPetManifest(path.join(root, id));
        if (pet) return pet;
      }
    }
    return null;
  }

  function statusForFellow(key) {
    const id = String(key || "");
    const pet = findFellowPetPackage(id);
    return {
      key: id,
      petId: pet?.id || fellowPetId(id),
      hasAsset: Boolean(pet),
      placed: petWindows.has(id),
      displayName: pet?.displayName || "",
      packageDir: pet?.dir || "",
      spritesheetPath: pet?.spritesheetPath || ""
    };
  }

  function statusesForFellows(fellows = []) {
    return Object.fromEntries((fellows || []).map((fellow) => [fellow.key, statusForFellow(fellow.key)]));
  }

  function petGeneratorRoot() {
    const candidates = [
      path.join(app.getAppPath(), "resources", "pet-generator"),
      path.join(resourcesPath, "pet-generator"),
      path.join(dirname, "..", "resources", "pet-generator")
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "hatch_generate.py"))) || candidates[0];
  }

  function miaSkillsRoot() {
    const candidates = [
      path.join(resourcesPath, "skills"),
      path.join(app.getAppPath(), "skills"),
      path.join(dirname, "..", "skills")
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "pet-generator", "SKILL.md"))) || candidates[0];
  }

  function officialLibraryManifestPath() {
    const candidates = [
      path.join(app.getAppPath(), "resources", "official-library", "library.json"),
      path.join(resourcesPath, "official-library", "library.json"),
      path.join(dirname, "..", "resources", "official-library", "library.json")
    ];
    return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || candidates[0];
  }

  function resolveOfficialLibraryRoot(root = "") {
    const value = String(root || "").trim();
    if (!value) return "";
    if (path.isAbsolute(value)) return value;
    if (value === "pet-generator" || value.startsWith("pet-generator/")) {
      const rel = value.slice("pet-generator".length).replace(/^[\\/]/, "");
      return path.join(petGeneratorRoot(), rel);
    }
    if (value === "skills" || value.startsWith("skills/")) {
      const rel = value.slice("skills".length).replace(/^[\\/]/, "");
      return path.join(miaSkillsRoot(), rel);
    }
    return path.join(path.dirname(officialLibraryManifestPath()), value);
  }

  function materializePetReference(rawValue, outDir, index) {
    const raw = String(rawValue || "").trim();
    if (!raw) return null;
    fs.mkdirSync(outDir, { recursive: true });
    const data = dataUrlToBuffer(raw);
    if (data) {
      const target = path.join(outDir, `reference-${String(index).padStart(2, "0")}${data.ext}`);
      fs.writeFileSync(target, data.data);
      return target;
    }
    let source = raw;
    if (/^file:/i.test(raw)) {
      source = fileURLToPath(raw);
    } else if (raw.startsWith("./") || raw.startsWith("../")) {
      source = path.join(dirname, "renderer", raw);
    }
    if (!path.isAbsolute(source) || !fs.existsSync(source)) return null;
    const ext = path.extname(source) || ".png";
    const target = path.join(outDir, `reference-${String(index).padStart(2, "0")}${ext}`);
    fs.copyFileSync(source, target);
    return target;
  }

  function styleSettingsForPet(stylePreset) {
    const preset = String(stylePreset || "codex").trim();
    if (preset === "alkaka") {
      const styleReference = path.join(petGeneratorRoot(), "alkaka-friend-pet", "assets", "alkaka-style-reference.jpg");
      return {
        styleNotes: "Alkaka Q版贴纸风：紧凑可爱的伙伴桌宠，清晰线条，大眼睛，保留头像身份特征，适合 192x208 小尺寸动画。",
        styleContract: "Cute anime sticker-like partner desktop pet, compact chibi proportions, clean dark linework, soft cel shading, readable at 192x208 cells. Avoid realistic rendering, scene backgrounds, tiny noisy detail, shadows, glows, text, and UI elements.",
        styleReferences: fs.existsSync(styleReference) ? [styleReference] : []
      };
    }
    if (preset === "soft") {
      return {
        styleNotes: "柔和 Q 版桌宠：圆润、轻量、少装饰，保留头像主要发色、服饰和气质。",
        styleContract: "Soft cute digital pet sprite style with simple readable silhouette, flat colors, clean outline, no scene background, no glossy illustration effects.",
        styleReferences: []
      };
    }
    return {
      styleNotes: "Codex 内置桌宠风：小体积、像素感边缘、粗轮廓、有限色板、动作清楚但不花哨。",
      styleContract: "Codex built-in digital pet style: small pixel-art-adjacent mascot, compact chibi proportions, chunky readable silhouette, thick dark outline, limited palette, flat cel shading, transparent sprite atlas.",
      styleReferences: []
    };
  }

  function petRemoteCodexSettings() {
    const saved = readJson(runtimePaths().petRemoteSettings, {});
    const disabled = env.MIA_PET_REMOTE_DISABLED === "1" || saved.enabled === false;
    const host = disabled
      ? ""
      : String(env.MIA_PET_REMOTE_HOST || saved.host || DEFAULT_PET_REMOTE_HOST).trim();
    const root = String(env.MIA_PET_REMOTE_ROOT || saved.root || DEFAULT_PET_REMOTE_ROOT).trim();
    return { host, root, enabled: Boolean(host) };
  }

  function filePreview(pathValue) {
    if (!pathValue || !fs.existsSync(pathValue)) return null;
    const stat = fs.statSync(pathValue);
    return {
      path: pathValue,
      url: pathToFileURL(pathValue).toString(),
      updatedAt: stat.mtime.toISOString()
    };
  }

  function petRunProgress(runDir) {
    const root = String(runDir || "");
    if (!root) return { total: PET_JOB_STEPS.length, complete: 0, current: "base", steps: [] };
    const steps = PET_JOB_STEPS.map((step) => {
      const preview = filePreview(path.join(root, step.rel));
      return {
        id: step.id,
        label: step.label,
        status: preview ? "complete" : "pending",
        preview
      };
    });
    const complete = steps.filter((step) => step.status === "complete").length;
    const current = steps.find((step) => step.status !== "complete")?.id || "finalizing";
    return {
      total: steps.length,
      complete,
      current,
      steps,
      preview: filePreview(path.join(root, "preview", "spritesheet.png")),
      final: filePreview(path.join(root, "final", "spritesheet.png")),
      contactSheet: filePreview(path.join(root, "qa", "contact-sheet.png"))
    };
  }

  function petJobSnapshot(job) {
    return {
      id: job.id,
      fellowKey: job.fellowKey,
      fellowName: job.fellowName,
      petId: job.petId,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt || "",
      error: job.error || "",
      runDir: job.runDir,
      packageDir: job.packageDir || "",
      logPath: job.logPath || "",
      prompt: job.userPrompt || "",
      stylePreset: job.stylePreset || "codex",
      referenceImages: job.referenceImages || [],
      progress: petRunProgress(job.runDir),
      logs: (job.logs || []).slice(-40)
    };
  }

  function jobs() {
    return Array.from(petJobs.values())
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map(petJobSnapshot);
  }

  function startGeneration(input = {}) {
    initializeRuntime();
    const key = String(input.fellowKey || input.key || "").trim();
    const manifest = loadFellowManifest();
    const fellow = (manifest.fellows || []).find((item) => item.key === key);
    if (!fellow) throw new Error("Fellow not found.");
    const generatorRoot = petGeneratorRoot();
    const script = path.join(generatorRoot, "hatch_generate.py");
    if (!fs.existsSync(script)) throw new Error(`Mia pet generator not found: ${script}`);

    const p = runtimePaths();
    const jobId = randomUUID();
    const petId = fellowPetId(fellow.key);
    const runDir = path.join(p.petJobsDir, `${petId}-${jobId.slice(0, 8)}`);
    const refDir = path.join(runDir, "mia-references");
    const referenceImages = Array.isArray(input.referenceImages) ? input.referenceImages : [];
    const references = referenceImages
      .map((value, index) => materializePetReference(value, refDir, index + 1))
      .filter(Boolean);
    const stylePreset = String(input.stylePreset || "codex").trim() || "codex";
    const userPrompt = String(input.prompt || "").trim();
    const style = styleSettingsForPet(stylePreset);
    const prompt = buildFellowPetPrompt(fellow, userPrompt);
    const job = {
      id: jobId,
      fellowKey: fellow.key,
      fellowName: fellow.name,
      petId,
      status: "running",
      startedAt: nowIso(),
      runDir,
      packageDir: path.join(p.petDir, petId),
      logPath: path.join(runDir, "generation.log"),
      userPrompt,
      stylePreset,
      referenceImages,
      logs: []
    };
    petJobs.set(jobId, job);
    fs.mkdirSync(runDir, { recursive: true });

    const args = [
      script,
      "--prompt", prompt,
      "--pet-id", petId,
      "--display-name", fellow.name,
      "--description", `${fellow.name} 的 Mia 桌宠。`,
      "--style-notes", style.styleNotes,
      "--style-contract", style.styleContract,
      "--row-concurrency", "3",
      "--run-dir", runDir,
      "--package-dir", path.join(p.petDir, petId),
      "--no-partial-preview"
    ];
    const remote = petRemoteCodexSettings();
    if (remote.host) {
      args.push("--remote-host", remote.host);
      if (remote.root) args.push("--remote-root", remote.root);
    }
    for (const reference of references) args.push("--reference", reference);
    for (const reference of style.styleReferences) args.push("--style-reference", reference);

    const child = spawnProcess("python3", args, {
      cwd: generatorRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const append = (chunk) => {
      const text = String(chunk || "");
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        job.logs.push(line);
        if (job.logs.length > 160) job.logs.shift();
      }
    };
    child.stdout?.on?.("data", append);
    child.stderr?.on?.("data", append);
    child.on?.("error", (error) => {
      job.status = "failed";
      job.error = error.message;
      job.finishedAt = nowIso();
    });
    child.on?.("close", (code) => {
      job.finishedAt = nowIso();
      if (code === 0 && findFellowPetPackage(fellow.key)) {
        job.status = "completed";
      } else {
        job.status = "failed";
        job.error = code === 0 ? "生成结束，但没有找到可用的 pet.json + spritesheet。" : `生成进程退出：${code}`;
      }
    });
    return petJobSnapshot(job);
  }

  function resizePetWindow(win, size) {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    win.setBounds({
      x: bounds.x + bounds.width - size.width,
      y: bounds.y + bounds.height - size.height,
      width: size.width,
      height: size.height
    }, false);
  }

  function notifyMessage(fellowKey, text) {
    const key = String(fellowKey || "").trim();
    const content = String(text || "").trim();
    if (!key || !content) return;
    const win = petWindows.get(key);
    if (!win || win.isDestroyed()) return;

    resizePetWindow(win, PET_WINDOW_MESSAGE);
    try {
      win.webContents.send("pet:message", {
        fellowKey: key,
        text: content,
        durationMs: PET_MESSAGE_DURATION_MS,
        ts: nowMs()
      });
    } catch {
      // Ignore closed-window IPC races.
    }

    const existingTimer = petMessageTimers.get(key);
    if (existingTimer) clearTimeoutFn(existingTimer);
    const timer = setTimeoutFn(() => {
      petMessageTimers.delete(key);
      const current = petWindows.get(key);
      if (current && !current.isDestroyed()) resizePetWindow(current, PET_WINDOW_COMPACT);
    }, PET_MESSAGE_DURATION_MS + 400);
    petMessageTimers.set(key, timer);
  }

  function place(key) {
    initializeRuntime();
    const id = String(key || "").trim();
    const pet = findFellowPetPackage(id);
    if (!pet) throw new Error("这个 Fellow 还没有可用桌宠资产。");
    const existing = petWindows.get(id);
    if (existing && !existing.isDestroyed()) return statusForFellow(id);
    const petWindowWidth = PET_WINDOW_COMPACT.width;
    const petWindowHeight = PET_WINDOW_COMPACT.height;

    if (typeof BrowserWindow !== "function") throw new Error("BrowserWindow dependency is required.");
    const win = new BrowserWindow({
      width: petWindowWidth,
      height: petWindowHeight,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(dirname, "pet-preload.js"),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    petWindows.set(id, win);
    if (platform === "darwin") {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    } else {
      win.setVisibleOnAllWorkspaces(true);
    }
    win.setAlwaysOnTop(true, "floating");
    const display = screen.getPrimaryDisplay().workArea;
    win.setBounds({
      x: display.x + display.width - petWindowWidth - 24,
      y: display.y + display.height - petWindowHeight - 24,
      width: petWindowWidth,
      height: petWindowHeight
    }, false);
    const url = pathToFileURL(path.join(dirname, "renderer", "pet.html"));
    url.searchParams.set("sheet", pathToFileURL(pet.spritesheetPath).toString());
    url.searchParams.set("name", pet.displayName);
    win.loadURL(url.toString());
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.showInactive();
    });
    win.on("closed", () => {
      if (petWindows.get(id) === win) petWindows.delete(id);
      const timer = petMessageTimers.get(id);
      if (timer) clearTimeoutFn(timer);
      petMessageTimers.delete(id);
    });
    return statusForFellow(id);
  }

  function recall(key) {
    const id = String(key || "").trim();
    const win = petWindows.get(id);
    if (win && !win.isDestroyed()) win.close();
    petWindows.delete(id);
    const timer = petMessageTimers.get(id);
    if (timer) clearTimeoutFn(timer);
    petMessageTimers.delete(id);
    return statusForFellow(id);
  }

  return {
    miaSkillsRoot,
    findFellowPetPackage,
    jobs,
    materializePetReference,
    notifyMessage,
    officialLibraryManifestPath,
    petGeneratorRoot,
    petRootCandidates,
    place,
    recall,
    resolveOfficialLibraryRoot,
    startGeneration,
    statusForFellow,
    statusesForFellows,
    styleSettingsForPet
  };
}

module.exports = {
  PET_JOB_STEPS,
  buildFellowPetPrompt,
  createFellowPetService,
  fellowPetId,
  legacyFellowPetId,
  petIdAliasesForKey
};

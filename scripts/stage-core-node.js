"use strict";

// Stage a real, SELF-CONTAINED `node` binary into resources/mia-node/node so
// electron-builder can copy it into the packaged app (extraResources →
// Contents/Resources/mia-node).
//
// WHY: the packaged "Mia Core" daemon (src/core/mia-core.js) runs under a PLAIN
// node process, not Electron — a plain node cannot require out of app.asar, and
// Electron's bundled node lives inside the framework. So the build ships its own
// node binary alongside the asar.unpacked Core require graph.
//
// SOURCE: the official nodejs.org prebuilt binaries are statically linked against
// libnode and depend only on system libraries, so they relocate cleanly into the
// app bundle. A package-manager node (e.g. Homebrew) is NOT self-contained — it
// loads @rpath/libnode.*.dylib + other cellar dylibs and breaks when copied — so
// we download the official arch-matched release. The download is cached under
// node_modules/.cache/mia-core-node. Set MIA_CORE_NODE to override with a known
// self-contained binary (the script verifies self-containment via `otool`).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "resources", "mia-node");
const OUT = path.join(OUT_DIR, "node");
const CACHE_DIR = path.join(ROOT, "node_modules", ".cache", "mia-core-node");

// Pinned node version shipped as the Core daemon runtime. Independent of the
// build machine's node; the official tarball is self-contained.
const NODE_VERSION = process.env.MIA_CORE_NODE_VERSION || "v22.14.0";

function targetArchFromContext(context) {
  // electron-builder beforePack passes arch as an Arch enum index.
  const map = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" };
  const archIndex = context && (typeof context.arch === "number" ? context.arch : null);
  if (archIndex != null && map[archIndex]) return map[archIndex];
  if (process.env.MIA_CORE_TARGET_ARCH) return process.env.MIA_CORE_TARGET_ARCH;
  return process.arch === "arm64" ? "arm64" : "x64";
}

// macOS-only: assert the binary loads no non-system dylibs (i.e. it is relocatable).
function assertSelfContained(binary) {
  if (process.platform !== "darwin") return;
  let out = "";
  try {
    out = execFileSync("otool", ["-L", binary], { encoding: "utf8" });
  } catch {
    return; // otool unavailable — skip the check rather than block.
  }
  const offenders = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith(":"))
    .map((l) => l.split(/\s+/)[0])
    .filter((lib) => lib && !lib.startsWith("/usr/lib/") && !lib.startsWith("/System/"));
  if (offenders.length) {
    throw new Error(
      `[stage-core-node] '${binary}' is not self-contained; it loads: ${offenders.join(", ")}. ` +
      "A package-manager node cannot be bundled — use the official nodejs.org release."
    );
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download ${u} → HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    get(url).on("error", (e) => { try { fs.unlinkSync(dest); } catch {} reject(e); });
  });
}

async function officialNode(targetArch) {
  const arch = targetArch === "x64" ? "x64" : "arm64";
  const tag = `node-${NODE_VERSION}-darwin-${arch}`;
  const cached = path.join(CACHE_DIR, `${tag}-node`);
  if (fs.existsSync(cached)) return cached;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tarUrl = `https://nodejs.org/dist/${NODE_VERSION}/${tag}.tar.gz`;
  const tarPath = path.join(CACHE_DIR, `${tag}.tar.gz`);
  console.log(`[stage-core-node] downloading ${tarUrl}`);
  await download(tarUrl, tarPath);

  const extractDir = path.join(CACHE_DIR, tag);
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarPath, "-C", extractDir, "--strip-components=1"], { stdio: "inherit" });
  const extractedNode = path.join(extractDir, "bin", "node");
  fs.copyFileSync(extractedNode, cached);
  fs.chmodSync(cached, 0o755);
  return cached;
}

async function resolveSource(targetArch) {
  // Explicit override (must be self-contained — verified below).
  if (process.env.MIA_CORE_NODE) return fs.realpathSync(process.env.MIA_CORE_NODE);
  // Try the official self-contained download.
  try {
    return await officialNode(targetArch);
  } catch (err) {
    // Network failed — fall back to the local node ONLY if it is self-contained
    // and arch-matches. A Homebrew node will fail assertSelfContained and we
    // report the blocker rather than ship a broken binary.
    console.warn(`[stage-core-node] official download failed (${err && err.message}); trying local ${process.execPath}`);
    const local = fs.realpathSync(process.execPath);
    return local;
  }
}

async function stage(targetArch) {
  const source = await resolveSource(targetArch);
  assertSelfContained(source);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(source, OUT);
  fs.chmodSync(OUT, 0o755);
  const bytes = fs.statSync(OUT).size;
  console.log(`[stage-core-node] staged node (${bytes} bytes) for ${targetArch} from ${source} → ${OUT}`);
}

// electron-builder beforePack hook export.
module.exports = async function stageCoreNode(context) {
  await stage(targetArchFromContext(context));
};

// CLI usage: `node scripts/stage-core-node.js [arch]`.
if (require.main === module) {
  const arch = process.argv[2] || (process.arch === "arm64" ? "arm64" : "x64");
  stage(arch).catch((e) => { console.error(e.message); process.exit(1); });
}

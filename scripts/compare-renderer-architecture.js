#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const miaRoot = path.resolve(__dirname, "..");

function argumentValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function walkFiles(root, extensions, ignoredDirectories = new Set()) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath, extensions, ignoredDirectories));
    else if (extensions.has(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}

function sourceText(files) {
  return files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

function byteSum(files) {
  return files.reduce((total, file) => total + fs.statSync(file).size, 0);
}

function countMatches(text, expression) {
  return (text.match(expression) || []).length;
}

function miaMetrics() {
  const rendererRoot = path.join(miaRoot, "src", "renderer");
  const html = fs.readFileSync(path.join(rendererRoot, "index.html"), "utf8");
  const scriptRows = [...html.matchAll(/<script([^>]*)src="([^"]+)"/g)].map((match) => {
    const file = path.resolve(rendererRoot, match[2]);
    return {
      module: /type="module"/.test(match[1]),
      file,
      bytes: fs.existsSync(file) ? fs.statSync(file).size : 0
    };
  });
  const classicScripts = scriptRows.filter((row) => !row.module);
  const reactEntry = scriptRows.find((row) => row.module);
  const reactFiles = walkFiles(
    path.join(rendererRoot, "react"),
    new Set([".ts", ".tsx"]),
    new Set(["react-dist"])
  );
  const reactSource = sourceText(reactFiles);
  const lazyChunks = walkFiles(
    path.join(rendererRoot, "react-dist", "chunks"),
    new Set([".js"])
  );
  return {
    reactRootCount: countMatches(reactSource, /createRoot\(/g),
    lazyImportCount: countMatches(reactSource, /lazy\(\(\)\s*=>\s*import\(/g),
    reactSourceFiles: reactFiles.length,
    reactSourceBytes: Buffer.byteLength(reactSource),
    startupReactEntryBytes: reactEntry?.bytes || 0,
    directClassicScriptCount: classicScripts.length,
    directClassicScriptBytes: classicScripts.reduce((total, row) => total + row.bytes, 0),
    splitChunkCount: lazyChunks.length,
    splitChunkBytes: byteSum(lazyChunks)
  };
}

function aionMetrics(aionRoot) {
  const rendererRoot = path.join(aionRoot, "packages", "desktop", "src", "renderer");
  const rendererFiles = walkFiles(
    rendererRoot,
    new Set([".ts", ".tsx", ".js", ".jsx", ".css", ".html"]),
    new Set(["node_modules", "out", "dist"])
  );
  if (!rendererFiles.length) {
    throw new Error(`AionUi renderer source was not found below ${rendererRoot}`);
  }
  const rendererSource = sourceText(rendererFiles);
  return {
    reactRootCount: countMatches(rendererSource, /createRoot\(/g),
    lazyImportCount: countMatches(rendererSource, /lazy\(\(\)\s*=>\s*import\(/g),
    rendererSourceFiles: rendererFiles.length,
    rendererSourceBytes: Buffer.byteLength(rendererSource),
    productionBuildPresent: fs.existsSync(path.join(aionRoot, "out", "main", "index.js")),
    startupBenchmarkDependenciesPresent:
      fs.existsSync(path.join(aionRoot, "node_modules", "playwright"))
      && fs.existsSync(path.join(aionRoot, "node_modules", "electron"))
  };
}

function main() {
  const defaultAionRoot = path.resolve(miaRoot, "..", "AionUi");
  const aionRoot = path.resolve(argumentValue("--aion", defaultAionRoot));
  const report = {
    capturedAt: new Date().toISOString(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      node: process.version
    },
    mia: miaMetrics(),
    aion: aionMetrics(aionRoot),
    runtimeComparisonReady: false,
    note: "Architecture and shipped-load inventory only; runtime latency needs a built AionUi and its Playwright benchmark dependencies."
  };
  report.runtimeComparisonReady =
    report.mia.startupReactEntryBytes > 0
    && report.aion.productionBuildPresent
    && report.aion.startupBenchmarkDependenciesPresent;
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();

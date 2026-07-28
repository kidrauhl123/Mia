"use strict";

const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const entry = path.join(root, "src", "renderer", "react", "main.tsx");
const outdir = path.join(root, "src", "renderer", "react-dist");
const outfile = path.join(outdir, "renderer.js");
const MAX_RENDERER_BUNDLE_BYTES = 256 * 1024;

async function buildRendererReact(options = {}) {
  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });
  const result = await esbuild.build({
    entryPoints: [entry],
    outdir,
    bundle: true,
    format: "esm",
    splitting: true,
    entryNames: "renderer",
    chunkNames: "chunks/[name]-[hash]",
    platform: "browser",
    target: "chrome130",
    jsx: "automatic",
    sourcemap: options.sourcemap === true,
    minify: options.minify !== false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production")
    },
    legalComments: "eof",
    logLevel: options.quiet ? "silent" : "info",
    metafile: true
  });
  const outputs = result.metafile.outputs;
  const entryOutput = Object.entries(outputs).find(([, meta]) => meta.entryPoint?.endsWith("src/renderer/react/main.tsx"))?.[0];
  if (!entryOutput) throw new Error("React renderer entry was not emitted.");
  const initialOutputs = new Set();
  const visitInitialOutput = (outputPath) => {
    if (initialOutputs.has(outputPath)) return;
    initialOutputs.add(outputPath);
    const output = outputs[outputPath];
    for (const dependency of output?.imports || []) {
      if (dependency.kind === "dynamic-import" || dependency.external) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(outputPath), dependency.path));
      if (outputs[resolved]) visitInitialOutput(resolved);
    }
  };
  visitInitialOutput(entryOutput);
  const bundleBytes = [...initialOutputs].reduce((total, outputPath) => total + outputs[outputPath].bytes, 0);
  if (bundleBytes > MAX_RENDERER_BUNDLE_BYTES) {
    throw new Error(
      `React renderer startup graph is ${bundleBytes} bytes; budget is ${MAX_RENDERER_BUNDLE_BYTES} bytes. `
      + "Move low-frequency UI behind a split entry instead of growing the startup bundle."
    );
  }
  return outfile;
}

if (require.main === module) {
  buildRendererReact({
    minify: !process.argv.includes("--development"),
    sourcemap: process.argv.includes("--sourcemap")
  }).catch((error) => {
    console.error("[renderer-react] build failed", error);
    process.exitCode = 1;
  });
}

module.exports = { buildRendererReact, MAX_RENDERER_BUNDLE_BYTES };

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
  fs.mkdirSync(outdir, { recursive: true });
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome130",
    jsx: "automatic",
    sourcemap: options.sourcemap === true,
    minify: options.minify !== false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("production")
    },
    legalComments: "eof",
    logLevel: options.quiet ? "silent" : "info"
  });
  const bundleBytes = fs.statSync(outfile).size;
  if (bundleBytes > MAX_RENDERER_BUNDLE_BYTES) {
    throw new Error(
      `React renderer bundle is ${bundleBytes} bytes; budget is ${MAX_RENDERER_BUNDLE_BYTES} bytes. `
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

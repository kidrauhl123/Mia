#!/usr/bin/env node
// 把 mobile 视图 + 依赖的 shared/* + 渲染适配器拼进 dist/mobile-www/。
// 布局与绝对路径引用一致(index.html 用 /shared、/mobile、/message-sources):
//   dist/mobile-www/
//     index.html
//     mobile/{app.js,styles.css,lib/*}
//     shared/*.js
//     message-sources/cloud-conversation-source.js
// serve-mobile.js 与 Capacitor 都从 webDir 根提供,绝对路径即可解析。
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const out = path.join(root, "dist", "mobile-www");

const SHARED = [
  "engine-contracts", "conversation-kinds", "message-spec", "contact", "avatar-resolve",
  "unread", "send-pipeline", "agent-permissions", "trace-blocks", "cloud-client"
];

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// index.html 在 webDir 根
copy(path.join(root, "src", "mobile", "index.html"), path.join(out, "index.html"));
// 视图层放 /mobile
["styles.css", "app.js", "manifest.json"].forEach((f) => {
  const src = path.join(root, "src", "mobile", f);
  if (fs.existsSync(src)) copy(src, path.join(out, "mobile", f));
});
// lib → /mobile/lib
for (const f of fs.readdirSync(path.join(root, "src", "mobile", "lib"))) {
  copy(path.join(root, "src", "mobile", "lib", f), path.join(out, "mobile", "lib", f));
}
// shared → /shared
for (const name of SHARED) copy(path.join(root, "src", "shared", `${name}.js`), path.join(out, "shared", `${name}.js`));
// 渲染适配器 → /message-sources
copy(
  path.join(root, "src", "renderer", "message-sources", "cloud-conversation-source.js"),
  path.join(out, "message-sources", "cloud-conversation-source.js")
);

console.log(`[build-mobile-www] wrote ${out}`);

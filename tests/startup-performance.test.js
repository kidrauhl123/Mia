const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const paramsStart = source.indexOf("(", start);
  let paramsDepth = 0;
  let paramsEnd = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === "(") paramsDepth += 1;
    if (source[index] === ")" && --paramsDepth === 0) {
      paramsEnd = index;
      break;
    }
  }
  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test("renderer keeps heavyweight Lottie parsing off the first-paint path", () => {
  const html = read("src/renderer/index.html");
  const lottie = read("src/renderer/lottie-icons.js");

  assert.doesNotMatch(html, /<script src="\.\/assets\/lottie\/lottie\.min\.js"><\/script>/);
  assert.match(html, /<script src="\.\/startup\/idle-scheduler\.js"><\/script>[\s\S]*<script src="\.\/lottie-icons\.js"><\/script>/);
  assert.match(lottie, /function loadPlayer\(\)/);
  assert.match(lottie, /script\.src = "\.\/assets\/lottie\/lottie\.min\.js"/);
});

test("normal startup batches runtime metadata and leaves skills on demand", () => {
  const app = read("src/renderer/app.js");
  const initialData = functionSource(app, "loadInitialRuntimeData");
  const initializeRuntime = functionSource(app, "initializeRuntime");

  assert.match(initialData, /trackStartupTask\("加载运行配置"/);
  assert.doesNotMatch(initialData, /loadSkills\(/);
  assert.match(initializeRuntime, /miaIdleScheduler\?\.schedule/);
  assert.match(initializeRuntime, /delayMs:\s*1_200/);
  assert.match(initializeRuntime, /delayMs:\s*2_800/);
});

test("system Hermes discovery uses non-blocking child processes", () => {
  const mainSource = read("src/main.js");

  assert.match(
    mainSource,
    /createSystemHermesService\(\{[\s\S]*?\bspawn,\s*\n\s*spawnSync,/
  );
});

test("social bootstrap renders metadata before on-demand message hydration", () => {
  const social = read("src/renderer/social/social.js");
  const bootstrap = functionSource(social, "bootstrapAfterLogin");
  const hydrateCache = functionSource(social, "hydrateCachedSocialBootstrap");

  assert.doesNotMatch(bootstrap, /listConversationMessages\(/);
  assert.doesNotMatch(bootstrap, /Promise\.all\(memberConversationsToFetch/);
  assert.match(bootstrap, /moduleState\.bootstrapped = true/);
  assert.doesNotMatch(hydrateCache, /getCachedConversationMessages/);
});

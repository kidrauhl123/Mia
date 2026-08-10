const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createRenderScheduler } = require("../src/renderer/render-scheduler.js");

test("renderer scheduler coalesces repeated requests into one frame", () => {
  const frames = [];
  let renders = 0;
  const scheduler = createRenderScheduler({
    render: () => { renders += 1; },
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {}
  });

  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();

  assert.equal(frames.length, 1);
  assert.equal(renders, 0);
  frames[0]();
  assert.equal(renders, 1);
  assert.equal(scheduler.isScheduled(), false);
});

test("renderer scheduler merges dirty scopes without scheduling extra frames", () => {
  const frames = [];
  const renders = [];
  const scheduler = createRenderScheduler({
    render: (scopes) => renders.push(scopes),
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {}
  });

  scheduler.schedule("sidebar");
  scheduler.schedule("chat");
  scheduler.schedule(["sidebar", "header"]);

  assert.deepEqual(scheduler.pendingScopes().sort(), ["chat", "header", "sidebar"]);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(renders, [["sidebar", "chat", "header"]]);
});

test("renderer scheduler flush cancels pending work before rendering synchronously", () => {
  const cancelled = [];
  let renders = 0;
  const scheduler = createRenderScheduler({
    render: () => { renders += 1; },
    requestFrame: () => 17,
    cancelFrame: (id) => cancelled.push(id)
  });

  scheduler.schedule();
  scheduler.flush();

  assert.deepEqual(cancelled, [17]);
  assert.equal(renders, 1);
  assert.equal(scheduler.isScheduled(), false);
});

test("social events are wired to a coalesced conversation-only renderer", () => {
  const root = path.join(__dirname, "..");
  const appSource = fs.readFileSync(path.join(root, "src", "renderer", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
  const reactMain = fs.readFileSync(path.join(root, "src", "renderer", "react", "main.tsx"), "utf8");

  assert.match(appSource, /render:\s*\(conversationScopes\)\s*=>\s*render\(\{\s*conversationOnly:\s*true,\s*conversationScopes\s*\}\)/);
  assert.match(appSource, /initSocialModule\(\{[\s\S]*?render:\s*scheduleConversationRender/);
  assert.match(appSource, /conversationOnly\s*&&\s*\(!chatViewActive\s*\|\|\s*!rendererInteractive\)/);
  assert.match(appSource, /state\.activeView === "skills"\)\s*window\.miaSkillLibrary\.renderSkillLibrary\(\)/);
  assert.match(appSource, /state\.activeView === "contacts"\)\s*window\.miaBotManager\.renderContacts\(\)/);
  assert.match(appSource, /state\.activeView === "tasks"\)\s*window\.miaTasksPanel\?\.\s*renderTaskView\(\)/);
  assert.ok(
    html.indexOf("./render-scheduler.js") < html.indexOf("./react-dist/renderer.js"),
    "the frame scheduler must load before the React renderer"
  );
  assert.match(reactMain, /appScript\.src = "\.\/app\.js"/);
});

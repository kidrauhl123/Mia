const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadRecoveryScript(search = "") {
  const source = fs.readFileSync(
    path.join(root, "src/renderer/recovery/renderer-recovery.js"),
    "utf8"
  );
  let clickHandler = null;
  let focusCalls = 0;
  const replacements = [];
  const retryButton = {
    addEventListener: (event, handler) => {
      if (event === "click") clickHandler = handler;
    },
    focus: () => { focusCalls += 1; }
  };
  const documentRef = {
    addEventListener() {},
    getElementById: (id) => (id === "retry-button" ? retryButton : null),
    readyState: "complete"
  };
  const locationRef = {
    replace: (target) => replacements.push(target),
    search
  };
  const windowRef = {};
  vm.runInNewContext(source, {
    URLSearchParams,
    document: documentRef,
    location: locationRef,
    window: windowRef
  });
  return {
    click: () => clickHandler?.(),
    focusCalls,
    replacements,
    windowRef
  };
}

test("renderer recovery page is a self-contained Chinese fallback", () => {
  const html = fs.readFileSync(
    path.join(root, "src/renderer/recovery/renderer-crashed.html"),
    "utf8"
  );
  const css = fs.readFileSync(
    path.join(root, "src/renderer/styles/renderer-recovery.css"),
    "utf8"
  );

  assert.match(html, /界面需要重新加载/);
  assert.match(html, /后台任务和数据仍然保留/);
  assert.match(html, /id="retry-button"/);
  assert.match(html, /renderer-recovery\.css/);
  assert.match(html, /renderer-recovery\.js/);
  assert.match(css, /\.recovery-shell/);
  assert.match(css, /focus-visible/);
});

test("renderer recovery page retries the correct signed-in or onboarding route", () => {
  const main = loadRecoveryScript("?target=main");
  assert.equal(main.focusCalls, 1);
  main.click();
  assert.deepEqual(main.replacements, ["../index.html"]);
  assert.equal(main.windowRef.miaRendererRecovery.retryTarget("?target=main"), "../index.html");
  assert.equal(
    main.windowRef.miaRendererRecovery.retryTarget("?target=onboarding"),
    "../onboarding/onboarding.html"
  );
});

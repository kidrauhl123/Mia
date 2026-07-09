const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function createElement({ name = "welcome", trigger = "loop", visible = true } = {}) {
  const listeners = {};
  return {
    tagName: "DIV",
    dataset: { lottie: name, lottieTrigger: trigger },
    isConnected: true,
    children: [],
    getClientRects: () => (visible ? [{}] : []),
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "[data-lottie]") return [this];
      return [];
    },
    closest: () => null,
    contains(child) { return child === this; },
    addEventListener(event, callback) { listeners[event] = callback; },
    dispatch(event) { listeners[event]?.(); },
  };
}

function loadLottieIcons(containers) {
  const loadCalls = [];
  const played = [];
  const paused = [];
  const stopped = [];
  const listeners = {};
  const timers = [];
  const document = {
    hidden: false,
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector === "[data-lottie]") return containers;
      return [];
    },
  };
  const window = {
    document,
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    setTimeout(callback, ms) {
      timers.push({ callback, ms });
      return timers.length;
    },
    clearTimeout(id) {
      const timer = timers[id - 1];
      if (timer) timer.cleared = true;
    },
    lottie: {
      loadAnimation(config) {
        loadCalls.push(config);
        const anim = {
          totalFrames: 30,
          addEventListener(event, callback) {
            listeners[event] = callback;
            if (event === "DOMLoaded") callback();
          },
          goToAndStop(frame) { stopped.push(frame); },
          goToAndPlay(frame) { played.push(`${config.container.dataset.lottie}:${frame}`); },
          setDirection() {},
          playSegments(segment) { played.push({ name: config.container.dataset.lottie, segment }); },
          play() { played.push(config.container.dataset.lottie); },
          pause() { paused.push(config.container.dataset.lottie); },
          destroy() {},
        };
        return anim;
      },
    },
  };
  const context = vm.createContext({
    window,
    document,
    globalThis: window,
    IntersectionObserver: undefined,
    console,
  });
  const source = fs.readFileSync(path.join(root, "src/renderer/lottie-icons.js"), "utf8");
  vm.runInContext(source, context, { filename: "src/renderer/lottie-icons.js" });
  return { api: window.miaLottieIcons, loadCalls, played, paused, stopped, timers };
}

test("hidden loop lotties are not mounted during global init", () => {
  const hidden = createElement({ visible: false, trigger: "loop" });
  const { api, loadCalls } = loadLottieIcons([hidden]);

  api.init();

  assert.equal(loadCalls.length, 0);
});

test("visible loop lotties opt out of autoplay and start through visibility sync", () => {
  const visible = createElement({ visible: true, trigger: "loop" });
  const { api, loadCalls, played } = loadLottieIcons([visible]);

  api.init();

  assert.equal(loadCalls.length, 1);
  assert.equal(loadCalls[0].loop, true);
  assert.equal(loadCalls[0].autoplay, false);
  assert.deepEqual(played, ["welcome"]);
});

test("ambient lotties render to canvas and schedule playback without hover dependency", () => {
  const visible = createElement({ name: "sparkle", visible: true, trigger: "ambient" });
  const { api, loadCalls, played, stopped, timers } = loadLottieIcons([visible]);

  api.init();

  assert.equal(loadCalls.length, 1);
  assert.equal(loadCalls[0].renderer, "canvas");
  assert.equal(loadCalls[0].loop, false);
  assert.equal(loadCalls[0].autoplay, false);
  assert.deepEqual(stopped, [0]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1800);

  visible.dispatch("mouseenter");

  assert.equal(played.length, 0);

  timers[0].callback();

  assert.equal(played.length, 1);
  assert.equal(played[0].name, "sparkle");
  assert.deepEqual(Array.from(played[0].segment), [0, 29]);
});

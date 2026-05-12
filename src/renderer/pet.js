const params = new URLSearchParams(window.location.search);
const sheet = params.get("sheet") || "";
const sprite = document.getElementById("petSprite");
const bubble = document.getElementById("petBubble");
let activeFrames = "idle";
let idleVariant = "idle";
let bubbleTimer = null;

const framesByState = {
  idle: [
    { col: 0, row: 0, ms: 1800 },
    { col: 1, row: 0, ms: 160 },
    { col: 2, row: 0, ms: 140 },
    { col: 1, row: 0, ms: 160 },
    { col: 0, row: 0, ms: 1900 },
    { col: 3, row: 0, ms: 180 },
    { col: 4, row: 0, ms: 180 },
    { col: 5, row: 0, ms: 420 }
  ],
  review: [
    { col: 0, row: 8, ms: 180 },
    { col: 1, row: 8, ms: 180 },
    { col: 2, row: 8, ms: 180 },
    { col: 3, row: 8, ms: 180 },
    { col: 4, row: 8, ms: 180 },
    { col: 5, row: 8, ms: 420 }
  ],
  waving: [
    { col: 0, row: 3, ms: 180 },
    { col: 1, row: 3, ms: 180 },
    { col: 2, row: 3, ms: 180 },
    { col: 3, row: 3, ms: 520 }
  ],
  waiting: [
    { col: 0, row: 6, ms: 220 },
    { col: 1, row: 6, ms: 220 },
    { col: 2, row: 6, ms: 220 },
    { col: 3, row: 6, ms: 220 },
    { col: 4, row: 6, ms: 220 },
    { col: 5, row: 6, ms: 520 }
  ],
  jumping: [
    { col: 0, row: 4, ms: 170 },
    { col: 1, row: 4, ms: 170 },
    { col: 2, row: 4, ms: 170 },
    { col: 3, row: 4, ms: 170 },
    { col: 4, row: 4, ms: 520 }
  ]
};
const ambientStates = ["waiting", "review", "waving", "jumping"];

function framePosition(frame) {
  return `${(frame.col / 7) * 100}% ${(frame.row / 8) * 100}%`;
}

function chooseAmbientState() {
  return ambientStates[Math.floor(Math.random() * ambientStates.length)] || "waiting";
}

function tick(index = 0) {
  if (!sprite) return;
  const state = activeFrames === "idle" ? idleVariant : activeFrames;
  const frames = framesByState[state] || framesByState.idle;
  const frame = frames[index % frames.length];
  sprite.style.backgroundPosition = framePosition(frame);
  const isCycleEnd = index % frames.length === frames.length - 1;
  window.setTimeout(() => {
    if (activeFrames !== "idle") {
      tick(index + 1);
      return;
    }
    if (idleVariant !== "idle" && isCycleEnd) {
      idleVariant = "idle";
      tick(0);
      return;
    }
    if (idleVariant === "idle" && isCycleEnd && Math.random() < 0.18) {
      idleVariant = chooseAmbientState();
      tick(0);
      return;
    }
    tick(index + 1);
  }, frame.ms);
}

function messageDuration(text, requestedMs) {
  const base = Math.max(2200, Number(requestedMs) || 7000);
  return Math.min(28000, Math.max(base, 4200 + text.length * 70));
}

function showMessage(payload = {}) {
  if (!bubble) return;
  const text = String(payload.text || "").trim();
  if (!text) return;
  const duration = messageDuration(text, payload.durationMs);
  bubble.innerHTML = "";
  const textEl = document.createElement("div");
  textEl.className = "pet-bubble-text";
  textEl.textContent = text;
  bubble.appendChild(textEl);
  bubble.classList.remove("hidden");
  activeFrames = "review";
  idleVariant = "idle";
  window.requestAnimationFrame(() => {
    const overflow = textEl.scrollHeight - textEl.clientHeight;
    if (overflow > 2) {
      textEl.style.setProperty("--pet-scroll-distance", `${-overflow}px`);
      textEl.style.animationDuration = `${Math.max(1600, duration - 1800)}ms`;
      textEl.classList.add("scrolling");
    }
  });
  if (bubbleTimer) window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    bubble.classList.add("hidden");
    activeFrames = "idle";
  }, duration);
}

if (sprite && sheet) {
  sprite.style.backgroundImage = `url("${sheet.replaceAll('"', "%22")}")`;
  tick();
}

window.aimashiPet?.onMessage?.(showMessage);

const params = new URLSearchParams(window.location.search);
const sheet = params.get("sheet") || "";
const sprite = document.getElementById("petSprite");

const idleFrames = [
  { col: 0, row: 0, ms: 280 },
  { col: 1, row: 0, ms: 110 },
  { col: 2, row: 0, ms: 110 },
  { col: 3, row: 0, ms: 140 },
  { col: 4, row: 0, ms: 140 },
  { col: 5, row: 0, ms: 320 }
];

function framePosition(frame) {
  return `${(frame.col / 7) * 100}% ${(frame.row / 8) * 100}%`;
}

function tick(index = 0) {
  if (!sprite) return;
  const frame = idleFrames[index % idleFrames.length];
  sprite.style.backgroundPosition = framePosition(frame);
  window.setTimeout(() => tick(index + 1), frame.ms);
}

if (sprite && sheet) {
  sprite.style.backgroundImage = `url("${sheet.replaceAll('"', "%22")}")`;
  tick();
}

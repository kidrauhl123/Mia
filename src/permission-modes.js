const PERMISSION_LABELS = {
  ask: "Ask",
  yolo: "YOLO",
  deny: "Deny",
  smart: "Smart"
};

function normalizePermissionMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (["manual", "ask", "default"].includes(raw)) return "ask";
  if (["off", "yolo", "allow"].includes(raw)) return "yolo";
  if (["deny", "denied"].includes(raw)) return "deny";
  if (["smart", "auto"].includes(raw)) return "smart";
  return "ask";
}

function permissionModeLabel(value) {
  const mode = normalizePermissionMode(value);
  return PERMISSION_LABELS[mode] || "Ask";
}

module.exports = {
  normalizePermissionMode,
  permissionModeLabel
};

const crypto = require("node:crypto");

function base64url(value) {
  return Buffer.from(String(value)).toString("base64url");
}

function fromBase64url(value) {
  return Buffer.from(String(value || ""), "base64url").toString("utf8");
}

function signature(secret, userId) {
  return crypto.createHmac("sha256", String(secret)).update(String(userId)).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createUserModelProxyToken(secret, userId) {
  const key = String(secret || "").trim();
  const id = String(userId || "").trim();
  if (!key) return "";
  if (!id) return "";
  return `mia-user.${base64url(id)}.${signature(key, id)}`;
}

function verifyUserModelProxyToken(secret, token) {
  const key = String(secret || "").trim();
  const raw = String(token || "").trim();
  if (!key || !raw.startsWith("mia-user.")) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const userId = fromBase64url(parts[1]);
  if (!userId) return null;
  return safeEqual(parts[2], signature(key, userId)) ? userId : null;
}

module.exports = {
  createUserModelProxyToken,
  verifyUserModelProxyToken
};

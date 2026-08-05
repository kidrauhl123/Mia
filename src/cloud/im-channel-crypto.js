"use strict";

const crypto = require("node:crypto");

function secretBoxUnavailableError() {
  const error = new Error("服务器未配置 MIA_IM_ENCRYPTION_KEY，无法保存或读取 IM 凭据。");
  error.code = "MIA_IM_ENCRYPTION_KEY_REQUIRED";
  error.status = 503;
  return error;
}

function malformedSecretError() {
  const error = new Error("IM 通道凭据无法读取，请重新保存凭据。");
  error.code = "MIA_IM_CHANNEL_SECRET_MALFORMED";
  error.status = 503;
  return error;
}

function createImChannelSecretBox(keyMaterial = "") {
  const source = String(keyMaterial || "").trim();
  const key = source ? crypto.createHash("sha256").update(source).digest() : null;

  function assertAvailable() {
    if (!key) throw secretBoxUnavailableError();
  }

  function encryptJson(value = {}) {
    assertAvailable();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify(value || {}), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  function decryptJson(value = "") {
    assertAvailable();
    const parts = String(value || "").split(".");
    if (parts.length !== 4 || parts[0] !== "v1") throw malformedSecretError();
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
      decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parts[3], "base64url")),
        decipher.final()
      ]).toString("utf8");
      const parsed = JSON.parse(plaintext);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw malformedSecretError();
      return parsed;
    } catch (error) {
      if (error?.code === "MIA_IM_CHANNEL_SECRET_MALFORMED") throw error;
      throw malformedSecretError();
    }
  }

  return Object.freeze({
    available: Boolean(key),
    encryptJson,
    decryptJson
  });
}

module.exports = {
  createImChannelSecretBox,
  malformedSecretError,
  secretBoxUnavailableError
};

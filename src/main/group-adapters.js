function buildHermesGroupHeader(contextBlock) {
  if (!contextBlock) return "";
  const payload = JSON.stringify({ v: 1, contextBlock });
  return Buffer.from(payload, "utf8").toString("base64");
}

function injectGroupContextForSdk(userMessage, contextBlock) {
  if (!contextBlock) return userMessage;
  return contextBlock + "\n\n" + userMessage;
}

module.exports = { buildHermesGroupHeader, injectGroupContextForSdk };

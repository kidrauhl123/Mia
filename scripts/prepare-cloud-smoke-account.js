#!/usr/bin/env node

function usage() {
  return [
    "Usage: node scripts/prepare-cloud-smoke-account.js <cloud-url>",
    "",
    "Validates the Mia Cloud bearer token that will be used by production smoke.",
    "",
    "Environment:",
    "  MIA_CLOUD_TOKEN=<token>  Required smoke account bearer token from WeChat login."
  ].join("\n");
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error(usage());
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Cloud URL must be http or https.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function jsonRequest(baseUrl, path, { method = "GET", token = "", body = null, fetchImpl = fetch } = {}) {
  const headers = { Origin: baseUrl };
  if (body !== null) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function smokeTokenEnv(env = process.env) {
  const token = String(env.MIA_CLOUD_TOKEN || "").trim();
  if (!token) throw new Error("MIA_CLOUD_TOKEN is required.");
  return { token };
}

async function prepareSmokeAccount({
  publicUrl,
  token,
  fetchImpl = fetch
}) {
  const baseUrl = normalizeBaseUrl(publicUrl);
  const me = await jsonRequest(baseUrl, "/api/me", { token, fetchImpl });
  if (!me.response.ok || !me.data.user?.id) {
    throw new Error(`Smoke account token check failed: HTTP ${me.response.status} ${me.data.error || ""}`.trim());
  }

  const devices = await jsonRequest(baseUrl, "/api/bridge/devices", { token, fetchImpl });
  if (!devices.response.ok) {
    throw new Error(`Smoke account bridge device check failed: HTTP ${devices.response.status} ${devices.data.error || ""}`.trim());
  }
  return {
    baseUrl,
    user: me.data.user,
    deviceCount: Array.isArray(devices.data.devices) ? devices.data.devices.length : 0
  };
}

function printResult(result) {
  const label = result.user.displayName || result.user.username || result.user.id;
  console.log(`OK smoke account - ${label}`);
  console.log(`OK bridge devices - ${result.deviceCount} online for ${label}`);
  console.log("");
  console.log("Use this same WeChat account in the desktop app before running:");
  console.log("```bash");
  console.log("MIA_CLOUD_TOKEN='<smoke-account-token>' \\");
  console.log("npm run cloud:prod:verify:e2e -- " + result.baseUrl);
  console.log("```");
  console.log("");
  console.log("For the standalone local Agent bridge from a full Mia checkout:");
  console.log("```bash");
  console.log(`MIA_CLOUD_URL='${result.baseUrl.replace(/'/g, "'\\''")}' \\`);
  console.log("MIA_CLOUD_TOKEN='<smoke-account-token>' \\");
  console.log("npm run bridge");
  console.log("```");
  console.log("");
  console.log("This command does not print the bearer token.");
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const positional = process.argv.slice(2).filter((arg) => !String(arg).startsWith("-"));
  const { token } = smokeTokenEnv();
  const result = await prepareSmokeAccount({
    publicUrl: positional[0] || process.env.MIA_CLOUD_PUBLIC_URL,
    token
  });
  printResult(result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeBaseUrl,
  prepareSmokeAccount,
  smokeTokenEnv
};

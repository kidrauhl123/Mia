#!/usr/bin/env node

function usage() {
  return [
    "Usage: node scripts/prepare-cloud-smoke-account.js <cloud-url>",
    "",
    "Ensures the fixed production smoke account exists and the supplied password can log in.",
    "",
    "Environment:",
    "  MIA_SMOKE_USERNAME=<account>   Required fixed smoke account username.",
    "  MIA_SMOKE_PASSWORD=<password>  Required fixed smoke account password."
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

function smokeAccountEnv(env = process.env) {
  const username = String(env.MIA_SMOKE_USERNAME || "").trim();
  const password = String(env.MIA_SMOKE_PASSWORD || "");
  if (!username || !password) {
    throw new Error("MIA_SMOKE_USERNAME and MIA_SMOKE_PASSWORD are required.");
  }
  return { username, password };
}

async function loginOrRegisterSmokeAccount({
  baseUrl,
  username,
  password,
  fetchImpl = fetch
}) {
  const login = await jsonRequest(baseUrl, "/api/auth/login", {
    method: "POST",
    body: { username, password },
    fetchImpl
  });
  if (login.response.ok) return { action: "login", account: login.data };

  if (login.response.status !== 401) {
    throw new Error(`Smoke account login failed: HTTP ${login.response.status} ${login.data.error || ""}`.trim());
  }

  const registration = await jsonRequest(baseUrl, "/api/auth/register", {
    method: "POST",
    body: { username, password },
    fetchImpl
  });
  if (registration.response.ok) return { action: "register", account: registration.data };

  if (registration.response.status === 409) {
    throw new Error("Smoke account already exists but the supplied password did not log in.");
  }
  throw new Error(`Smoke account registration failed: HTTP ${registration.response.status} ${registration.data.error || ""}`.trim());
}

async function prepareSmokeAccount({
  publicUrl,
  username,
  password,
  fetchImpl = fetch
}) {
  const baseUrl = normalizeBaseUrl(publicUrl);
  const result = await loginOrRegisterSmokeAccount({ baseUrl, username, password, fetchImpl });
  const token = String(result.account.token || "");
  if (!token) throw new Error("Smoke account response did not include a bearer token.");

  const devices = await jsonRequest(baseUrl, "/api/bridge/devices", { token, fetchImpl });
  if (!devices.response.ok) {
    throw new Error(`Smoke account bridge device check failed: HTTP ${devices.response.status} ${devices.data.error || ""}`.trim());
  }
  return {
    baseUrl,
    username,
    action: result.action,
    deviceCount: Array.isArray(devices.data.devices) ? devices.data.devices.length : 0
  };
}

function printResult(result) {
  console.log(`OK smoke account - ${result.action} ${result.username}`);
  console.log(`OK bridge devices - ${result.deviceCount} online for ${result.username}`);
  console.log("");
  console.log("Log the desktop app into this same account before running:");
  console.log("```bash");
  console.log("MIA_SMOKE_USERNAME='<smoke-account>' \\");
  console.log("MIA_SMOKE_PASSWORD='<same-password>' \\");
  console.log("npm run cloud:prod:verify:e2e -- " + result.baseUrl);
  console.log("```");
  console.log("");
  console.log("For the standalone local Agent bridge from a full Mia checkout:");
  console.log("```bash");
  console.log(`MIA_CLOUD_URL='${result.baseUrl.replace(/'/g, "'\\''")}' \\`);
  console.log("MIA_CLOUD_USERNAME='<smoke-account>' \\");
  console.log("MIA_CLOUD_PASSWORD='<same-password>' \\");
  console.log("npm run bridge");
  console.log("```");
  console.log("");
  console.log("This command does not print the supplied password or bearer token.");
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const positional = process.argv.slice(2).filter((arg) => !String(arg).startsWith("-"));
  const { username, password } = smokeAccountEnv();
  const result = await prepareSmokeAccount({
    publicUrl: positional[0] || process.env.MIA_CLOUD_PUBLIC_URL,
    username,
    password
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
  loginOrRegisterSmokeAccount,
  normalizeBaseUrl,
  prepareSmokeAccount,
  smokeAccountEnv
};

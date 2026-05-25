"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createAuthService({
  runtimePaths,
  readJson,
  fetchImpl = fetch,
  spawnProcess,
  shellOpenExternal,
  initializeRuntime,
  isEngineInstalled,
  getRuntimeStatus,
  enginePython,
  effectiveHermesHome,
  buildPythonPath,
  applyCodexModelSettings,
  saveProviderConnection,
  restartEngineIfRunning,
  codexClientId = "app_EMoamEEZ73f0CkXaXp7hrann",
  codexDeviceUrl = "https://auth.openai.com/codex/device",
  codexTokenUrl = "https://auth.openai.com/oauth/token",
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowIso = () => new Date().toISOString(),
  nowMs = () => Date.now()
}) {
  let authProcess = null;
  let codexOAuthCancelled = false;
  let activeCompletion = Promise.resolve();
  let authState = {
    codexStarting: false,
    codexLoggedIn: false,
    oauthProvider: "",
    oauthProviderLabel: "",
    codexLastError: "",
    codexUserCode: "",
    codexVerificationUrl: codexDeviceUrl,
    logs: []
  };

  function appendLog(line) {
    const clean = String(line)
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/(access_token|refresh_token)["']?\s*[:=]\s*["']?[^"',\s]+/gi, "$1=[REDACTED]");
    const codeMatch = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/);
    if (codeMatch) authState.codexUserCode = codeMatch[0];
    const urlMatch = clean.match(/https?:\/\/[^\s)]+/);
    if (urlMatch) authState.codexVerificationUrl = urlMatch[0];
    authState.logs.push(clean);
    if (authState.logs.length > 240) authState.logs = authState.logs.slice(-240);
  }

  function status() {
    const p = runtimePaths();
    const auth = readJson(p.authJson, {});
    const providers = auth && typeof auth.providers === "object" ? auth.providers : {};
    const codexState = providers ? providers["openai-codex"] : null;
    let poolCount = 0;
    const pool = auth && typeof auth.credential_pool === "object" ? auth.credential_pool : {};
    const codexPool = pool ? pool["openai-codex"] : null;
    if (Array.isArray(codexPool?.entries)) poolCount = codexPool.entries.length;
    else if (Array.isArray(codexPool)) poolCount = codexPool.length;

    const providerTokens = Boolean(codexState?.tokens?.access_token);
    const loggedIn = providerTokens || poolCount > 0;
    authState.codexLoggedIn = loggedIn;
    return {
      codexStarting: authState.codexStarting,
      codexLoggedIn: loggedIn,
      oauthProvider: authState.oauthProvider,
      oauthProviderLabel: authState.oauthProviderLabel,
      codexAuthPath: p.authJson,
      codexVerificationUrl: authState.codexVerificationUrl,
      codexUserCode: authState.codexUserCode,
      codexLastError: authState.codexLastError,
      codexLogs: authState.logs.slice(-120)
    };
  }

  function saveCodexTokens(tokens) {
    const p = runtimePaths();
    const auth = readJson(p.authJson, { version: 2, providers: {} });
    if (!auth || typeof auth !== "object") throw new Error("Invalid auth store.");
    if (!auth.providers || typeof auth.providers !== "object") auth.providers = {};
    auth.providers["openai-codex"] = {
      ...(auth.providers["openai-codex"] || {}),
      tokens,
      last_refresh: nowIso().replace("+00:00", "Z"),
      auth_mode: "chatgpt"
    };
    auth.active_provider = "openai-codex";
    auth.version = auth.version || 2;
    auth.updated_at = nowIso();
    fs.mkdirSync(path.dirname(p.authJson), { recursive: true });
    fs.writeFileSync(p.authJson, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  }

  async function requestCodexDeviceCode() {
    const response = await fetchImpl("https://auth.openai.com/api/accounts/deviceauth/usercode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: codexClientId })
    });
    if (!response.ok) {
      throw new Error(`Device code request failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data.user_code || !data.device_auth_id) {
      throw new Error("Device code response missing user_code or device_auth_id.");
    }
    return data;
  }

  async function pollCodexAuthorization(deviceAuthId, userCode, intervalSeconds) {
    const intervalMs = Math.max(3000, Number(intervalSeconds || 5) * 1000);
    const started = nowMs();
    while (!codexOAuthCancelled && nowMs() - started < 15 * 60 * 1000) {
      await sleep(intervalMs);
      const response = await fetchImpl("https://auth.openai.com/api/accounts/deviceauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_auth_id: deviceAuthId,
          user_code: userCode
        })
      });
      if (response.ok) return response.json();
      if (response.status === 403 || response.status === 404) continue;
      throw new Error(`Device auth polling failed: ${response.status} ${response.statusText}`);
    }
    if (codexOAuthCancelled) throw new Error("Codex OAuth cancelled.");
    throw new Error("Codex OAuth timed out after 15 minutes.");
  }

  async function exchangeCodexTokens(codeResponse) {
    const authorizationCode = codeResponse.authorization_code || "";
    const codeVerifier = codeResponse.code_verifier || "";
    if (!authorizationCode || !codeVerifier) {
      throw new Error("Device auth response missing authorization_code or code_verifier.");
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: authorizationCode,
      redirect_uri: "https://auth.openai.com/deviceauth/callback",
      client_id: codexClientId,
      code_verifier: codeVerifier
    });
    const response = await fetchImpl(codexTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });
    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status} ${response.statusText}`);
    }
    const tokens = await response.json();
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("Token exchange did not return access_token and refresh_token.");
    }
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token
    };
  }

  async function finishCodexOAuth(deviceData) {
    try {
      const codeResponse = await pollCodexAuthorization(
        deviceData.device_auth_id,
        deviceData.user_code,
        deviceData.interval
      );
      const tokens = await exchangeCodexTokens(codeResponse);
      saveCodexTokens(tokens);
      applyCodexModelSettings();
      authState.codexStarting = false;
      authState.codexLoggedIn = true;
      authState.codexUserCode = "";
      authState.oauthProvider = "";
      authState.oauthProviderLabel = "";
      appendLog("OpenAI Codex OAuth login completed.");
      await restartEngineIfRunning();
    } catch (error) {
      authState.codexStarting = false;
      if (!codexOAuthCancelled) {
        authState.codexLastError = error.message;
        appendLog(`OpenAI Codex OAuth failed: ${error.message}`);
      }
    } finally {
      authProcess = null;
    }
  }

  async function startCodexOAuth() {
    initializeRuntime();
    if (!isEngineInstalled()) {
      throw new Error("Hermes engine is not installed in Mia runtime.");
    }
    if (authProcess || authState.codexStarting) return getRuntimeStatus();

    codexOAuthCancelled = false;
    authState = {
      ...authState,
      codexStarting: true,
      oauthProvider: "openai-codex",
      oauthProviderLabel: "OpenAI Codex",
      codexLastError: "",
      codexUserCode: "",
      codexVerificationUrl: codexDeviceUrl,
      logs: []
    };
    appendLog("Requesting OpenAI Codex device code...");
    const deviceData = await requestCodexDeviceCode();
    authState.codexUserCode = String(deviceData.user_code || "");
    appendLog(`Open ${codexDeviceUrl}`);
    appendLog(`Enter device code: ${authState.codexUserCode}`);
    shellOpenExternal(codexDeviceUrl).catch(() => {});
    authProcess = { kind: "codex-oauth" };
    activeCompletion = finishCodexOAuth(deviceData);

    return getRuntimeStatus();
  }

  function cancelCodexOAuth() {
    codexOAuthCancelled = true;
    if (authProcess && typeof authProcess.kill === "function") {
      authProcess.kill("SIGTERM");
    }
    authProcess = null;
    authState.codexStarting = false;
    authState.codexUserCode = "";
    authState.oauthProvider = "";
    authState.oauthProviderLabel = "";
    appendLog("OpenAI Codex OAuth cancelled.");
    return getRuntimeStatus();
  }

  async function handleProviderExit({ provider, providerLabel, input, code, signal }) {
    const completedProvider = provider;
    authState.codexStarting = false;
    authProcess = null;
    if (code === 0) {
      saveProviderConnection({
        provider: completedProvider,
        providerLabel,
        authType: input.authType || "oauth_external",
        apiKeyEnv: "",
        apiKey: "",
        baseUrl: input.baseUrl || "",
        apiMode: input.apiMode || ""
      });
      appendLog(`${providerLabel} OAuth login completed.`);
      authState.oauthProvider = "";
      authState.oauthProviderLabel = "";
      try {
        await restartEngineIfRunning();
      } catch (error) {
        appendLog(`Restart after OAuth failed: ${error.message}`);
      }
    } else if (!codexOAuthCancelled) {
      authState.codexLastError = `${providerLabel} OAuth exited with code ${code ?? "null"} signal ${signal ?? "null"}`;
      appendLog(authState.codexLastError);
    }
  }

  function startProviderOAuth(input = {}) {
    initializeRuntime();
    if (!isEngineInstalled()) {
      throw new Error("Hermes engine is not installed in Mia runtime.");
    }
    const provider = String(input.provider || "").trim();
    if (!provider) throw new Error("Provider is required.");
    if (provider === "openai-codex") return startCodexOAuth();
    if (authProcess || authState.codexStarting) return getRuntimeStatus();

    const p = runtimePaths();
    const providerLabel = String(input.providerLabel || provider).trim();
    codexOAuthCancelled = false;
    authState = {
      ...authState,
      codexStarting: true,
      oauthProvider: provider,
      oauthProviderLabel: providerLabel,
      codexLastError: "",
      codexUserCode: "",
      codexVerificationUrl: "",
      logs: []
    };
    appendLog(`Starting ${providerLabel} OAuth...`);

    const args = ["-m", "hermes_cli.main", "auth", "add", provider, "--type", "oauth"];
    authProcess = spawnProcess(enginePython(), args, {
      cwd: p.engine,
      env: {
        ...process.env,
        HERMES_HOME: effectiveHermesHome(),
        MIA_HOME: p.home,
        PYTHONPATH: buildPythonPath()
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const onOutput = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) appendLog(line);
    };
    authProcess.stdout.on("data", onOutput);
    authProcess.stderr.on("data", onOutput);
    authProcess.on("exit", (code, signal) => {
      activeCompletion = handleProviderExit({ provider, providerLabel, input, code, signal });
    });
    return getRuntimeStatus();
  }

  function cancelProviderOAuth() {
    if (authState.oauthProvider === "openai-codex" || !authState.oauthProvider) return cancelCodexOAuth();
    codexOAuthCancelled = true;
    if (authProcess && typeof authProcess.kill === "function") authProcess.kill("SIGTERM");
    authProcess = null;
    authState.codexStarting = false;
    authState.codexUserCode = "";
    authState.oauthProvider = "";
    authState.oauthProviderLabel = "";
    appendLog("OAuth cancelled.");
    return getRuntimeStatus();
  }

  async function waitForIdle() {
    await activeCompletion;
  }

  return {
    appendLog,
    status,
    startCodexOAuth,
    cancelCodexOAuth,
    startProviderOAuth,
    cancelProviderOAuth,
    waitForIdle
  };
}

module.exports = {
  createAuthService
};

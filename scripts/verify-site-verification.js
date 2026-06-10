#!/usr/bin/env node

const SITE_VERIFICATION_FILE = "5a371047c22c89872f93f00c7d8af123.txt";
const SITE_VERIFICATION_CONTENT = "24dd5141e8f881adf83372da5cd9d6f1f60f2b32";

function usage() {
  return [
    "Usage: node scripts/verify-site-verification.js [cloud-url]",
    "",
    "Fetches the required root-level site verification txt file and checks its exact content.",
    "",
    "Examples:",
    "  node scripts/verify-site-verification.js https://mia.gifgif.cn"
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

function siteVerificationUrl(publicUrl) {
  return `${normalizeBaseUrl(publicUrl)}/${SITE_VERIFICATION_FILE}`;
}

async function verifySiteVerification({
  publicUrl = process.env.MIA_CLOUD_PUBLIC_URL || "https://mia.gifgif.cn",
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This verifier requires a Node.js runtime with global fetch support.");
  }

  const url = siteVerificationUrl(publicUrl);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(new Error(`Timed out fetching ${url}`)), timeoutMs)
    : null;
  try {
    const response = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    if (!response || !response.ok) {
      throw new Error(`Site verification fetch failed for ${url}: HTTP ${response?.status || "unknown"}`);
    }
    const text = await response.text();
    if (text.trim() !== SITE_VERIFICATION_CONTENT) {
      throw new Error(`Site verification content mismatch for ${url}.`);
    }
    console.log(`Mia site verification passed: ${url}`);
    return { url, content: SITE_VERIFICATION_CONTENT };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const positional = process.argv.slice(2).filter((arg) => !String(arg).startsWith("-"));
  try {
    await verifySiteVerification({ publicUrl: positional[0] || process.env.MIA_CLOUD_PUBLIC_URL });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SITE_VERIFICATION_CONTENT,
  SITE_VERIFICATION_FILE,
  normalizeBaseUrl,
  siteVerificationUrl,
  verifySiteVerification
};

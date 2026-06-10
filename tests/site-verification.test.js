const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  SITE_VERIFICATION_CONTENT,
  SITE_VERIFICATION_FILE,
  normalizeBaseUrl,
  siteVerificationUrl,
  verifySiteVerification
} = require("../scripts/verify-site-verification.js");

test("site verification URL is always rooted at the public base URL", () => {
  assert.equal(normalizeBaseUrl("https://mia.gifgif.cn/app/../"), "https://mia.gifgif.cn");
  assert.equal(siteVerificationUrl("https://mia.gifgif.cn/"), `https://mia.gifgif.cn/${SITE_VERIFICATION_FILE}`);
  assert.throws(() => siteVerificationUrl("file:///tmp/mia"), /Cloud URL must be http or https/);
});

test("site verification accepts the exact txt content", async () => {
  const calls = [];
  const result = await verifySiteVerification({
    publicUrl: "https://mia.gifgif.cn",
    timeoutMs: 1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => `${SITE_VERIFICATION_CONTENT}\n`
      };
    }
  });

  assert.equal(result.url, `https://mia.gifgif.cn/${SITE_VERIFICATION_FILE}`);
  assert.equal(result.content, SITE_VERIFICATION_CONTENT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://mia.gifgif.cn/${SITE_VERIFICATION_FILE}`);
});

test("site verification rejects missing or mismatched txt content", async () => {
  await assert.rejects(
    () => verifySiteVerification({
      publicUrl: "https://mia.gifgif.cn",
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" })
    }),
    /HTTP 404/
  );

  await assert.rejects(
    () => verifySiteVerification({
      publicUrl: "https://mia.gifgif.cn",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "wrong" })
    }),
    /content mismatch/
  );
});

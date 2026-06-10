const assert = require("node:assert/strict");
const { test } = require("node:test");

const { sanitizeCssColor } = require("../src/cloud/css-color.js");

test("keeps safe color literals", () => {
  for (const value of ["#fff", "#ffaa00", "#ffaa0080", "rgb(10, 20, 30)", "rgba(10,20,30,0.5)", "hsl(200 50% 40%)", "red", "transparent", "currentColor"]) {
    assert.equal(sanitizeCssColor(value), value, `expected ${value} to pass`);
  }
});

test("drops style-breaking / injection payloads", () => {
  for (const value of [
    'red"></span><img src=x onerror=alert(1)>',
    "red; background:url(javascript:alert(1))",
    "url(http://evil)",
    "expression(alert(1))",
    "#fff;}",
    "rgb(0,0,0); position:fixed",
    "</style>"
  ]) {
    assert.equal(sanitizeCssColor(value), "", `expected ${JSON.stringify(value)} to be dropped`);
  }
});

test("normalizes empty / oversized input to empty string", () => {
  assert.equal(sanitizeCssColor(""), "");
  assert.equal(sanitizeCssColor(null), "");
  assert.equal(sanitizeCssColor(undefined), "");
  assert.equal(sanitizeCssColor("a".repeat(65)), "");
});

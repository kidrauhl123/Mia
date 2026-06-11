import { isDeprecatedApiBase } from "../src/logic/apiBase";

test("flags decommissioned backends regardless of scheme / trailing slash", () => {
  expect(isDeprecatedApiBase("https://aiweb.buytb01.com")).toBe(true);
  expect(isDeprecatedApiBase("https://aiweb.buytb01.com/")).toBe(true);
  expect(isDeprecatedApiBase("http://aiweb.buytb01.com")).toBe(true);
  expect(isDeprecatedApiBase("HTTPS://AIWEB.BUYTB01.COM")).toBe(true);
});

test("keeps the current default and custom servers", () => {
  expect(isDeprecatedApiBase("https://mia.gifgif.cn")).toBe(false);
  expect(isDeprecatedApiBase("https://my-own-server.example.com")).toBe(false);
});

test("treats empty / nullish apiBase as not deprecated", () => {
  expect(isDeprecatedApiBase("")).toBe(false);
  expect(isDeprecatedApiBase(null)).toBe(false);
  expect(isDeprecatedApiBase(undefined)).toBe(false);
});

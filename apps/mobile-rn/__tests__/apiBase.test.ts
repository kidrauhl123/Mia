import { isDeprecatedApiBase } from "../src/logic/apiBase";

const retiredRoot = "buy" + "tb01";
const retiredHost = ["aiweb", retiredRoot, "com"].join(".");

test("flags decommissioned backends regardless of scheme / trailing slash", () => {
  expect(isDeprecatedApiBase(`https://${retiredHost}`)).toBe(true);
  expect(isDeprecatedApiBase(`https://${retiredHost}/`)).toBe(true);
  expect(isDeprecatedApiBase(`http://${retiredHost}`)).toBe(true);
  expect(isDeprecatedApiBase(`HTTPS://${retiredHost.toUpperCase()}`)).toBe(true);
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

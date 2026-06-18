import { shouldDisableProductionUpdateChecks } from "../src/updates/updateEnvironment";

test("disables production update checks in the development app variant", () => {
  expect(shouldDisableProductionUpdateChecks("app.mia.mobile", "development")).toBe(true);
});

test("disables production update checks for dev package ids", () => {
  expect(shouldDisableProductionUpdateChecks("app.mia.mobile.dev")).toBe(true);
  expect(shouldDisableProductionUpdateChecks("app.example.dev")).toBe(true);
});

test("keeps production update checks enabled for the release package", () => {
  expect(shouldDisableProductionUpdateChecks("app.mia.mobile", "production")).toBe(false);
  expect(shouldDisableProductionUpdateChecks("app.mia.mobile", "")).toBe(false);
});

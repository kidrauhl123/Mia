import { createMobileUpdateManifestRequest } from "../src/updates/manifestRequest";

test("adds a cache-busting query to every mobile update manifest request", () => {
  const first = createMobileUpdateManifestRequest("https://mia.gifgif.cn/", "first check");
  const second = createMobileUpdateManifestRequest("https://mia.gifgif.cn", "second-check");

  expect(first.url).toBe("https://mia.gifgif.cn/downloads/mia-mobile-update.json?check=first%20check");
  expect(second.url).toBe("https://mia.gifgif.cn/downloads/mia-mobile-update.json?check=second-check");
  expect(first.url).not.toBe(second.url);
});

test("asks every cache layer to revalidate the mobile update manifest", () => {
  const request = createMobileUpdateManifestRequest("https://mia.gifgif.cn", 27);

  expect(request.headers).toEqual({
    Accept: "application/json",
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
  });
});

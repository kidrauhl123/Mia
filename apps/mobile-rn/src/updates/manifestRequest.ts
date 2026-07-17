export interface MobileUpdateManifestRequest {
  url: string;
  headers: Record<string, string>;
}

export function createMobileUpdateManifestRequest(
  apiBase: string,
  nonce: string | number = Date.now()
): MobileUpdateManifestRequest {
  const base = String(apiBase || "").replace(/\/+$/, "");
  const check = encodeURIComponent(String(nonce));
  return {
    url: `${base}/downloads/mia-mobile-update.json?check=${check}`,
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
    },
  };
}

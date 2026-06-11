// Backends we have decommissioned. A persisted session pinned to one of these
// can never reach the current server — its token was issued by the old backend
// and is invalid elsewhere — so the app drops such a session and forces a fresh
// login against the current DEFAULT_API_BASE instead of silently staying on the
// dead domain.
const DEPRECATED_API_HOSTS = [["aiweb", "buy" + "tb01", "com"].join(".")];

export function isDeprecatedApiBase(apiBase: string | null | undefined): boolean {
  const value = String(apiBase || "").toLowerCase();
  return DEPRECATED_API_HOSTS.some((host) => value.includes(host));
}

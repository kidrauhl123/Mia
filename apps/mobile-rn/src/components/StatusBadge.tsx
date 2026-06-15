import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View, type ViewStyle } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { color } from "../theme";
import type { StatusBadge as StatusBadgeT } from "../api/types";
import {
  normalizedStatusBadgeAssetId,
  resolveStatusBadgeAssetUrl,
  safeStatusBadgeAssetId,
  statusBadgeAssetPath,
  statusBadgeAssetsPath,
  statusBadgeCacheFileName,
  type StatusBadgeAssetManifestEntry,
} from "../logic/statusBadgeAssets";

declare const require: any;

let LottieView: any = null;
try {
  // Optional at test time, required in native builds for animated badges.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  LottieView = require("lottie-react-native").default || require("lottie-react-native");
} catch {
  LottieView = null;
}

const manifestCache = new Map<string, Promise<StatusBadgeAssetManifestEntry[]>>();
const lottieUriCache = new Map<string, string>();

function manifestUrl(apiBase: string): string {
  return `${String(apiBase || "").replace(/\/+$/, "")}${statusBadgeAssetsPath()}`;
}

function resolveManifestEntryUrl(entry: StatusBadgeAssetManifestEntry, apiBase: string): string {
  const raw = String(entry.url || "").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${String(apiBase || "").replace(/\/+$/, "")}${raw}`;
  const id = normalizedStatusBadgeAssetId(entry);
  return id ? resolveStatusBadgeAssetUrl(id, apiBase) : "";
}

async function loadManifest(apiBase: string): Promise<StatusBadgeAssetManifestEntry[]> {
  const key = String(apiBase || "").replace(/\/+$/, "");
  if (!manifestCache.has(key)) {
    manifestCache.set(key, fetch(manifestUrl(key), { headers: { Accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : { assets: [] }))
      .then((data) => Array.isArray(data.assets) ? data.assets : []));
  }
  return manifestCache.get(key) || Promise.resolve([]);
}

async function cachedLottieUri(assetId: string, apiBase: string): Promise<string> {
  const safeId = safeStatusBadgeAssetId(assetId);
  if (!safeId) return "";
  const cacheKey = `${String(apiBase || "").replace(/\/+$/, "")}:${safeId}`;
  const cached = lottieUriCache.get(cacheKey);
  if (cached) return cached;
  const assets = await loadManifest(apiBase);
  const entry = assets.find((item) => normalizedStatusBadgeAssetId(item) === safeId) || { id: safeId, url: statusBadgeAssetPath(safeId) };
  const filename = statusBadgeCacheFileName(entry);
  if (!filename) return "";
  const dir = new Directory(Paths.cache, "mia-status-badges");
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  const file = new File(dir, filename);
  if (!file.exists) {
    const url = resolveManifestEntryUrl(entry, apiBase);
    if (!url) return "";
    await File.downloadFileAsync(url, file, { idempotent: true });
  }
  lottieUriCache.set(cacheKey, file.uri);
  return file.uri;
}

export default function StatusBadge({ badge, apiBase, size = 16 }: { badge?: StatusBadgeT | null; apiBase: string; size?: number }) {
  const kind = badge?.kind || "";
  const assetId = badge?.kind === "lottie" ? safeStatusBadgeAssetId(badge.assetId) : "";
  const uriCacheKey = `${String(apiBase || "").replace(/\/+$/, "")}:${assetId}`;
  const [uri, setUri] = useState(() => lottieUriCache.get(uriCacheKey) || "");
  const lottieSource = useMemo(() => (uri ? { uri } : null), [uri]);
  const wrapperStyle: ViewStyle = { width: size + 2, height: size, paddingLeft: 2, transform: [{ translateY: -1 }] };
  const boxStyle: ViewStyle = { width: size, height: size };
  const roundStyle = { borderRadius: size / 2 };

  useEffect(() => {
    let alive = true;
    const cached = lottieUriCache.get(uriCacheKey);
    setUri(cached || "");
    if (!assetId || kind !== "lottie") return () => { alive = false; };
    cachedLottieUri(assetId, apiBase)
      .then((next) => { if (alive) setUri(next); })
      .catch(() => { if (alive) setUri(""); });
    return () => { alive = false; };
  }, [apiBase, assetId, kind, uriCacheKey]);

  if (!badge) return null;
  if (badge.kind === "emoji") {
    return (
      <View style={[styles.wrap, wrapperStyle]}>
        <Text style={[styles.emoji, { width: size, height: size, fontSize: size * 0.95, lineHeight: size }]}>{badge.emoji}</Text>
      </View>
    );
  }
  if (badge.kind === "lottie") {
    if (!assetId) return null;
    if (lottieSource && LottieView) {
      return (
        <View style={[styles.wrap, wrapperStyle]}>
          <LottieView source={lottieSource} autoPlay loop style={[styles.lottie, boxStyle]} />
        </View>
      );
    }
    return (
      <View style={[styles.wrap, wrapperStyle]}>
        <View style={[styles.placeholder, boxStyle, roundStyle]} />
      </View>
    );
  }
  return (
    <View style={[styles.wrap, wrapperStyle]}>
      <View style={[styles.gift, boxStyle, { borderRadius: size * 0.25 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  emoji: { textAlign: "center" },
  lottie: {},
  placeholder: { backgroundColor: "rgba(94,92,230,0.16)" },
  gift: { borderWidth: StyleSheet.hairlineWidth, borderColor: color.inkMuted },
});

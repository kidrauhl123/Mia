import { useEffect, useState } from "react";
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
const lottieDataCache = new Map<string, any>();

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

async function cachedLottieData(assetId: string, apiBase: string): Promise<any> {
  const safeId = safeStatusBadgeAssetId(assetId);
  if (!safeId) return null;
  const cacheKey = `${String(apiBase || "").replace(/\/+$/, "")}:${safeId}`;
  const cached = lottieDataCache.get(cacheKey);
  if (cached) return cached;
  const assets = await loadManifest(apiBase);
  const entry = assets.find((item) => normalizedStatusBadgeAssetId(item) === safeId) || { id: safeId, url: statusBadgeAssetPath(safeId) };
  const filename = statusBadgeCacheFileName(entry);
  if (!filename) return null;
  const dir = new Directory(Paths.cache, "mia-status-badges");
  if (!dir.exists) dir.create({ idempotent: true, intermediates: true });
  const file = new File(dir, filename);
  if (!file.exists) {
    const url = resolveManifestEntryUrl(entry, apiBase);
    if (!url) return null;
    await File.downloadFileAsync(url, file, { idempotent: true });
  }
  const data = JSON.parse(await file.text());
  lottieDataCache.set(cacheKey, data);
  return data;
}

export default function StatusBadge({ badge, apiBase, size = 16 }: { badge?: StatusBadgeT | null; apiBase: string; size?: number }) {
  const kind = badge?.kind || "";
  const assetId = badge?.kind === "lottie" ? safeStatusBadgeAssetId(badge.assetId) : "";
  const uriCacheKey = `${String(apiBase || "").replace(/\/+$/, "")}:${assetId}`;
  const [lottieData, setLottieData] = useState(() => lottieDataCache.get(uriCacheKey) || null);
  const wrapperStyle: ViewStyle = { width: size + 2, height: size, paddingLeft: 2, transform: [{ translateY: -1 }] };
  const boxStyle: ViewStyle = { width: size, height: size };
  const roundStyle = { borderRadius: size / 2 };

  useEffect(() => {
    let alive = true;
    const cached = lottieDataCache.get(uriCacheKey);
    setLottieData(cached || null);
    if (!assetId || kind !== "lottie") return () => { alive = false; };
    cachedLottieData(assetId, apiBase)
      .then((next) => { if (alive) setLottieData(next || null); })
      .catch(() => { if (alive) setLottieData(null); });
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
    if (lottieData && LottieView) {
      return (
        <View style={[styles.wrap, wrapperStyle]}>
          <LottieView source={lottieData} autoPlay loop resizeMode="contain" style={[styles.lottie, boxStyle]} />
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

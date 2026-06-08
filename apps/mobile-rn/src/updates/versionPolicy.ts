import type { AndroidUpdateManifest, IosUpdateManifest, MobileUpdateManifest } from "./manifest";

export interface InstalledAppInfo {
  platform: "android" | "ios" | "web" | "unknown";
  buildVersion: string;
  runtimeVersion: string;
}

export type UpdateDecision =
  | { kind: "none" }
  | { kind: "android-binary"; target: AndroidUpdateManifest; mandatory: boolean }
  | { kind: "ios-store"; target: IosUpdateManifest; url: string };

function numberFromBuild(value: string): number {
  const parsed = Number.parseInt(String(value || "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function decideUpdate(installed: InstalledAppInfo, manifest: MobileUpdateManifest | null): UpdateDecision {
  if (!manifest) return { kind: "none" };
  const currentBuild = numberFromBuild(installed.buildVersion);

  if (installed.platform === "android" && manifest.android) {
    if (manifest.android.versionCode <= currentBuild) return { kind: "none" };
    return {
      kind: "android-binary",
      target: manifest.android,
      mandatory: manifest.android.mandatory || currentBuild < manifest.android.minSupportedVersionCode,
    };
  }

  if (installed.platform === "ios" && manifest.ios) {
    const targetBuild = numberFromBuild(manifest.ios.buildNumber);
    const url = manifest.ios.testFlightUrl || manifest.ios.storeUrl;
    if (!url || targetBuild <= currentBuild) return { kind: "none" };
    return { kind: "ios-store", target: manifest.ios, url };
  }

  return { kind: "none" };
}

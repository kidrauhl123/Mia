import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Mia",
  slug: "mia-mobile",
  owner: "jung755",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "mia",
  userInterfaceStyle: "light",
  runtimeVersion: "2",
  updates: {
    url: "https://u.expo.dev/77e99873-77e9-4e75-82c1-96143c4e846b",
  },
  android: {
    package: "app.mia.mobile",
    softwareKeyboardLayoutMode: "pan",
    adaptiveIcon: {
      backgroundColor: "#ffffff",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  ios: {
    bundleIdentifier: "app.mia.mobile",
    supportsTablet: true,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: ["expo-secure-store", "expo-video", "./modules/mia-android-updater/plugin/withMiaAndroidUpdater"],
  extra: {
    apiBase: "https://mia.gifgif.cn",
    eas: {
      projectId: "77e99873-77e9-4e75-82c1-96143c4e846b",
    },
  },
};

export default config;

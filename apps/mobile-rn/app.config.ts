import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Mia",
  slug: "mia-mobile",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "mia",
  userInterfaceStyle: "light",
  android: {
    package: "app.mia.mobile",
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
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
  plugins: ["expo-secure-store"],
  extra: {
    apiBase: "https://aiweb.buytb01.com",
  },
};

export default config;

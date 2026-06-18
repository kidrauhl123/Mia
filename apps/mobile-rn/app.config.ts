import type { ExpoConfig } from "expo/config";

const IS_DEV = process.env.APP_VARIANT === "development";

const config: ExpoConfig = {
  name: IS_DEV ? "Mia Dev" : "Mia",
  slug: "mia-mobile",
  owner: "jung755",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: IS_DEV ? "mia-dev" : "mia",
  userInterfaceStyle: "light",
  runtimeVersion: "2",
  updates: {
    url: "https://u.expo.dev/77e99873-77e9-4e75-82c1-96143c4e846b",
  },
  android: {
    package: IS_DEV ? "app.mia.mobile.dev" : "app.mia.mobile",
    ...(IS_DEV ? {} : { googleServicesFile: "./google-services.json" }),
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
    bundleIdentifier: IS_DEV ? "app.mia.mobile.dev" : "app.mia.mobile",
    supportsTablet: true,
    infoPlist: {
      // Allow opening / querying the WeChat app from the login screen.
      LSApplicationQueriesSchemes: ["weixin"],
    },
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-secure-store",
    "expo-video",
    "expo-notifications",
    "./modules/mia-android-updater/plugin/withMiaAndroidUpdater",
  ],
  extra: {
    apiBase: "https://mia.gifgif.cn",
    appVariant: IS_DEV ? "development" : "production",
    eas: {
      projectId: "77e99873-77e9-4e75-82c1-96143c4e846b",
    },
  },
};

export default config;

# Mobile Development Build

Mia mobile uses a separate Expo development build for fast UI iteration on real Android devices.

## Development App

- App label: `Mia Dev`
- Android package: `app.mia.mobile.dev`
- URL scheme: `mia-dev`
- EAS profile: `development`

The development app can be installed next to the production `Mia` app. It has a separate Android package and separate secure storage, so log in again after installing it.

## Run Metro

Use tunnel mode when the phone and computer are on a company network where LAN discovery is blocked:

```bash
cd apps/mobile-rn
npm run dev
```

Use LAN only when the phone can reach the computer directly:

```bash
cd apps/mobile-rn
npm run dev:lan
```

In `Mia Dev`, open the Expo Dev Client home screen and connect to the Metro URL printed by Expo. If USB debugging is available, `adb reverse tcp:8081 tcp:8081` plus `http://127.0.0.1:8081` is the most stable path.

## Rebuild Rules

JS, TypeScript, and UI changes should load through Metro/Fast Refresh and do not need a new APK.

Rebuild the development APK when changing native dependencies, Expo config, Android permissions, Firebase/google-services setup, or config plugins.

## Update Behavior

`Mia Dev` must not consume the production Android update manifest. Production APK updates target `app.mia.mobile`, while the development build is `app.mia.mobile.dev`; the app disables production update checks in development variants and `.dev` package IDs.

Push notifications in the development build are best-effort. The development variant intentionally omits production `google-services.json` unless FCM parity is being tested.

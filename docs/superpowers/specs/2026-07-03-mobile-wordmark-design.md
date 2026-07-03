# Mobile Wordmark Design

## Scope

This design aligns the mobile app's visible Mia brand mark with the existing web wordmark style.

The immediate target is the mobile login screen brand row. The implementation should also make the shared mobile `Brand` text primitive capable of rendering the same wordmark style anywhere else it is used later.

## Non-Goals

- No change to normal UI copy that happens to mention `Mia` or `Mia Cloud`.
- No redesign of the mobile login layout beyond the brand row.
- No change to desktop or web branding in this task.

## Existing Boundaries

- Mobile brand text already goes through `Brand` in `apps/mobile-rn/src/ui/Text.tsx`.
- The current brand token already exists as `type.brand` in `apps/mobile-rn/src/theme.ts`.
- The login screen brand row lives in `apps/mobile-rn/src/screens/LoginScreen.tsx`.
- The web wordmark currently looks correct and acts as the visual reference for this task.

This work should stay inside those boundaries instead of creating a separate one-off brand component for the login screen.

## Product Decision

The mobile brand mark should match the web wordmark direction by using:

- title case `Mia`, not all-caps `MIA`
- the same rounded wordmark font family used by web branding
- restrained sizing that stays within the existing mobile typography limits
- slightly tightened logo-like tracking and stronger visual priority than body copy

The icon at the left of the login screen brand row stays unchanged. Only the wordmark text changes.

## Font Strategy

Mobile currently does not load the web wordmark font. To make the brand mark actually match the web direction, the mobile app should add the `Fredoka` family through Expo font loading.

Rules:

- Add only the font weight needed by the mobile wordmark.
- Load the font once during app bootstrap.
- `Brand` should use `Fredoka` only when the font is ready.
- Before the font is ready, the app may fall back to the existing system font without blocking startup.

This keeps the dependency small while making the visible brand mark consistent with web.

## Implementation Shape

1. Add the mobile font dependency for `Fredoka`.
2. Load the font near the app bootstrap path that already owns shared providers.
3. Update the `type.brand` token to represent a wordmark instead of generic semibold UI text.
4. Change the login screen brand text literal from `MIA` to `Mia`.

The style change should remain centralized in `Brand` and `type.brand` so later brand placements inherit the same look automatically.

## Testing

Tests should cover:

- the mobile typography token still stays within the existing size ceiling
- the brand token now encodes the intended wordmark size and weight
- the login screen brand literal is `Mia`, not `MIA`

Manual verification should cover:

- Android dev build shows the login screen with the new `Mia` wordmark
- the new font does not distort normal body text
- the brand row still aligns correctly with the existing icon on device

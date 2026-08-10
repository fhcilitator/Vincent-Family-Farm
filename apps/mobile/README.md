# vibe agent — Android app

Expo app for driving Claude on a dev box from a phone. It talks to
`packages/agent` over the protocol in `packages/protocol`, using the reconnect
and chat logic from `packages/client-core`.

## Not runnable in CI

This app cannot be exercised in the environment it was written in — there is no
Android SDK and no device — so everything load-bearing lives in
`packages/client-core` and is tested in Node, and in `apps/devclient`, which is
tested in a real browser under Playwright. What is left here is genuinely
device-specific: layout, touch targets, the soft keyboard, and later the
microphone. `npm run typecheck` is the only check that runs here.

## Build

A **development build** is required — not Expo Go — because of the native
modules (`expo-secure-store` now, speech recognition and WebView later).

```sh
npm run build            # from the repo root: client-core must be compiled
cd apps/mobile
npx expo prebuild --platform android
npx expo run:android     # or: eas build --profile development --platform android
```

## Versions are pinned by hand

`npx expo install` resolves SDK-matched versions through `api.expo.dev`, which
this environment's network policy blocks. The versions in `package.json` were
read out of `node_modules/expo/bundledNativeModules.json` instead — the same
data `expo install` would have fetched. If you add a package, prefer
`npx expo install <pkg>` on a normal network; otherwise check that file.

Expo SDK 56 (React Native 0.85, React 19.2) targets Android API 36 by default,
which is what Play requires for new apps and updates from 31 Aug 2026. It also
enforces edge-to-edge with no opt-out, so every screen pads itself with
`useSafeAreaInsets` rather than assuming the system bars reserve space.

## Voice

Hold the mic button to dictate; release to stop. The transcript goes into the
composer, never straight to Claude — a misheard instruction reaching a tool
that runs bash is the failure this prevents, and it costs one tap. Nothing in
the voice path can approve a permission.

`@jamsch/expo-speech-recognition` declares `RECORD_AUDIO` via its config
plugin, so it is not repeated in `app.json`. Continuous mode is detected at
runtime (Android 13+); below that the recognizer stops at the first pause and
plays a beep it hardcodes.

On-device recognition is preferred and reported in the UI, but it is a
preference, not a guarantee: without the language pack installed Android's
default recognizer sends audio to Google. **The Data Safety form must say
that** rather than claiming audio never leaves the phone.

Corrections live in `packages/client-core/src/dictation.ts` — a find/replace
pass that turns "use effect" into `useEffect` and "see d" into `cd`. It is
there rather than here because it is pure and gets real tests; recognition
accuracy itself can only be judged on a device, and doing that is how the list
should grow.

## Connecting

`app/connect.tsx` takes both endpoints and the agent token. The token is the
only thing between the internet and command execution on the dev box, so it
lives in `expo-secure-store` (Android Keystore), never `AsyncStorage`.

There is no Anthropic credential in this app. Claude is authenticated on the
dev box by the `claude` CLI, and the agent inherits that login.

Both endpoints should be `wss://`. `tailscale serve` issues a real ts.net
certificate for the trusted path and the tunnel terminates TLS for the public
one, so no cleartext exception is needed — which is why this app does not set
`usesCleartextTraffic`. A bare `ws://` address will fail on Android by design.

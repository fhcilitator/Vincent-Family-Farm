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

## Getting it onto a phone

A real build is required — **Expo Go will not work**, because
`@jamsch/expo-speech-recognition` is a native module. There is no shortcut here.

There are two independent halves: an APK on the phone, and an agent it can
reach. Do the agent half first — it is faster to debug and it is where the
failures actually are.

### 1. Dev box — run the agent

```sh
git pull && npm install && npm run build
node packages/agent/dist/cli.js token          # save this
```

```sh
VIBE_TOKEN=<token> VIBE_PUBLIC_PORT=8788 VIBE_ROOTS=/path/to/your/project \
  node packages/agent/dist/cli.js start
```

`VIBE_PUBLIC_PORT` is the one that matters. Setting it also leaves the trusted
listener on 8787, which is harmless — both bind to `127.0.0.1` and only 8788
gets tunnelled. If you later add `tailscale serve --bg 8787`, the app picks up
the trusted path with no rebuild.

### 2. Dev box — open the tunnel

A Cloudflare quick tunnel needs no account and no domain:

```sh
cloudflared tunnel --url http://127.0.0.1:8788
```

It prints `https://<random-words>.trycloudflare.com`. The app wants that same
host as **`wss://<random-words>.trycloudflare.com`**.

### 3. Prove the path before waiting on a build

Point the browser dev client at the tunnel URL and token:

```sh
npm run dev --workspace=@vff/devclient
```

If that reaches `live` with an orange `public` badge, then the agent, the
tunnel, and the token are all correct and anything that fails later is the
phone. One minute here beats discovering a wrong token after a fifteen-minute
cloud build.

### 4. Build the APK

EAS archives **committed** git state, so commit first or it builds stale code.

```sh
cd apps/mobile
npx eas-cli login
npx eas-cli init        # writes extra.eas.projectId into app.json
npx eas-cli build --profile preview --platform android
```

`preview` produces a standalone APK with the JS bundled — no Metro server, works
from anywhere. Use it first. `development` is for iterating afterwards; note its
Metro connection and the agent connection are independent, so you can hot-reload
over LAN wifi while the agent link still runs over the tunnel.

### 5. Phone

Open the link EAS prints, download the APK, allow "install unknown apps" for
your browser, install. The app opens on the Connect screen: leave the tailnet
field empty, put the `wss://…trycloudflare.com` URL in the public field, paste
the token, save.

Expect a green `live` badge and an orange `public` one. Until `claude` is signed
in on the dev box you will also get the red auth banner with the exact command
to fix it.

### The tunnel is a public internet endpoint

A `trycloudflare.com` URL points at a process that runs shell commands as your
user. The random hostname is not a security control — **the token is the only
thing protecting it**. Use the generated 32-byte token and nothing shorter, stop
`cloudflared` when you are not testing, and treat a named tunnel behind
Cloudflare Access as the requirement for anything left running.

### What the public tier changes

Over the tunnel the app is on the `public` trust tier: an approval cannot be
remembered for the rest of a session, and an unanswered prompt is denied after
two minutes — the sheet shows a countdown so an expiry is not mistaken for a
hang. `auto` mode is available if you would rather it run without asking;
`acceptEdits`, `dontAsk`, and `bypassPermissions` are refused on this path.

### Why the build hook exists

`@vff/protocol` and `@vff/client-core` resolve through `main: ./dist/index.js`,
and `dist/` is gitignored — so on a fresh EAS worker they arrive empty and Metro
cannot resolve them. The `eas-build-post-install` script compiles them after
install. It is declared in both this package and the workspace root, since which
one EAS runs varies by version and a duplicate compile is harmless.

Relatedly, each package writes its `tsconfig.tsbuildinfo` **inside** `dist/`. It
used to sit beside the tsconfig, which meant deleting `dist/` left the
incremental state behind and `tsc -b` would report "up to date" while emitting
nothing at all. Keeping the state with the outputs makes that impossible.

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

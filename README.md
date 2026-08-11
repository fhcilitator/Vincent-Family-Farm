# vibe agent

Drive Claude Code on your dev box from an Android phone.

The problem this solves: code-server in a mobile browser is miserable — tiny hit
targets, a terminal that fights the soft keyboard, and no touch-native way to
review what an agent just changed. This replaces that web UI for one specific
loop: say what you want, watch Claude work, approve or deny its tool calls,
review the diff, commit.

## Shape

```
apps/mobile/          Expo app (Android)
apps/devclient/       Vite + React browser client — dev and verification tool
packages/agent/       Companion agent that runs on the dev box
packages/client-core/ Reconnect + chat logic, shared by both clients
packages/protocol/    Wire protocol: shared types and zod schemas
```

The agent embeds `@anthropic-ai/claude-agent-sdk`, which spawns the Claude Code
binary — so it inherits whatever `claude` is already logged into on that
machine. **No Anthropic credential ever reaches the phone.**

## The load-bearing behaviour

Claude sessions live on the dev box and outlive the WebSocket. A phone that
loses signal mid-task reconnects, replays what it missed from a sequenced log,
and picks up where it left off — work continues while the phone is asleep. That
is what makes driving an agent from a phone viable at all, and it is why
`packages/client-core` exists as a separately tested unit rather than as code
inside the app.

Tool-permission asks are **durable events, not RPCs**, for the same reason: an
RPC dies with the socket and a phone's socket dies constantly. Background the
app mid-task, come back ten minutes later, and the approval prompt is still
waiting.

## Two ways in, two trust levels

The agent binds two localhost ports and the trust tier is decided by *which
socket accepted the connection*, which a client cannot forge:

| Port | Reached via | Tier |
|---|---|---|
| 8787 | `tailscale serve` | `trusted` — approvals can be remembered for a session |
| 8788 | `cloudflared` or `tailscale funnel` | `public` — each call approved, 2-minute timeout |

The app shows which tier it is on, because the behaviour visibly differs and an
unexplained change reads as a bug.

## Getting started

Run the agent:

```sh
npm install && npm run build
node packages/agent/dist/cli.js token          # save this

VIBE_TOKEN=<token> VIBE_PUBLIC_PORT=8788 VIBE_ROOTS=/path/to/project \
  node packages/agent/dist/cli.js start
```

Then publish it through a tunnel and put the app on a phone —
[apps/mobile/README.md](apps/mobile/README.md) has the full runbook, including
the Cloudflare Tunnel setup and the one `curl` that tells you whether anything
is misconfigured.

To drive it from a desktop browser instead, `npm run dev --workspace=@vff/devclient`.

## Tests

```sh
npm test        # agent, client-core, protocol, and browser e2e under Playwright
npm run typecheck
```

The Android app cannot be exercised in CI — there is no device — so everything
load-bearing lives in `client-core` (tested in Node) and `devclient` (tested in
a real browser). That split has already paid for itself: a `Buffer.byteLength`
call in the shared protocol typechecked cleanly and passed 159 Node tests while
throwing on every frame in a browser. Only a real browser could see it, and
without `devclient` it would have surfaced first on a phone.

## Security, plainly

The agent runs shell commands and edits files as your user. Anyone who can
authenticate to it owns that machine. The agent token is the only thing between
the public tunnel and command execution — treat it accordingly, and put
Cloudflare Access in front of anything left running. Paths are confined to
configured roots, and `bypassPermissions` is not reachable from the phone unless
the agent's own config opts in.

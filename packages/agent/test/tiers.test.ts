import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { start, type RunningAgent } from '../src/server.js';
import { loadConfig, policyFor } from '../src/config.js';
import { AgentClient, RemoteError } from '../src/client/client.js';
import { ChatSession, type QueryFn } from '../src/chat/session.js';
import { events, type TrustTier } from '@vff/protocol';

const E = events.EVENT_TYPES.claude;
const TOKEN = 'tier-test-token';

/**
 * Trust tiers.
 *
 * The agent is reachable two ways: a tailnet-private path and a public one.
 * They share code and credentials but not privileges — the public path keeps
 * full capability and loses convenience. These tests pin that difference down,
 * because it is the only thing standing between a stolen token and unattended
 * command execution.
 */

let agent: RunningAgent;
let trustedUrl: string;
let publicUrl: string;

before(async () => {
  agent = await start(
    loadConfig({
      token: TOKEN,
      listeners: { trusted: { port: 0 }, public: { port: 0 } },
      roots: [process.cwd()],
      allowBypassPermissions: true, // prove public still refuses it
    }),
  );
  trustedUrl = `ws://127.0.0.1:${agent.ports.trusted}`;
  publicUrl = `ws://127.0.0.1:${agent.ports.public}`;
});

after(async () => {
  await agent.close();
});

describe('tier is determined by the socket, not the client', () => {
  test('the trusted listener reports trusted', async () => {
    const c = new AgentClient(trustedUrl, TOKEN);
    const hello = await c.connect();
    assert.equal(hello.tier, 'trusted');
    c.close();
  });

  test('the public listener reports public', async () => {
    const c = new AgentClient(publicUrl, TOKEN);
    const hello = await c.connect();
    assert.equal(hello.tier, 'public');
    c.close();
  });

  test('spoofed proxy headers cannot promote a public connection', async () => {
    // The whole reason for two sockets rather than header inspection.
    const ws = new WebSocket(publicUrl, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-forwarded-for': '100.64.0.1', // a tailnet address
        'cf-connecting-ip': '100.64.0.1',
        'x-tier': 'trusted',
      },
    });
    await new Promise((r) => ws.once('open', r));

    ws.send(
      JSON.stringify({
        kind: 'req',
        id: 'h',
        ch: 'system',
        op: 'hello',
        body: { protocolVersion: 1, deviceId: 'spoofer', clientVersion: '0' },
      }),
    );
    const reply = JSON.parse(String(await new Promise((r) => ws.once('message', r))));
    assert.equal(reply.body.tier, 'public', 'headers must not influence the tier');
    ws.close();
  });

  test('both listeners serve health, tagged with their tier', async () => {
    const [t, p] = await Promise.all([
      fetch(`http://127.0.0.1:${agent.ports.trusted}/health`).then((r) => r.json()),
      fetch(`http://127.0.0.1:${agent.ports.public}/health`).then((r) => r.json()),
    ]);
    assert.equal((t as { tier: string }).tier, 'trusted');
    assert.equal((p as { tier: string }).tier, 'public');
  });
});

describe('the agent tells the app what is restricted', () => {
  test('trusted policy permits session-scoped approvals', async () => {
    const c = new AgentClient(trustedUrl, TOKEN);
    const hello = await c.connect();
    assert.equal(hello.policy.allowSessionScopedApprovals, true);
    assert.ok(hello.policy.allowedPermissionModes.includes('acceptEdits'));
    c.close();
  });

  test('public policy forbids session grants and the edit-widening modes', async () => {
    const c = new AgentClient(publicUrl, TOKEN);
    const hello = await c.connect();
    assert.equal(hello.policy.allowSessionScopedApprovals, false);
    assert.deepEqual(hello.policy.allowedPermissionModes.sort(), ['auto', 'default', 'plan']);
    // Shorter, so a prompt nobody is there to answer fails closed sooner.
    assert.ok(hello.policy.permissionTimeoutMs < 30 * 60 * 1000);
    c.close();
  });
});

describe('permissionMode gating', () => {
  const restricted = ['acceptEdits', 'dontAsk', 'bypassPermissions'] as const;

  /**
   * Asserted positively, not merely left out of the list above.
   *
   * `auto` is allowed on the public path on purpose — refusing it removed no
   * capability from anyone holding the token, only convenience from the
   * operator. Without a test that says so, a later tightening of this policy
   * would take it away again and every other test here would still pass.
   */
  test('public accepts permissionMode "auto"', async () => {
    const c = new AgentClient(publicUrl, TOKEN);
    await c.connect();
    const res = await c.request('claude/start', { permissionMode: 'auto' });
    assert.ok(res.sessionId, 'a public connection must be able to start an auto-mode session');
    c.close();
  });

  for (const mode of restricted) {
    test(`public rejects permissionMode "${mode}"`, async () => {
      const c = new AgentClient(publicUrl, TOKEN);
      await c.connect();
      await assert.rejects(
        () => c.request('claude/start', { permissionMode: mode }),
        (err: unknown) =>
          err instanceof RemoteError &&
          err.wire.code === 'permission_denied' &&
          /public connection/.test(err.wire.message),
        `public must refuse ${mode} — it reduces or removes prompting`,
      );
      c.close();
    });
  }

  test('trusted accepts bypassPermissions when the agent config opts in', async () => {
    const c = new AgentClient(trustedUrl, TOKEN);
    await c.connect();
    const res = await c.request('claude/start', { permissionMode: 'bypassPermissions' });
    assert.ok(res.sessionId);
    c.close();
  });

  test('public accepts plan and default', async () => {
    const c = new AgentClient(publicUrl, TOKEN);
    await c.connect();
    for (const mode of ['default', 'plan'] as const) {
      const res = await c.request('claude/start', { permissionMode: mode });
      assert.ok(res.sessionId);
    }
    c.close();
  });
});

describe('bypassPermissions is never reachable from public', () => {
  test('even with allowBypassPermissions enabled agent-wide', async () => {
    // The config above sets allowBypassPermissions: true. Trusted may use it
    // (asserted); public still may not. A remotely-selectable off switch for
    // the only safety mechanism does not belong on the internet-facing path.
    const c = new AgentClient(publicUrl, TOKEN);
    await c.connect();
    await assert.rejects(() => c.request('claude/start', { permissionMode: 'bypassPermissions' }));
    c.close();
  });
});

/* ------------------------------------------------------------------------ */
/* Session-scoped grants — the decisive behaviour, tested at the unit level  */
/* so the attached tier can be varied deterministically.                     */
/* ------------------------------------------------------------------------ */

function tierHarness(initialTier: TrustTier | 'none') {
  let tier: TrustTier | 'none' = initialTier;
  let captured: CanUseTool | undefined;
  let release!: () => void;
  const stopped = new Promise<void>((r) => (release = r));
  const emitted: Array<{ type: string; body: unknown }> = [];

  const queryFn = ((args: { options?: { canUseTool?: CanUseTool } }) => {
    captured = args.options?.canUseTool;
    const gen = (async function* () {
      await stopped;
    })();
    return Object.assign(gen, { interrupt: async () => {}, close: () => release() });
  }) as unknown as QueryFn;

  const session = new ChatSession({
    cwd: process.cwd(),
    permissionTimeoutMs: 60,
    publicPermissionTimeoutMs: 25,
    resolveTier: () => tier,
    queryFn,
    onEvent: (_s, _seq, type, body) => emitted.push({ type, body }),
  });
  session.start();

  return {
    session,
    emitted,
    setTier(next: TrustTier | 'none') {
      tier = next;
    },
    ask: (toolName: string, input: Record<string, unknown>) =>
      captured!(toolName, input, { signal: new AbortController().signal }),
    async lastRequestId(): Promise<string> {
      for (let i = 0; i < 100; i++) {
        const hit = [...emitted].reverse().find((e) => e.type === E.permissionPending);
        if (hit) return (hit.body as { requestId: string }).requestId;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('no permission ask was raised');
    },
    countAsks: () => emitted.filter((e) => e.type === E.permissionPending).length,
  };
}

describe('session-scoped grants require presence on the trusted path', () => {
  test('THE decisive case: same session, same call, auto-allowed on trusted then prompted on public', async () => {
    const h = tierHarness('trusted');

    // At home: approve once for the session.
    const first = h.ask('Bash', { command: 'npm test' });
    h.session.respondToPermission(await h.lastRequestId(), { allow: true, scope: 'session' }, 'trusted');
    await first;

    // Same call again, still at home — silent.
    const asksBefore = h.countAsks();
    const second = await h.ask('Bash', { command: 'npm test' });
    assert.equal(second.behavior, 'allow');
    assert.equal(h.countAsks(), asksBefore, 'trusted + stored grant must not re-prompt');

    // Now walk out of the house. Identical call, identical session.
    h.setTier('public');
    const third = h.ask('Bash', { command: 'npm test' });
    const requestId = await h.lastRequestId();
    assert.equal(h.countAsks(), asksBefore + 1, 'public must re-prompt despite the stored grant');

    h.session.respondToPermission(requestId, { allow: true, scope: 'once' }, 'public');
    assert.equal((await third).behavior, 'allow');
    h.session.close();
  });

  test('a public responder cannot create a session-scoped grant', async () => {
    const h = tierHarness('public');

    const first = h.ask('Bash', { command: 'npm test' });
    // Asks for 'session' scope — must be silently downgraded to once.
    h.session.respondToPermission(await h.lastRequestId(), { allow: true, scope: 'session' }, 'public');
    await first;

    // Prove no grant was stored: even back on trusted, it prompts again.
    h.setTier('trusted');
    const asksBefore = h.countAsks();
    void h.ask('Bash', { command: 'npm test' });
    await h.lastRequestId();
    assert.equal(
      h.countAsks(),
      asksBefore + 1,
      'a public client must not buy silence for future calls',
    );
    h.session.close();
  });

  test('with nobody attached, a stored grant does not fire', async () => {
    const h = tierHarness('trusted');
    const first = h.ask('Read', { file_path: 'a.ts' });
    h.session.respondToPermission(await h.lastRequestId(), { allow: true, scope: 'session' }, 'trusted');
    await first;

    h.setTier('none');
    const asksBefore = h.countAsks();
    void h.ask('Read', { file_path: 'a.ts' });
    await h.lastRequestId();
    assert.equal(h.countAsks(), asksBefore + 1, 'no attached trusted client means no auto-allow');
    h.session.close();
  });
});

describe('permission timeout is resolved per ask from the attached tier', () => {
  test('public gets the shorter ceiling', async () => {
    const h = tierHarness('public');
    const started = Date.now();
    const result = await h.ask('Bash', { command: 'sleep' });
    const elapsed = Date.now() - started;

    assert.equal(result.behavior, 'deny');
    assert.ok(elapsed < 55, `expected the ~25ms public ceiling, waited ${elapsed}ms`);
    h.session.close();
  });

  test('an unattached session gets the longer ceiling, because a pending ask is fail-closed anyway', async () => {
    const h = tierHarness('none');
    const started = Date.now();
    await h.ask('Bash', { command: 'sleep' });
    const elapsed = Date.now() - started;

    // Using the short public ceiling here would kill asks raised while the
    // phone is simply in a tunnel — the exact case the design exists to serve.
    assert.ok(elapsed >= 55, `expected the 60ms trusted ceiling, waited ${elapsed}ms`);
    h.session.close();
  });
});

describe('config guards', () => {
  test('refuses to share one real port between the two tiers', async () => {
    await assert.rejects(
      () =>
        start(
          loadConfig({
            token: 't',
            listeners: { trusted: { port: 9911 }, public: { port: 9911 } },
          }),
        ),
      /must use different ports/,
    );
  });

  test('refuses to start with no listeners at all', async () => {
    await assert.rejects(
      () => start(loadConfig({ token: 't', listeners: { trusted: null, public: null } })),
      /at least one of trusted or public/,
    );
  });

  test('policyFor never grants bypass on public, whatever the config says', () => {
    const cfg = loadConfig({ token: 't', allowBypassPermissions: true });
    assert.ok(!policyFor(cfg, 'public').allowedPermissionModes.includes('bypassPermissions'));
    assert.ok(policyFor(cfg, 'trusted').allowedPermissionModes.includes('bypassPermissions'));
  });
});

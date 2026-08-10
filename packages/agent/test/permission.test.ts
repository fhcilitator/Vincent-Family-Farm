import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ChatSession, type ChatSessionOptions, type QueryFn } from '../src/chat/session.js';
import { events } from '@vff/protocol';

const E = events.EVENT_TYPES.claude;

interface Harness {
  session: ChatSession;
  /** Invoke the SDK's permission hook the way the real SDK would. */
  askPermission(
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PermissionResult>;
  emitted: Array<{ type: string; body: unknown }>;
  /** Wait for the first event of a type, with a bounded timeout. */
  waitFor(type: string, timeoutMs?: number): Promise<unknown>;
}

/**
 * Builds a ChatSession wired to a fake SDK. The fake never produces messages;
 * it just hands back the `canUseTool` the session installed, so tests can
 * drive the permission machine directly. No API credentials, no network.
 */
function harness(overrides: Partial<ChatSessionOptions> = {}): Harness {
  const emitted: Array<{ type: string; body: unknown }> = [];
  let captured: CanUseTool | undefined;

  // Lets the fake generator finish on close(), so the test's event loop can
  // drain instead of hanging on a promise that never settles.
  let release!: () => void;
  const stopped = new Promise<void>((r) => {
    release = r;
  });

  const queryFn = ((args: { options?: { canUseTool?: CanUseTool } }) => {
    captured = args.options?.canUseTool;
    // Yields nothing and stays open — what the real query does between turns.
    const gen = (async function* () {
      await stopped;
    })();
    return Object.assign(gen, {
      interrupt: async () => {},
      close: () => release(),
    });
  }) as unknown as QueryFn;

  const session = new ChatSession({
    cwd: process.cwd(),
    permissionTimeoutMs: 50,
    publicPermissionTimeoutMs: 20,
    // Default to trusted so these tests exercise the permissive path; the
    // tier-specific behaviour has its own suite in tiers.test.ts.
    resolveTier: () => 'trusted',
    queryFn,
    onEvent: (_s, _seq, type, body) => emitted.push({ type, body }),
    ...overrides,
  });
  session.start();

  return {
    session,
    emitted,
    askPermission(toolName, input, signal) {
      if (!captured) throw new Error('session did not install canUseTool');
      return captured(toolName, input, { signal: signal ?? new AbortController().signal });
    },
    async waitFor(type, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = emitted.find((e) => e.type === type);
        if (hit) return hit.body;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timed out waiting for ${type}; saw ${emitted.map((e) => e.type).join(', ')}`);
    },
  };
}

describe('permission asks are durable events', () => {
  test('emits permission-pending with everything the sheet needs', async () => {
    const h = harness();
    void h.askPermission('Bash', { command: 'npm test' });

    const body = (await h.waitFor(E.permissionPending)) as {
      requestId: string;
      toolName: string;
      render: { title: string; body: { kind: string; value: string }; risk: string };
      expiresAt: number | null;
    };

    assert.ok(body.requestId);
    assert.equal(body.toolName, 'Bash');
    assert.equal(body.render.body.kind, 'command');
    assert.equal(body.render.body.value, 'npm test');
    assert.ok(body.render.title.length > 0);
    assert.ok(body.expiresAt && body.expiresAt > Date.now());
    h.session.close();
  });

  test('the ask lands in the channel log, so it replays after a reconnect', async () => {
    const h = harness({ permissionTimeoutMs: 0 });
    void h.askPermission('Bash', { command: 'ls' });
    await h.waitFor(E.permissionPending);

    // A phone that was away asks for everything from the start.
    const replay = h.session.log.since(0);
    const pending = replay.events.find((e) => e.type === E.permissionPending);
    assert.ok(pending, 'pending ask must be replayable — this is the whole point');
    h.session.close();
  });
});

describe('permission decisions', () => {
  test('allow resolves the SDK call with behavior allow', async () => {
    const h = harness({ permissionTimeoutMs: 0 });
    const call = h.askPermission('Read', { file_path: 'a.ts' });
    const { requestId } = (await h.waitFor(E.permissionPending)) as { requestId: string };

    assert.equal(h.session.respondToPermission(requestId, { allow: true, scope: 'once' }), true);
    const result = await call;
    assert.equal(result.behavior, 'allow');
    h.session.close();
  });

  test('deny resolves with behavior deny and a message Claude can read', async () => {
    const h = harness({ permissionTimeoutMs: 0 });
    const call = h.askPermission('Bash', { command: 'rm -rf /' });
    const { requestId } = (await h.waitFor(E.permissionPending)) as { requestId: string };

    h.session.respondToPermission(requestId, { allow: false, message: 'absolutely not' });
    const result = await call;
    assert.equal(result.behavior, 'deny');
    assert.equal(result.behavior === 'deny' && result.message, 'absolutely not');
    h.session.close();
  });

  test('responding to an unknown request id reports not-applied instead of throwing', () => {
    const h = harness({ permissionTimeoutMs: 0 });
    assert.equal(h.session.respondToPermission('nope', { allow: true, scope: 'once' }), false);
    h.session.close();
  });

  test('a second response to the same ask is rejected — first responder wins', async () => {
    const h = harness({ permissionTimeoutMs: 0 });
    const call = h.askPermission('Read', { file_path: 'a.ts' });
    const { requestId } = (await h.waitFor(E.permissionPending)) as { requestId: string };

    assert.equal(h.session.respondToPermission(requestId, { allow: true, scope: 'once' }), true);
    await call;
    assert.equal(
      h.session.respondToPermission(requestId, { allow: false }),
      false,
      'a second device must not be able to flip an already-settled decision',
    );
    h.session.close();
  });
});

describe('failure modes deny, never allow', () => {
  test('timeout denies', async () => {
    const h = harness({ permissionTimeoutMs: 30 });
    const result = await h.askPermission('Bash', { command: 'sleep 1' });

    assert.equal(result.behavior, 'deny', 'an unanswered ask must never be treated as consent');
    assert.match(result.behavior === 'deny' ? result.message : '', /timeout/i);
    h.session.close();
  });

  test('timeout is recorded in the log as a resolution', async () => {
    const h = harness({ permissionTimeoutMs: 30 });
    await h.askPermission('Bash', { command: 'x' });

    const resolved = (await h.waitFor(E.permissionResolved)) as { allowed: boolean; by: string };
    assert.equal(resolved.allowed, false);
    assert.equal(resolved.by, 'timeout');
    h.session.close();
  });

  test('abort denies', async () => {
    const h = harness({ permissionTimeoutMs: 0 });
    const ac = new AbortController();
    const call = h.askPermission('Bash', { command: 'x' }, ac.signal);
    await h.waitFor(E.permissionPending);

    ac.abort();
    const result = await call;
    assert.equal(result.behavior, 'deny');
    h.session.close();
  });

  test('closing the session denies everything in flight', async () => {
    const h = harness({ permissionTimeoutMs: 0 });
    const call = h.askPermission('Bash', { command: 'x' });
    await h.waitFor(E.permissionPending);

    h.session.close();
    const result = await call;
    assert.equal(result.behavior, 'deny', 'agent shutdown must not grant anything');
  });

  test('a disconnected client does not decide anything — the ask stays pending', async () => {
    // There is no socket here at all, and the ask is still waiting.
    const h = harness({ permissionTimeoutMs: 0 });
    void h.askPermission('Bash', { command: 'x' });
    await h.waitFor(E.permissionPending);

    await new Promise((r) => setTimeout(r, 60));
    assert.equal(
      h.session.pendingPermissionIds.length,
      1,
      'a dropped connection must not resolve a permission either way',
    );
    h.session.close();
  });
});

describe('allow-for-session scoping', () => {
  test('a session-scoped allow suppresses the next identical ask', async () => {
    const h = harness({ permissionTimeoutMs: 0 });
    const first = h.askPermission('Bash', { command: 'npm test' });
    const { requestId } = (await h.waitFor(E.permissionPending)) as { requestId: string };
    h.session.respondToPermission(requestId, { allow: true, scope: 'session' }, 'trusted');
    await first;

    const before = h.emitted.filter((e) => e.type === E.permissionPending).length;
    const second = await h.askPermission('Bash', { command: 'npm test' });
    const after = h.emitted.filter((e) => e.type === E.permissionPending).length;

    assert.equal(second.behavior, 'allow');
    assert.equal(after, before, 'the second identical call must not re-prompt');
    h.session.close();
  });

  test('a session-scoped allow does NOT cover a different command', async () => {
    const h = harness({ permissionTimeoutMs: 20 });
    const first = h.askPermission('Bash', { command: 'npm test' });
    const { requestId } = (await h.waitFor(E.permissionPending)) as { requestId: string };
    h.session.respondToPermission(requestId, { allow: true, scope: 'session' }, 'trusted');
    await first;

    // Approving `npm test` must not silently approve `rm -rf /`.
    const dangerous = await h.askPermission('Bash', { command: 'rm -rf /' });
    assert.equal(dangerous.behavior, 'deny', 'scope must key on the command, not just the tool');
    h.session.close();
  });

  test('a once-scoped allow does not suppress the next ask', async () => {
    const h = harness({ permissionTimeoutMs: 20 });
    const first = h.askPermission('Read', { file_path: 'a.ts' });
    const { requestId } = (await h.waitFor(E.permissionPending)) as { requestId: string };
    h.session.respondToPermission(requestId, { allow: true, scope: 'once' });
    await first;

    const second = await h.askPermission('Read', { file_path: 'a.ts' });
    assert.equal(second.behavior, 'deny', 'once means once — it must re-prompt and then time out');
    h.session.close();
  });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { start, loadConfig, type RunningAgent } from '@vff/agent';
import { WsClient, DisconnectedError, type ConnectionState } from '../src/ws-client.js';
import type { SocketLike } from '../src/socket.js';
import { events, type Event } from '@vff/protocol';

const E = events.EVENT_TYPES.claude;
const TOKEN = 'client-core-test-token';

/**
 * WsClient against a real agent.
 *
 * These are the behaviours the product rests on: resume rather than restart,
 * and noticing a socket that has died without saying so. Both are exercised
 * against the actual agent, because the interesting bugs live in the seam
 * between the two.
 */

let agent: RunningAgent;
let url: string;

before(async () => {
  agent = await start(
    loadConfig({
      token: TOKEN,
      listeners: { trusted: { port: 0 }, public: null },
      roots: [process.cwd()],
    }),
  );
  url = `ws://127.0.0.1:${agent.ports.trusted}`;
});

after(async () => {
  await agent.close();
});

/**
 * A client whose sockets the test can reach.
 *
 * The socket factory is injectable precisely so a test can stand in the
 * middle: `drop()` kills the live connection without the client being told to
 * stop, which is exactly what a network blip looks like from its side.
 */
function harness(over: Partial<ConstructorParameters<typeof WsClient>[0]> = {}) {
  const sockets: SocketLike[] = [];
  const dialled: string[] = [];

  const client = new WsClient({
    url,
    token: TOKEN,
    deviceId: 'test-device',
    requestTimeoutMs: 5_000,
    heartbeatIntervalMs: 60_000,
    minBackoffMs: 20,
    maxBackoffMs: 200,
    createSocket: (u, t) => {
      dialled.push(u);
      const s = new WebSocket(u, {
        headers: { authorization: `Bearer ${t}` },
      }) as unknown as SocketLike;
      sockets.push(s);
      return s;
    },
    ...over,
  });

  return {
    client,
    /** Every URL the client has actually dialled, in order. */
    dialled,
    async drop() {
      sockets[sockets.length - 1]?.close(4999, 'test drop');
      await new Promise((r) => setTimeout(r, 40));
    },
    /**
     * Synchronous, so a request can be killed in the same tick it was sent.
     * Awaiting first lets a localhost reply land in ~1ms and there is then
     * nothing in flight to test.
     */
    dropNow() {
      sockets[sockets.length - 1]?.close(4999, 'test drop');
    },
    socketCount: () => sockets.length,
  };
}

function waitForState(client: WsClient, target: ConnectionState, ms = 6000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (client.state === target) return resolve();
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for "${target}", stuck at "${client.state}"`));
    }, ms);
    const off = client.onStateChange((s) => {
      if (s === target) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
}

describe('connection lifecycle', () => {
  test('reaches live and surfaces the agent hello', async () => {
    const { client } = harness();
    const hellos: unknown[] = [];
    client.onHello((h) => hellos.push(h));

    client.connect();
    await waitForState(client, 'live');

    assert.equal(hellos.length, 1);
    const hello = hellos[0] as { tier: string; claudeAuth: { usable: boolean } };
    assert.equal(hello.tier, 'trusted');
    assert.ok('claudeAuth' in hello, 'app needs auth state to show its banner');
    client.close();
  });

  test('passes through the documented state sequence', async () => {
    const { client } = harness();
    const seen: ConnectionState[] = [];
    client.onStateChange((s) => seen.push(s));

    client.connect();
    await waitForState(client, 'live');

    assert.deepEqual(seen, ['connecting', 'handshaking', 'live']);
    client.close();
  });

  test('close() stops the reconnect loop', async () => {
    const { client, drop, socketCount } = harness();
    client.connect();
    await waitForState(client, 'live');

    client.close();
    const after = socketCount();
    await drop();
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(client.state, 'disconnected');
    assert.equal(socketCount(), after, 'a closed client must not reconnect');
  });

  test('requesting while disconnected rejects as retryable rather than hanging', async () => {
    const { client } = harness();
    await assert.rejects(
      () => client.request('system/ping', { nonce: 'x' }),
      (e: unknown) => e instanceof DisconnectedError && e.retryable,
    );
  });
});

describe('reconnection', () => {
  test('recovers automatically after an abrupt drop', async () => {
    const { client, drop } = harness();
    client.connect();
    await waitForState(client, 'live');

    await drop();
    await waitForState(client, 'live', 8000);

    const res = await client.request('system/ping', { nonce: 'after-reconnect' });
    assert.equal(res.nonce, 'after-reconnect');
    client.close();
  });

  test('in-flight requests reject as retryable when the socket dies', async () => {
    const { client, dropNow } = harness({ requestTimeoutMs: 30_000 });
    client.connect();
    await waitForState(client, 'live');

    // Kill it in the same tick, before a localhost reply can land.
    const inflight = client.request('system/ping', { nonce: 'doomed' });
    dropNow();

    await assert.rejects(
      () => inflight,
      (e: unknown) => e instanceof DisconnectedError && e.retryable,
      'callers must distinguish a lost request from a rejected one, so they can retry',
    );
    client.close();
  });

  test('backoff is bounded — repeated drops do not spin', async () => {
    const { client, drop, socketCount } = harness({ minBackoffMs: 20, maxBackoffMs: 60 });
    client.connect();
    await waitForState(client, 'live');

    const before = socketCount();
    for (let i = 0; i < 3; i++) {
      await drop();
      await waitForState(client, 'live', 8000);
    }
    // One new socket per drop, not a storm of them.
    assert.ok(socketCount() - before <= 5, `expected ~3 reconnects, saw ${socketCount() - before}`);
    client.close();
  });
});

describe('half-open sockets', () => {
  test('the heartbeat catches a socket that is open but dead', async () => {
    // Carrier NAT does exactly this: readyState stays OPEN, send() succeeds,
    // and nothing ever comes back. No platform API reveals it, so without an
    // application-level heartbeat the app sits on a corpse believing it is
    // connected.
    let goDead: (() => void) | null = null;

    const client = new WsClient({
      url,
      token: TOKEN,
      deviceId: 'halfopen',
      minBackoffMs: 20,
      maxBackoffMs: 60,
      heartbeatIntervalMs: 60,
      heartbeatTimeoutMs: 150,
      requestTimeoutMs: 5_000,
      createSocket: (u, t) => {
        const real = new WebSocket(u, {
          headers: { authorization: `Bearer ${t}` },
        }) as unknown as SocketLike;
        let alive = true;
        goDead = () => {
          alive = false;
        };

        // Wrap so that once "dead", writes vanish and replies never arrive —
        // while readyState keeps claiming OPEN.
        const facade: SocketLike = {
          get readyState() {
            return real.readyState;
          },
          send: (d) => {
            if (alive) real.send(d);
          },
          close: (c, r) => real.close(c, r),
          set onopen(fn) {
            real.onopen = fn;
          },
          get onopen() {
            return real.onopen;
          },
          set onclose(fn) {
            real.onclose = fn;
          },
          get onclose() {
            return real.onclose;
          },
          set onerror(fn) {
            real.onerror = fn;
          },
          get onerror() {
            return real.onerror;
          },
          set onmessage(fn) {
            real.onmessage = fn ? (ev) => { if (alive) fn(ev); } : null;
          },
          get onmessage() {
            return real.onmessage;
          },
        };
        return facade;
      },
    });

    client.connect();
    await waitForState(client, 'live');

    goDead?.();
    await waitForState(client, 'disconnected', 5000);
    client.close();
  });
});

describe('stream resume', () => {
  test('delivers every missed event exactly once across two reconnects', async () => {
    const { client, drop } = harness();
    client.connect();
    await waitForState(client, 'live');

    const { sessionId } = await client.request('claude/start', {});
    client.track(sessionId, 0);

    const received: Event[] = [];
    client.onEvent((e) => received.push(e));

    // Stand in for Claude: write into the session log while the client is away.
    const session = agent.sessions.get(sessionId);
    for (let i = 1; i <= 3; i++) session.log.append(E.assistantDelta, { text: `pre-${i}` });

    await drop();
    await waitForState(client, 'live', 8000);
    assert.equal(client.lastSeqOf(sessionId), 3, 'client caught up to the log head');

    for (let i = 4; i <= 5; i++) session.log.append(E.assistantDelta, { text: `post-${i}` });
    await drop();
    await waitForState(client, 'live', 8000);

    assert.equal(client.lastSeqOf(sessionId), 5);
    assert.deepEqual(
      received.map((e) => (e.body as { text: string }).text),
      ['pre-1', 'pre-2', 'pre-3', 'post-4', 'post-5'],
      'no gaps and no duplicates — this is the whole reconnect promise',
    );
    client.close();
  });

  test('a caught-up client replays nothing', async () => {
    const { client, drop } = harness();
    client.connect();
    await waitForState(client, 'live');

    const { sessionId } = await client.request('claude/start', {});
    const session = agent.sessions.get(sessionId);
    session.log.append(E.assistantDelta, { text: 'x' });
    client.track(sessionId, session.log.head);

    const received: Event[] = [];
    client.onEvent((e) => received.push(e));

    await drop();
    await waitForState(client, 'live', 8000);

    assert.equal(received.length, 0, 'a reconnect must not re-render history');
    client.close();
  });

  test('an unresumable stream is dropped without killing the connection', async () => {
    const { client, drop } = harness();
    client.connect();
    await waitForState(client, 'live');

    client.track('sess_does_not_exist', 0);
    await drop();
    await waitForState(client, 'live', 8000);

    const res = await client.request('system/ping', { nonce: 'still-alive' });
    assert.equal(res.nonce, 'still-alive', 'one bad stream must not take down the session');
    client.close();
  });

  test('live events advance lastSeq so a later reconnect resumes correctly', async () => {
    const { client, drop } = harness();
    client.connect();
    await waitForState(client, 'live');

    const { sessionId } = await client.request('claude/start', {});
    client.track(sessionId, 0);

    const session = agent.sessions.get(sessionId);
    session.log.append(E.assistantDelta, { text: 'live-1' });
    // Broadcast reaches the attached client directly.
    await new Promise((r) => setTimeout(r, 60));

    await drop();
    await waitForState(client, 'live', 8000);
    assert.equal(client.lastSeqOf(sessionId), session.log.head);
    client.close();
  });
});

/**
 * A paired agent has two addresses — the tailnet and a public tunnel — and
 * which one answers decides how much the agent will permit. So endpoint
 * selection is a security-relevant behaviour, not a convenience, and it is
 * tested here rather than left to untestable app code.
 */
describe('endpoint preference', () => {
  /** A port nothing listens on, standing in for "the tailnet is not up". */
  const DEAD = 'ws://127.0.0.1:9';

  test('dials the preferred endpoint first, then falls back', async () => {
    const { client, dialled } = harness({ url: [DEAD, url] });
    client.connect();
    await waitForState(client, 'live', 8000);

    assert.equal(dialled[0], DEAD, 'the first attempt must use the preferred endpoint');
    assert.equal(dialled[1], url, 'a failure must advance to the next endpoint');
    client.close();
  });

  test('returns to the preferred endpoint on the next connect cycle', async () => {
    // The preferred endpoint is live and the fallback is dead, so a client
    // that kept advancing after a success would dial DEAD here. It must not:
    // walking back into tailnet range has to return you to the trusted tier,
    // not leave you on the restricted public path until the app is force-quit.
    const { client, dialled, drop } = harness({ url: [url, DEAD] });
    client.connect();
    await waitForState(client, 'live');

    await drop();
    await waitForState(client, 'live', 8000);

    assert.deepEqual(dialled, [url, url], 'a fresh cycle must start at the preferred endpoint');
    client.close();
  });

  test('a single url string still works', async () => {
    const { client } = harness({ url });
    assert.deepEqual(client.endpoints, [url]);
    client.connect();
    await waitForState(client, 'live');
    client.close();
  });

  test('refuses to construct with no endpoints', () => {
    assert.throws(
      () => new WsClient({ url: [], token: TOKEN, deviceId: 'x', createSocket: () => { throw new Error('unused'); } }),
      /at least one url/,
    );
  });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { Hub } from '../src/hub.js';
import { SessionManager, registerChatOps } from '../src/chat/manager.js';
import { loadConfig } from '../src/config.js';
import { AgentClient } from '../src/client/client.js';
import { PROTOCOL_VERSION, events, type Event } from '@vff/protocol';

const E = events.EVENT_TYPES.claude;
const TOKEN = 'reconnect-test-token';

/**
 * The thesis test.
 *
 * A phone on a mobile network loses its socket constantly. If work stopped, or
 * events were lost, or a pending approval evaporated every time that happened,
 * the whole product would be unusable. These tests assert it doesn't.
 */

let server: http.Server;
let wss: WebSocketServer;
let hub: Hub;
let manager: SessionManager;
let url: string;
/** Drives the fake SDK for whichever session was created last. */
let emitToSession: ((type: string, body: unknown) => void) | null = null;
let capturedCanUseTool: CanUseTool | undefined;

before(async () => {
  hub = new Hub();
  const cfg = loadConfig({ token: TOKEN, port: 0, roots: [process.cwd()] });

  const queryFn = ((args: { options?: { canUseTool?: CanUseTool } }) => {
    capturedCanUseTool = args.options?.canUseTool;
    let release!: () => void;
    const stopped = new Promise<void>((r) => (release = r));
    const gen = (async function* () {
      await stopped;
    })();
    return Object.assign(gen, { interrupt: async () => {}, close: () => release() });
  }) as never;

  manager = new SessionManager(cfg, hub, queryFn);
  registerChatOps(hub, manager);

  // system/hello lives in server.ts; register a minimal one for this harness.
  hub.register('system/hello', ({ body, conn }) => {
    conn.deviceId = (body as { deviceId: string }).deviceId;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: 'test',
      workspaceRoot: process.cwd(),
      capabilities: { claude: true, pty: false, git: false, files: false },
    };
  });

  server = http.createServer();
  wss = new WebSocketServer({ server });
  wss.on('connection', (socket, req) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${TOKEN}`) return socket.close(4401);
    hub.add(socket);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  url = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(async () => {
  manager.closeAll();
  // Terminate any sockets the tests left open, or server.close() never
  // resolves and the whole run hangs.
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

/** Start a session and grab a handle for pushing fake SDK output into it. */
async function startSession(client: AgentClient): Promise<string> {
  const { sessionId } = await client.request('claude/start', {});
  const session = manager.get(sessionId);
  emitToSession = (type, body) => {
    // Reaches into the session's log the way the pump would.
    const entry = session.log.append(type, body);
    hub.broadcast({ kind: 'event', ch: 'claude', type, seq: entry.seq, stream: sessionId, body });
  };
  return sessionId;
}

describe('work outlives the connection', () => {
  test('events emitted while no client is attached are replayed on reattach', async () => {
    const first = new AgentClient(url, TOKEN);
    await first.connect('phone');
    const sessionId = await startSession(first);

    const seen: Event[] = [];
    first.onEvent((e) => seen.push(e));

    emitToSession!(E.assistantDelta, { text: 'before ' });
    await settle();
    assert.equal(seen.length, 1, 'attached client receives live events');

    // Phone goes into a tunnel.
    first.close();
    await settle();

    // Claude keeps working. This is the part that matters.
    emitToSession!(E.assistantDelta, { text: 'during-1 ' });
    emitToSession!(E.assistantDelta, { text: 'during-2 ' });
    emitToSession!(E.turnDone, { stopReason: 'end_turn', usage: null });

    // Phone comes back.
    const second = new AgentClient(url, TOKEN);
    await second.connect('phone');
    const res = await second.request('claude/attach', { sessionId, sinceSeq: 1 });

    assert.equal(res.truncated, false);
    assert.equal(res.replay.length, 3, 'every event missed while away is replayed');
    const texts = res.replay
      .map((r) => (r as { body: { text?: string } }).body.text)
      .filter(Boolean);
    assert.deepEqual(texts, ['during-1 ', 'during-2 ']);
    second.close();
  });

  test('reattaching at head replays nothing — no duplicate rendering', async () => {
    const client = new AgentClient(url, TOKEN);
    await client.connect('phone');
    const sessionId = await startSession(client);

    emitToSession!(E.assistantDelta, { text: 'a' });
    emitToSession!(E.assistantDelta, { text: 'b' });
    await settle();

    const head = manager.get(sessionId).log.head;
    const res = await client.request('claude/attach', { sessionId, sinceSeq: head });
    assert.equal(res.replay.length, 0);
    client.close();
  });

  test('replayed sequence numbers are contiguous, so the client can detect gaps', async () => {
    const client = new AgentClient(url, TOKEN);
    await client.connect('phone');
    const sessionId = await startSession(client);

    for (let i = 0; i < 10; i++) emitToSession!(E.assistantDelta, { text: String(i) });
    await settle();

    const res = await client.request('claude/attach', { sessionId, sinceSeq: 0 });
    const seqs = res.replay.map((r) => (r as { seq: number }).seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    client.close();
  });
});

describe('pending approvals survive a disconnect', () => {
  test('an approval asked while offline is replayed and still answerable', async () => {
    const first = new AgentClient(url, TOKEN);
    await first.connect('phone');
    const sessionId = await startSession(first);
    const session = manager.get(sessionId);

    // Phone drops before Claude asks.
    first.close();
    await settle();

    const decision = capturedCanUseTool!('Bash', { command: 'npm test' }, {
      signal: new AbortController().signal,
    });

    await settle();
    assert.equal(session.pendingPermissionIds.length, 1, 'ask waits for a device, indefinitely');

    // Phone returns and replays.
    const second = new AgentClient(url, TOKEN);
    await second.connect('phone');
    const res = await second.request('claude/attach', { sessionId, sinceSeq: 0 });

    const pending = res.replay.find((r) => (r as { type: string }).type === E.permissionPending) as
      | { body: { requestId: string } }
      | undefined;
    assert.ok(pending, 'the ask must replay — otherwise it is lost forever');

    // And answering it from the fresh socket actually resolves the SDK call.
    const applied = await second.request('claude/permission-respond', {
      sessionId,
      requestId: pending.body.requestId,
      decision: { allow: true, scope: 'once' },
    });
    assert.equal(applied.applied, true);

    const result = await decision;
    assert.equal(result.behavior, 'allow');
    second.close();
  });
});

describe('log truncation is admitted, not hidden', () => {
  test('a client too far behind is told its history was dropped', async () => {
    const client = new AgentClient(url, TOKEN);
    await client.connect('phone');
    const sessionId = await startSession(client);
    const session = manager.get(sessionId);

    // Force eviction well past what a stale client would have seen.
    for (let i = 0; i < 5000; i++) session.log.append(E.assistantDelta, { text: 'x' });

    const res = await client.request('claude/attach', { sessionId, sinceSeq: 2 });
    assert.equal(res.truncated, true, 'a discontinuous transcript must never be shown silently');
    client.close();
  });
});

function settle(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

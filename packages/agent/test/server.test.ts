import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { start, type RunningAgent } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { AgentClient, RemoteError } from '../src/client/client.js';
import { serializeEnvelope, PROTOCOL_VERSION } from '@vff/protocol';

const TOKEN = 'test-token-not-a-real-secret';
let agent: RunningAgent;
let url: string;

before(async () => {
  agent = await start(loadConfig({ token: TOKEN, listeners: { trusted: { port: 0 }, public: { port: 0 } }, roots: [process.cwd()] }));
  url = `ws://127.0.0.1:${agent.ports.trusted}`;
});

after(async () => {
  await agent.close();
});

describe('authentication', () => {
  test('rejects a connection with no token', async () => {
    const ws = new WebSocket(url);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', resolve);
      ws.on('error', () => {});
    });
    assert.equal(code, 4401);
  });

  test('rejects a wrong token', async () => {
    const ws = new WebSocket(url, { headers: { authorization: 'Bearer wrong' } });
    const code = await new Promise<number>((resolve) => {
      ws.on('close', resolve);
      ws.on('error', () => {});
    });
    assert.equal(code, 4401);
  });

  test('accepts the configured token and completes a handshake', async () => {
    const c = new AgentClient(url, TOKEN);
    const hello = await c.connect();
    assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
    assert.ok(hello.agentVersion);
    assert.ok(hello.workspaceRoot);
    c.close();
  });
});

describe('handshake gating', () => {
  test('refuses ops before system/hello', async () => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    await new Promise((r) => ws.once('open', r));

    ws.send(
      serializeEnvelope({
        kind: 'req',
        id: 'x1',
        ch: 'system',
        op: 'ping',
        body: { nonce: 'n' },
      }),
    );

    const reply = JSON.parse(String(await once(ws, 'message')));
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'unauthorized');
    ws.close();
  });

  test('rejects a protocol version mismatch with an actionable message', async () => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    await new Promise((r) => ws.once('open', r));

    ws.send(
      serializeEnvelope({
        kind: 'req',
        id: 'x2',
        ch: 'system',
        op: 'hello',
        body: { protocolVersion: 999, deviceId: 'd', clientVersion: '0.0.0' },
      }),
    );

    const reply = JSON.parse(String(await once(ws, 'message')));
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /Protocol version mismatch/);
    assert.match(reply.error.message, /Update whichever side is older/);
    ws.close();
  });
});

describe('request handling', () => {
  let client: AgentClient;

  before(async () => {
    client = new AgentClient(url, TOKEN);
    await client.connect();
  });
  after(() => client.close());

  test('ping round-trips the nonce', async () => {
    const res = await client.request('system/ping', { nonce: 'abc123' });
    assert.equal(res.nonce, 'abc123');
    assert.ok(res.serverTime > 0);
  });

  test('unknown ops fail with unsupported_op, not a crash', async () => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    await new Promise((r) => ws.once('open', r));
    ws.send(
      serializeEnvelope({
        kind: 'req',
        id: 'h',
        ch: 'system',
        op: 'hello',
        body: { protocolVersion: PROTOCOL_VERSION, deviceId: 'd', clientVersion: '0' },
      }),
    );
    await once(ws, 'message');

    ws.send(
      serializeEnvelope({ kind: 'req', id: 'x3', ch: 'git', op: 'nonsense', body: {} }),
    );
    const reply = JSON.parse(String(await once(ws, 'message')));
    assert.equal(reply.error.code, 'unsupported_op');
    ws.close();
  });

  test('a malformed body is rejected as bad_request', async () => {
    await assert.rejects(
      // nonce must be a string
      () => client.request('system/ping', { nonce: 42 as unknown as string }),
      (err: unknown) => err instanceof RemoteError && err.wire.code === 'bad_request',
    );
  });

  test('a garbage frame does not kill the connection', async () => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    await new Promise((r) => ws.once('open', r));

    ws.send('this is not json');
    ws.send(
      serializeEnvelope({
        kind: 'req',
        id: 'h2',
        ch: 'system',
        op: 'hello',
        body: { protocolVersion: PROTOCOL_VERSION, deviceId: 'd', clientVersion: '0' },
      }),
    );

    const reply = JSON.parse(String(await once(ws, 'message')));
    assert.equal(reply.ok, true, 'connection survived the garbage frame');
    ws.close();
  });

  test('concurrent requests correlate to the right replies', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        client.request('system/ping', { nonce: `n${i}` }),
      ),
    );
    results.forEach((r, i) => assert.equal(r.nonce, `n${i}`));
  });
});

describe('startup guards', () => {
  test('refuses to run without a token', async () => {
    await assert.rejects(
      () => start(loadConfig({ token: '', listeners: { trusted: { port: 0 }, public: null } })),
      /will not run unauthenticated/,
    );
  });

  test('refuses to bind 0.0.0.0 without an explicit override', async () => {
    await assert.rejects(
      () => start(loadConfig({ token: 't', host: '0.0.0.0', listeners: { trusted: { port: 0 }, public: null } })),
      /Refusing to bind 0\.0\.0\.0/,
    );
  });
});

function once(ws: WebSocket, event: 'message'): Promise<unknown> {
  return new Promise((resolve) => ws.once(event, resolve));
}

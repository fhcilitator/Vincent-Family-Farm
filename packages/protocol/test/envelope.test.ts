import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvelope,
  serializeEnvelope,
  EnvelopeSchema,
  OP_REGISTRY,
  opName,
  splitOp,
  PROTOCOL_VERSION,
  type Envelope,
} from '../src/index.js';

describe('envelope round-trip', () => {
  const cases: Envelope[] = [
    { kind: 'req', id: 'a1', ch: 'files', op: 'read', body: { path: 'src/x.ts' } },
    { kind: 'res', id: 'a1', ok: true, body: { path: 'src/x.ts' } },
    {
      kind: 'res',
      id: 'a1',
      ok: false,
      error: { code: 'path_outside_workspace', message: 'nope' },
    },
    {
      kind: 'event',
      ch: 'claude',
      type: 'claude/assistant-delta',
      seq: 7,
      stream: 'sess_1',
      body: { text: 'hi' },
    },
  ];

  for (const [i, env] of cases.entries()) {
    test(`case ${i} survives serialize -> parse`, () => {
      assert.deepEqual(parseEnvelope(serializeEnvelope(env)), env);
    });
  }
});

describe('envelope rejects malformed frames', () => {
  const bad = [
    '{}',
    '{"kind":"req"}',
    '{"kind":"nope","id":"x"}',
    // res must discriminate on ok
    '{"kind":"res","id":"x"}',
    // unknown channel
    '{"kind":"req","id":"x","ch":"nope","op":"read","body":{}}',
    // negative seq
    '{"kind":"event","ch":"pty","type":"pty/data","seq":-1,"stream":"p","body":{}}',
    // unknown error code
    '{"kind":"res","id":"x","ok":false,"error":{"code":"bogus","message":"m"}}',
  ];

  for (const raw of bad) {
    test(`rejects ${raw.slice(0, 48)}`, () => {
      assert.throws(() => parseEnvelope(raw));
    });
  }

  test('rejects a frame over the size cap', () => {
    const huge = JSON.stringify({
      kind: 'req',
      id: 'x',
      ch: 'files',
      op: 'write',
      body: { content: 'x'.repeat(5 * 1024 * 1024) },
    });
    assert.throws(() => parseEnvelope(huge), /MAX_FRAME_BYTES/);
  });
});

describe('op registry', () => {
  test('every registry key splits back to its channel and op', () => {
    for (const key of Object.keys(OP_REGISTRY)) {
      const { ch, op } = splitOp(key as keyof typeof OP_REGISTRY);
      assert.equal(opName(ch, op), key, `${key} did not round-trip`);
    }
  });

  test('unknown ops resolve to null rather than throwing', () => {
    assert.equal(opName('files', 'definitely-not-real'), null);
  });

  test('every op has both a request and response schema', () => {
    for (const [key, entry] of Object.entries(OP_REGISTRY)) {
      assert.ok(entry.req, `${key} missing req schema`);
      assert.ok(entry.res, `${key} missing res schema`);
    }
  });

  test('protocol version is a positive integer', () => {
    assert.ok(Number.isInteger(PROTOCOL_VERSION) && PROTOCOL_VERSION > 0);
  });
});

describe('permission decisions are a closed union', () => {
  test('allow carries no deny-only fields and vice versa', () => {
    const schema = OP_REGISTRY['claude/permission-respond'].req;
    const allow = schema.parse({
      sessionId: 's',
      requestId: 'r',
      decision: { allow: true },
    });
    assert.equal(allow.decision.allow, true);

    const deny = schema.parse({
      sessionId: 's',
      requestId: 'r',
      decision: { allow: false, message: 'no' },
    });
    assert.equal(deny.decision.allow, false);

    // Missing discriminator must fail rather than defaulting to allow.
    assert.throws(() =>
      schema.parse({ sessionId: 's', requestId: 'r', decision: { message: 'x' } }),
    );
  });

  test('scope defaults to once, never to session', () => {
    const schema = OP_REGISTRY['claude/permission-respond'].req;
    const parsed = schema.parse({
      sessionId: 's',
      requestId: 'r',
      decision: { allow: true },
    });
    assert.equal(parsed.decision.allow && parsed.decision.scope, 'once');
  });
});

describe('path-bearing ops reject absolute and traversal paths at the edge', () => {
  test('files/read accepts a relative path', () => {
    const parsed = OP_REGISTRY['files/read'].req.parse({ path: 'src/a.ts' });
    assert.equal(parsed.path, 'src/a.ts');
  });

  test('oversized paths are rejected', () => {
    assert.throws(() => OP_REGISTRY['files/read'].req.parse({ path: 'a'.repeat(2000) }));
  });
});

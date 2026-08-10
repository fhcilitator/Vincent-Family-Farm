import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chatReducer, appendUserMessage, initialChatState, type ChatState } from '../src/chat-reducer.js';
import { events, type Event } from '@vff/protocol';

const E = events.EVENT_TYPES.claude;

let seq = 0;
function ev(type: string, body: unknown, atSeq?: number): Event {
  return {
    kind: 'event',
    ch: 'claude',
    type,
    seq: atSeq ?? ++seq,
    stream: 's1',
    body,
  };
}
function fold(state: ChatState, ...list: Event[]): ChatState {
  return list.reduce(chatReducer, state);
}

describe('streaming text', () => {
  test('deltas concatenate into one bubble', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.assistantDelta, { text: 'Hello' }),
      ev(E.assistantDelta, { text: ', ' }),
      ev(E.assistantDelta, { text: 'world' }),
    );
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0]?.kind, 'assistant');
    assert.equal((s.items[0] as { text: string }).text, 'Hello, world');
    assert.equal((s.items[0] as { streaming: boolean }).streaming, true);
  });

  test('assistant-end closes the bubble so the cursor stops', () => {
    seq = 0;
    const s = fold(initialChatState, ev(E.assistantDelta, { text: 'hi' }), ev(E.assistantEnd, {}));
    assert.equal((s.items[0] as { streaming: boolean }).streaming, false);
  });

  test('a new delta after a close starts a fresh bubble', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.assistantDelta, { text: 'one' }),
      ev(E.assistantEnd, {}),
      ev(E.assistantDelta, { text: 'two' }),
    );
    assert.equal(s.items.length, 2);
  });
});

describe('idempotence — the property reconnect depends on', () => {
  test('replaying an overlapping range changes nothing', () => {
    seq = 0;
    const a = ev(E.assistantDelta, { text: 'a' });
    const b = ev(E.assistantDelta, { text: 'b' });

    const once = fold(initialChatState, a, b);
    // The agent replays from an earlier point after a reconnect; folding the
    // same events again must not double the text.
    const twice = fold(once, a, b);

    assert.deepEqual(twice.items, once.items);
    assert.equal(twice.lastSeq, once.lastSeq);
  });

  test('an out-of-order (stale) event is ignored', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.assistantDelta, { text: 'first' }, 5),
      ev(E.assistantDelta, { text: 'stale' }, 2),
    );
    assert.equal((s.items[0] as { text: string }).text, 'first');
    assert.equal(s.lastSeq, 5);
  });

  test('an unknown event type advances lastSeq without rendering', () => {
    // Dropping it entirely would look like a gap and cause a pointless
    // re-attach loop against a newer agent.
    seq = 0;
    const s = fold(initialChatState, ev('claude/some-future-event', { x: 1 }));
    assert.equal(s.items.length, 0);
    assert.equal(s.lastSeq, 1);
  });
});

describe('tool cards', () => {
  test('a tool call closes the current bubble and adds a card', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.assistantDelta, { text: 'let me look' }),
      ev(E.toolUse, { toolUseId: 't1', toolName: 'Read', summary: 'Read · a.ts', input: {} }),
    );
    assert.equal(s.items.length, 2);
    assert.equal((s.items[0] as { streaming: boolean }).streaming, false);
    assert.equal(s.items[1]?.kind, 'tool');
  });

  test('a result attaches to its own card, not the newest one', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.toolUse, { toolUseId: 't1', toolName: 'Read', summary: 'a', input: {} }),
      ev(E.toolUse, { toolUseId: 't2', toolName: 'Read', summary: 'b', input: {} }),
      ev(E.toolResult, { toolUseId: 't1', ok: true, preview: 'contents', truncated: false }),
    );
    const cards = s.items.filter((i) => i.kind === 'tool') as Array<{
      toolUseId: string;
      result: unknown;
    }>;
    assert.equal(cards[0]?.result !== null, true, 't1 got its result');
    assert.equal(cards[1]?.result, null, 't2 must be untouched — tools resolve out of order');
  });

  test('a result for an unknown tool id is harmless', () => {
    seq = 0;
    assert.doesNotThrow(() =>
      fold(initialChatState, ev(E.toolResult, { toolUseId: 'ghost', ok: true, preview: '', truncated: false })),
    );
  });
});

describe('permissions', () => {
  const pending = (requestId: string) => ({
    requestId,
    toolName: 'Bash',
    input: { command: 'npm test' },
    render: {
      title: 'Run a command',
      subtitle: '~/code',
      body: { kind: 'command' as const, value: 'npm test' },
      risk: 'medium' as const,
    },
    expiresAt: null,
  });

  test('a pending ask enters the set and resolution removes it', () => {
    seq = 0;
    let s = fold(initialChatState, ev(E.permissionPending, pending('r1')));
    assert.equal(Object.keys(s.pendingPermissions).length, 1);

    s = fold(s, ev(E.permissionResolved, { requestId: 'r1', allowed: true, by: 'device' }));
    assert.equal(Object.keys(s.pendingPermissions).length, 0);
  });

  test('several asks can be outstanding at once', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.permissionPending, pending('r1')),
      ev(E.permissionPending, pending('r2')),
    );
    assert.equal(Object.keys(s.pendingPermissions).length, 2);
  });

  test('resolving one leaves the other pending', () => {
    seq = 0;
    let s = fold(
      initialChatState,
      ev(E.permissionPending, pending('r1')),
      ev(E.permissionPending, pending('r2')),
    );
    s = fold(s, ev(E.permissionResolved, { requestId: 'r1', allowed: false, by: 'timeout' }));
    assert.deepEqual(Object.keys(s.pendingPermissions), ['r2']);
  });

  test('resolving an unknown id does not throw or clear others', () => {
    seq = 0;
    let s = fold(initialChatState, ev(E.permissionPending, pending('r1')));
    s = fold(s, ev(E.permissionResolved, { requestId: 'ghost', allowed: true, by: 'device' }));
    assert.equal(Object.keys(s.pendingPermissions).length, 1);
  });
});

describe('status surfaces', () => {
  test('rate limit is stored for the header badge', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.rateLimit, {
        status: 'allowed_warning',
        limitType: 'five_hour',
        utilization: 0.78,
        resetsAt: null,
        summary: '78% of your 5-hour limit used.',
      }),
    );
    assert.equal(s.rateLimit?.status, 'allowed_warning');
    assert.match(s.rateLimit?.summary ?? '', /78%/);
  });

  test('auth trouble is stored for the banner', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.authTrouble, { message: 'expired', remedy: 'run claude' }),
    );
    assert.equal(s.authTrouble?.message, 'expired');
  });

  test('thinking toggles and turn-done clears it', () => {
    seq = 0;
    let s = fold(initialChatState, ev(E.thinking, { active: true }));
    assert.equal(s.thinking, true);
    s = fold(s, ev(E.turnDone, { stopReason: 'end_turn', usage: null }));
    assert.equal(s.thinking, false);
  });

  test('turn-done records tokens and ignores cost', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.turnDone, {
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 50, costUsd: null },
      }),
    );
    assert.deepEqual(s.usage, { inputTokens: 100, outputTokens: 50 });
    assert.ok(!('costUsd' in (s.usage ?? {})), 'cost is meaningless under a subscription');
  });
});

describe('failures are rendered, not swallowed', () => {
  test('an error becomes a visible item', () => {
    seq = 0;
    const s = fold(initialChatState, ev(E.error, { message: 'boom', fatal: true }));
    assert.equal(s.items[0]?.kind, 'error');
  });

  test('truncation renders an explicit marker rather than a silent gap', () => {
    seq = 0;
    const s = fold(
      initialChatState,
      ev(E.assistantDelta, { text: 'a' }),
      ev(E.truncated, { droppedEvents: 42 }),
    );
    const marker = s.items.find((i) => i.kind === 'truncation') as { droppedEvents: number };
    assert.equal(marker.droppedEvents, 42, 'a discontinuous transcript must admit the gap');
  });
});

describe('local echo', () => {
  test('user messages append and close any open bubble', () => {
    seq = 0;
    let s = fold(initialChatState, ev(E.assistantDelta, { text: 'hi' }));
    s = appendUserMessage(s, 'do the thing', 'u1');

    assert.equal(s.items.length, 2);
    assert.equal((s.items[0] as { streaming: boolean }).streaming, false);
    assert.equal(s.items[1]?.kind, 'user');
  });

  test('local echo does not touch lastSeq', () => {
    // It is not a wire event; advancing seq here would make the client think
    // it had seen something the agent never sent.
    const s = appendUserMessage(initialChatState, 'hi', 'u1');
    assert.equal(s.lastSeq, 0);
  });
});

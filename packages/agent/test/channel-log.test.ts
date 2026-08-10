import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelLog } from '../src/channel-log.js';

describe('ChannelLog sequencing', () => {
  test('seq starts at 1 and increases by one', () => {
    const log = new ChannelLog('claude', 's1');
    assert.equal(log.head, 0);
    assert.equal(log.append('a', {}).seq, 1);
    assert.equal(log.append('b', {}).seq, 2);
    assert.equal(log.head, 2);
  });

  test('since(0) returns the whole retained log', () => {
    const log = new ChannelLog('claude', 's1');
    log.append('a', {});
    log.append('b', {});
    const r = log.since(0);
    assert.equal(r.events.length, 2);
    assert.equal(r.truncated, false);
    assert.equal(r.head, 2);
  });

  test('since(head) returns nothing — the caller is caught up', () => {
    const log = new ChannelLog('claude', 's1');
    log.append('a', {});
    log.append('b', {});
    const r = log.since(2);
    assert.equal(r.events.length, 0);
    assert.equal(r.truncated, false);
  });

  test('since(n) returns strictly the events after n', () => {
    const log = new ChannelLog('claude', 's1');
    for (let i = 0; i < 5; i++) log.append('e', { i });
    const r = log.since(3);
    assert.deepEqual(
      r.events.map((e) => e.seq),
      [4, 5],
    );
  });
});

describe('ChannelLog bounds', () => {
  test('evicts oldest past maxEvents and reports the drop', () => {
    const log = new ChannelLog('pty', 'p1', 10);
    for (let i = 0; i < 25; i++) log.append('d', { i });

    assert.equal(log.head, 25);
    assert.equal(log.since(0).events.length, 10);
    assert.ok(log.droppedCount >= 15);
    // Seq numbers keep counting even though early events are gone.
    assert.equal(log.oldestSeq, 16);
  });

  test('evicts on the byte bound even when event count is low', () => {
    // One 'cat bigfile' must not blow memory just because it is few events.
    const log = new ChannelLog('pty', 'p1', 10_000, 4096);
    for (let i = 0; i < 20; i++) log.append('d', { chunk: 'x'.repeat(1000) });

    assert.ok(log.since(0).events.length < 20, 'expected byte-bound eviction');
    assert.ok(log.droppedCount > 0);
  });

  test('never evicts down to an empty log', () => {
    const log = new ChannelLog('pty', 'p1', 10_000, 1);
    log.append('d', { chunk: 'x'.repeat(10_000) });
    assert.equal(log.since(0).events.length, 1);
  });
});

describe('ChannelLog truncation signalling', () => {
  test('flags truncation when the caller asks for evicted events', () => {
    const log = new ChannelLog('claude', 's1', 5);
    for (let i = 0; i < 20; i++) log.append('e', { i });

    // Client last saw seq 2, which is long gone.
    const r = log.since(2);
    assert.equal(r.truncated, true, 'must admit the gap rather than showing a hole');
  });

  test('does not flag truncation when the caller is within the retained window', () => {
    const log = new ChannelLog('claude', 's1', 100);
    for (let i = 0; i < 10; i++) log.append('e', { i });
    assert.equal(log.since(5).truncated, false);
  });

  test('treats a client ahead of head as a full resync', () => {
    // Happens when the agent restarted and reset its counter.
    const log = new ChannelLog('claude', 's1');
    log.append('a', {});
    const r = log.since(999);
    assert.equal(r.truncated, true);
    assert.equal(r.events.length, 1);
  });
});

describe('ChannelLog envelope shape', () => {
  test('wraps events with the log channel and stream', () => {
    const log = new ChannelLog('claude', 'sess_42');
    const env = log.toEnvelope(log.append('claude/assistant-delta', { text: 'hi' }));
    assert.equal(env.kind, 'event');
    assert.equal(env.ch, 'claude');
    assert.equal(env.stream, 'sess_42');
    assert.equal(env.seq, 1);
    assert.deepEqual(env.body, { text: 'hi' });
  });

  test('handles unserializable bodies without throwing', () => {
    const log = new ChannelLog('claude', 's1');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.doesNotThrow(() => log.append('weird', circular));
  });
});

#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AgentClient, RemoteError } from './client.js';
import { events, type Event } from '@vff/protocol';

/**
 * Terminal client speaking the real protocol.
 *
 * Exists so the agent is drivable without a phone: it finds protocol bugs in
 * seconds rather than through a rebuild-deploy-squint cycle, and it is how
 * the chat and permission flows get exercised before any React Native does.
 *
 *   VIBE_TOKEN=... npm run harness -w @vff/agent -- ws://127.0.0.1:8787
 */

const E = events.EVENT_TYPES.claude;

const url = process.argv[2] ?? `ws://127.0.0.1:${process.env.VIBE_PORT ?? 8787}`;
const token = process.env.VIBE_TOKEN;

if (!token) {
  console.error("Set VIBE_TOKEN to the agent's token.");
  process.exit(1);
}

const client = new AgentClient(url, token);

let sessionId: string | null = null;
let lastSeq = 0;
/** Asks awaiting a y/n, newest last. */
const pendingAsks: Array<{ requestId: string; title: string }> = [];

client.onEvent(handleEvent);

console.log(`connecting to ${url} ...`);
try {
  const hello = await client.connect('repl');
  console.log(`connected to agent ${hello.agentVersion} (protocol ${hello.protocolVersion})`);
  console.log(`workspace: ${hello.workspaceRoot}`);
  console.log(`capabilities: ${JSON.stringify(hello.capabilities)}\n`);
} catch (err) {
  console.error('connect failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}

printHelp();

const rl = readline.createInterface({ input: stdin, output: stdout, prompt: '> ' });
rl.prompt();

rl.on('line', (line) => {
  // Serialize handling: readline fires 'line' eagerly, and overlapping async
  // handlers would interleave output and reorder commands.
  queue = queue.then(() => handleLine(line)).catch(reportError);
  queue = queue.then(() => rl.prompt());
});
let queue: Promise<void> = Promise.resolve();

rl.on('close', () => {
  client.close();
  process.exit(0);
});

function handleEvent(e: Event): void {
  if (e.stream === sessionId) lastSeq = Math.max(lastSeq, e.seq);

  switch (e.type) {
    case E.assistantDelta: {
      stdout.write((e.body as { text?: string }).text ?? '');
      return;
    }
    case E.assistantEnd:
      stdout.write('\n');
      return;

    case E.toolUse: {
      const b = e.body as { summary: string };
      console.log(`\n  [tool] ${b.summary}`);
      return;
    }

    case E.permissionPending: {
      const b = e.body as {
        requestId: string;
        render: { title: string; body: { value: string }; risk: string };
      };
      pendingAsks.push({ requestId: b.requestId, title: b.render.title });
      console.log(
        `\n  ┌─ PERMISSION (${b.render.risk.toUpperCase()} risk)\n` +
          `  │ ${b.render.title}\n` +
          b.render.body.value
            .split('\n')
            .slice(0, 12)
            .map((l) => `  │   ${l}`)
            .join('\n') +
          `\n  └─ /y to allow, /n to deny\n`,
      );
      return;
    }

    case E.permissionResolved: {
      const b = e.body as { requestId: string; allowed: boolean; by: string };
      const idx = pendingAsks.findIndex((p) => p.requestId === b.requestId);
      if (idx >= 0) pendingAsks.splice(idx, 1);
      if (b.by !== 'device') {
        console.log(`  [permission ${b.allowed ? 'allowed' : 'denied'} by ${b.by}]`);
      }
      return;
    }

    case E.turnDone: {
      const b = e.body as { usage: { costUsd: number | null } | null };
      const cost = b.usage?.costUsd;
      console.log(`  [turn done${cost != null ? ` · $${cost.toFixed(4)}` : ''}]`);
      return;
    }

    case E.error:
      console.error(`  [error] ${(e.body as { message: string }).message}`);
      return;

    default:
      return;
  }
}

async function handleLine(line: string): Promise<void> {
  const input = line.trim();
  if (!input) return;

  const [cmd, ...rest] = input.split(/\s+/);

  switch (cmd) {
    case '/help':
      return printHelp();

    case '/ping': {
      const started = Date.now();
      await client.request('system/ping', { nonce: String(started) });
      console.log(`pong in ${Date.now() - started}ms`);
      return;
    }

    case '/new': {
      const res = await client.request('claude/start', {
        ...(rest[0] ? { cwd: rest[0] } : {}),
      });
      sessionId = res.sessionId;
      lastSeq = 0;
      console.log(`session ${sessionId} started`);
      return;
    }

    case '/attach': {
      const id = rest[0] ?? sessionId;
      if (!id) return console.error('usage: /attach <sessionId>');
      const res = await client.request('claude/attach', { sessionId: id, sinceSeq: lastSeq });
      sessionId = id;
      if (res.truncated) console.log('  [earlier output was dropped from the log]');
      console.log(`replayed ${res.replay.length} events (head ${res.head}, running=${res.running})`);
      lastSeq = res.head;
      return;
    }

    case '/sessions': {
      const res = await client.request('claude/list-sessions', { limit: 20 });
      if (!res.sessions.length) console.log('  (none)');
      for (const s of res.sessions) {
        console.log(`  ${s.sessionId}${s.running ? ' [running]' : ''}`);
      }
      return;
    }

    case '/y':
    case '/n':
      return respond(cmd === '/y');

    case '/stop': {
      if (!sessionId) return console.error('no session');
      await client.request('claude/interrupt', { sessionId });
      console.log('  [interrupt sent]');
      return;
    }

    case '/raw': {
      const [op, ...jsonParts] = rest;
      if (!op) return console.error('usage: /raw <channel/op> <json body>');
      const body = jsonParts.length ? JSON.parse(jsonParts.join(' ')) : {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      console.log(JSON.stringify(await client.request(op as any, body), null, 2));
      return;
    }

    case '/quit':
      rl.close();
      return;

    default:
      if (cmd?.startsWith('/')) return console.error(`unknown command ${cmd} — try /help`);
      if (!sessionId) return console.error('no session — run /new first');
      await client.request('claude/send', { sessionId, text: input });
  }
}

async function respond(allow: boolean): Promise<void> {
  const ask = pendingAsks[0];
  if (!ask || !sessionId) return console.error('nothing awaiting a decision');

  const res = await client.request('claude/permission-respond', {
    sessionId,
    requestId: ask.requestId,
    decision: allow ? { allow: true, scope: 'once' } : { allow: false, message: 'Denied from REPL' },
  });
  if (!res.applied) console.log('  [already resolved — timed out or answered elsewhere]');
}

function reportError(err: unknown): void {
  if (err instanceof RemoteError) console.error(`error [${err.wire.code}] ${err.wire.message}`);
  else console.error('error:', err instanceof Error ? err.message : err);
}

function printHelp(): void {
  console.log(
    [
      'commands:',
      '  /new [cwd]           start a Claude session',
      '  <text>               send a message to it',
      '  /y  /n               allow or deny the pending tool call',
      '  /stop                interrupt the current turn',
      '  /attach [id]         re-attach and replay missed events',
      '  /sessions            list live sessions',
      '  /ping                round-trip latency',
      '  /raw <ch/op> <json>  send any registered op',
      '  /quit',
      '',
    ].join('\n'),
  );
}

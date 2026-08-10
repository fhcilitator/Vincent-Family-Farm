#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { AgentClient, RemoteError } from './client.js';
import type { Event } from '@vff/protocol';

/**
 * Terminal client speaking the real protocol.
 *
 * This exists so the agent is drivable without a phone. It finds protocol
 * bugs in seconds instead of via a rebuild-deploy-squint cycle, and it
 * doubles as the dogfooding tool that keeps the latency story honest.
 *
 *   VIBE_TOKEN=... npm run harness -w @vff/agent -- ws://127.0.0.1:8787
 */

const url = process.argv[2] ?? `ws://127.0.0.1:${process.env.VIBE_PORT ?? 8787}`;
const token = process.env.VIBE_TOKEN;

if (!token) {
  console.error('Set VIBE_TOKEN to the agent\'s token.');
  process.exit(1);
}

const client = new AgentClient(url, token);

client.onEvent((e: Event) => {
  // Claude text deltas are the common case — print them inline so a streaming
  // turn reads like a conversation rather than a log dump.
  if (e.type === 'claude/assistant-delta') {
    const body = e.body as { text?: string };
    stdout.write(body.text ?? '');
    return;
  }
  console.log(`\n[event ${e.seq}] ${e.type} ${JSON.stringify(e.body)}`);
});

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

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) return rl.prompt();

  try {
    await handle(input);
  } catch (err) {
    if (err instanceof RemoteError) {
      console.error(`error [${err.wire.code}] ${err.wire.message}`);
    } else {
      console.error('error:', err instanceof Error ? err.message : err);
    }
  }
  rl.prompt();
});

rl.on('close', () => {
  client.close();
  process.exit(0);
});

async function handle(input: string): Promise<void> {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(' ');

  switch (cmd) {
    case '/help':
      printHelp();
      return;

    case '/ping': {
      const started = Date.now();
      const res = await client.request('system/ping', { nonce: String(started) });
      console.log(`pong in ${Date.now() - started}ms (server clock ${res.serverTime})`);
      return;
    }

    case '/quit':
      rl.close();
      return;

    // Raw escape hatch: /raw <ch/op> <json>. Lets a new op be exercised the
    // moment the agent gains it, without touching this file.
    case '/raw': {
      const [op, ...jsonParts] = rest;
      if (!op) {
        console.error('usage: /raw <channel/op> <json body>');
        return;
      }
      const body = jsonParts.length ? JSON.parse(jsonParts.join(' ')) : {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await client.request(op as any, body);
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    default:
      if (cmd?.startsWith('/')) {
        console.error(`unknown command ${cmd} — try /help`);
        return;
      }
      // Bare text will become a Claude prompt once the chat channel lands in
      // phase 2. Until then, say so rather than silently doing nothing.
      console.log(`(chat not wired up yet — phase 2. You typed: ${JSON.stringify(input)})`);
      void arg;
  }
}

function printHelp(): void {
  console.log(
    [
      'commands:',
      '  /ping              round-trip latency to the agent',
      '  /raw <ch/op> <json>  send any registered op directly',
      '  /help              this list',
      '  /quit              disconnect',
      '  <text>             chat with Claude (phase 2)',
      '',
    ].join('\n'),
  );
}

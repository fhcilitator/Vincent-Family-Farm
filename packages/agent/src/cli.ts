#!/usr/bin/env node
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { start } from './server.js';

const [, , command = 'start'] = process.argv;

switch (command) {
  case 'start':
    await runStart();
    break;
  case 'token':
    console.log(crypto.randomBytes(32).toString('base64url'));
    break;
  default:
    console.error(`Unknown command: ${command}\n\nUsage: vibe-agent [start|token]`);
    process.exit(1);
}

async function runStart(): Promise<void> {
  const cfg = loadConfig();
  const agent = await start(cfg);

  console.log(`vibe-agent listening on ws://${cfg.host}:${agent.port}`);
  console.log(`  roots: ${cfg.roots.join(', ')}`);
  console.log(`  permission timeout: ${cfg.permissionTimeoutMs}ms`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} — shutting down`);
    await agent.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

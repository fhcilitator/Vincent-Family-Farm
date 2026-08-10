#!/usr/bin/env node
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { start } from './server.js';
import { checkClaudeAuth } from './preflight.js';

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

  if (agent.ports.trusted) {
    console.log(`vibe-agent [trusted] ws://${cfg.host}:${agent.ports.trusted}`);
    console.log(`    expose with: tailscale serve --bg ${agent.ports.trusted}`);
  }
  if (agent.ports.public) {
    console.log(`vibe-agent [public]  ws://${cfg.host}:${agent.ports.public}`);
    console.log(`    expose with: tailscale funnel --bg ${agent.ports.public}`);
    console.log(`            or:  cloudflared tunnel --url http://${cfg.host}:${agent.ports.public}`);
  }
  const auth = checkClaudeAuth();
  console.log(`  claude: ${auth.usable ? 'ok' : 'UNAVAILABLE'} — ${auth.detail}`);
  if (auth.remedy) console.log(`          fix: ${auth.remedy}`);
  console.log(`  roots: ${cfg.roots.join(', ')}`);
  console.log(`  permission timeout: ${cfg.permissionTimeoutMs}ms trusted / ` +
    `${cfg.publicPermissionTimeoutMs}ms public`);

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} — shutting down`);
    await agent.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

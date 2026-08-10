import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@vff/protocol';
import { Hub, WireErr } from './hub.js';
import { SessionManager, registerChatOps } from './chat/manager.js';
import type { AgentConfig } from './config.js';

export interface RunningAgent {
  hub: Hub;
  sessions: SessionManager;
  port: number;
  close(): Promise<void>;
}

const AGENT_VERSION = '0.1.0';

export async function start(cfg: AgentConfig): Promise<RunningAgent> {
  if (cfg.host === '0.0.0.0' && process.env.VIBE_I_KNOW_WHAT_IM_DOING !== '1') {
    throw new Error(
      'Refusing to bind 0.0.0.0. This agent executes arbitrary commands; bind ' +
        '127.0.0.1 and front it with a tunnel, or set VIBE_I_KNOW_WHAT_IM_DOING=1.',
    );
  }
  if (!cfg.token) {
    throw new Error('No token configured. Set VIBE_TOKEN — the agent will not run unauthenticated.');
  }

  const hub = new Hub();
  const sessions = new SessionManager(cfg, hub);
  registerSystemOps(hub, cfg);
  registerChatOps(hub, sessions);

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agentVersion: AGENT_VERSION }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024 });

  wss.on('connection', (socket, req) => {
    // Bearer token on the upgrade request. Not a query param — those land in
    // proxy and server logs.
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!timingSafeEqual(presented, cfg.token)) {
      socket.close(4401, 'unauthorized');
      return;
    }
    hub.add(socket);
  });

  const stopHeartbeat = hub.startHeartbeat();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;

  return {
    hub,
    sessions,
    port,
    async close() {
      stopHeartbeat();
      sessions.closeAll();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function registerSystemOps(hub: Hub, cfg: AgentConfig): void {
  hub.register('system/hello', ({ body, conn }) => {
    const hello = body as { protocolVersion: number; deviceId: string; clientVersion: string };

    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      throw new WireErr(
        'bad_request',
        `Protocol version mismatch: agent speaks ${PROTOCOL_VERSION}, client sent ` +
          `${hello.protocolVersion}. Update whichever side is older.`,
      );
    }

    conn.deviceId = hello.deviceId;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentVersion: AGENT_VERSION,
      workspaceRoot: cfg.roots[0] ?? process.cwd(),
      capabilities: {
        // Flipped on as each phase lands, so the app greys out dead UI rather
        // than erroring on it.
        claude: true,
        pty: false,
        git: false,
        files: false,
      },
    };
  });

  hub.register('system/ping', ({ body }) => {
    const { nonce } = body as { nonce: string };
    return { nonce, serverTime: Date.now() };
  });
}

/** Constant-time compare so token checks don't leak length or prefix by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, type TrustTier } from '@vff/protocol';
import { Hub, WireErr } from './hub.js';
import { SessionManager, registerChatOps } from './chat/manager.js';
import { policyFor, type AgentConfig } from './config.js';

export interface RunningAgent {
  hub: Hub;
  sessions: SessionManager;
  /** Actual bound port per tier, for tests and for logging. */
  ports: { trusted: number | null; public: number | null };
  close(): Promise<void>;
}

const AGENT_VERSION = '0.1.0';

interface Listener {
  tier: TrustTier;
  server: http.Server;
  wss: WebSocketServer;
  port: number;
}

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
  if (!cfg.listeners.trusted && !cfg.listeners.public) {
    throw new Error('No listeners configured — set at least one of trusted or public.');
  }
  if (
    cfg.listeners.trusted &&
    cfg.listeners.public &&
    cfg.listeners.trusted.port === cfg.listeners.public.port &&
    // Port 0 means "assign an ephemeral port", so two zeros are two different
    // ports at runtime and are fine.
    cfg.listeners.trusted.port !== 0
  ) {
    // Sharing a real port would collapse the two tiers into one and silently
    // grant trusted privileges to public traffic.
    throw new Error('trusted and public listeners must use different ports.');
  }

  const hub = new Hub();
  const sessions = new SessionManager(cfg, hub);
  registerSystemOps(hub, cfg);
  registerChatOps(hub, sessions);

  const listeners: Listener[] = [];
  for (const tier of ['trusted', 'public'] as const) {
    const conf = cfg.listeners[tier];
    if (!conf) continue;
    listeners.push(await bind(hub, cfg, tier, conf.port));
  }

  const stopHeartbeat = hub.startHeartbeat();

  return {
    hub,
    sessions,
    ports: {
      trusted: listeners.find((l) => l.tier === 'trusted')?.port ?? null,
      public: listeners.find((l) => l.tier === 'public')?.port ?? null,
    },
    async close() {
      stopHeartbeat();
      sessions.closeAll();
      for (const l of listeners) {
        for (const socket of l.wss.clients) socket.terminate();
        await new Promise<void>((resolve) => l.wss.close(() => resolve()));
        await new Promise<void>((resolve) => l.server.close(() => resolve()));
      }
    },
  };
}

/**
 * One listener per trust tier.
 *
 * The tier is baked in here, at accept time, from which socket the connection
 * arrived on. Nothing downstream can change it and no client header
 * influences it — that unforgeability is the entire point of using two
 * sockets rather than inspecting X-Forwarded-For.
 */
async function bind(
  hub: Hub,
  cfg: AgentConfig,
  tier: TrustTier,
  port: number,
): Promise<Listener> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agentVersion: AGENT_VERSION, tier }));
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
    hub.add(socket, tier);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, cfg.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  return {
    tier,
    server,
    wss,
    port: typeof addr === 'object' && addr ? addr.port : port,
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
      tier: conn.tier,
      // Sent so the app shows the restrictions actually in force rather than
      // inferring them from which URL it dialled.
      policy: policyFor(cfg, conn.tier),
      capabilities: {
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

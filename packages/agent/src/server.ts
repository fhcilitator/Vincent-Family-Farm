import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, type TrustTier } from '@vff/protocol';
import { Hub, WireErr } from './hub.js';
import { SessionManager, registerChatOps } from './chat/manager.js';
import { policyFor, type AgentConfig } from './config.js';
import { checkClaudeAuth, type ClaudeAuthState } from './preflight.js';

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

  // Checked once at boot rather than on the user's first message, where a
  // missing login looks like a mystery failure 30 seconds in. The agent
  // starts anyway if this fails — terminal, files, and git don't need Claude,
  // and they're exactly what you'd want in order to fix the problem.
  const claudeAuth = checkClaudeAuth();

  const hub = new Hub();
  const sessions = new SessionManager(cfg, hub);
  registerSystemOps(hub, cfg, claudeAuth);
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

  const wss = new WebSocketServer({
    server,
    maxPayload: 4 * 1024 * 1024,
    // Echo back the token subprotocol so browser handshakes complete. `ws`
    // fails the connection if the client offered protocols and we select none.
    handleProtocols: (protocols) => {
      for (const p of protocols) if (p.startsWith(TOKEN_PROTOCOL_PREFIX)) return p;
      return false;
    },
  });

  wss.on('connection', (socket, req) => {
    const presented = extractToken(req.headers);
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

function registerSystemOps(hub: Hub, cfg: AgentConfig, claudeAuth: ClaudeAuthState): void {
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
      claudeAuth,
      capabilities: {
        // Reflects reality rather than a hardcoded true, so the app greys out
        // chat instead of offering a feature that will fail on first use.
        claude: claudeAuth.usable,
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

/**
 * Browsers cannot set headers on a WebSocket handshake — `Authorization` is
 * simply unavailable to `new WebSocket(...)`. The standard workaround is to
 * smuggle the credential through `Sec-WebSocket-Protocol`, which browsers do
 * control, and have the server echo it back.
 *
 * A query parameter would be the other option and is worse: URLs land in
 * proxy logs, server access logs, and browser history.
 *
 * Node and React Native can both send real headers, so they keep using
 * `Authorization` and never touch this path.
 */
export const TOKEN_PROTOCOL_PREFIX = 'vff.token.';

function extractToken(headers: http.IncomingHttpHeaders): string {
  const auth = headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);

  const offered = headers['sec-websocket-protocol'];
  if (typeof offered === 'string') {
    for (const raw of offered.split(',')) {
      const p = raw.trim();
      if (p.startsWith(TOKEN_PROTOCOL_PREFIX)) return p.slice(TOKEN_PROTOCOL_PREFIX.length);
    }
  }
  return '';
}

/** Constant-time compare so token checks don't leak length or prefix by timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

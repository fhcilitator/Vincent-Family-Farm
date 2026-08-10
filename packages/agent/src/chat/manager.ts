import path from 'node:path';
import fs from 'node:fs';
import { ChatSession, type ChatSessionOptions } from './session.js';
import { WireErr, type Hub } from '../hub.js';
import { policyFor, type AgentConfig } from '../config.js';
import type { TrustTier, PermissionMode } from '@vff/protocol';

/**
 * Owns every live Claude session. Sessions are keyed by our own id and
 * deliberately outlive the connections that created them — that is the whole
 * point (see ChatSession).
 */
export class SessionManager {
  #sessions = new Map<string, ChatSession>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly hub: Hub,
    /** Overridden in tests so the reconnect path runs without API credentials. */
    private readonly queryFn?: ChatSessionOptions['queryFn'],
  ) {}

  get size(): number {
    return this.#sessions.size;
  }

  list(limit: number): Array<{
    sessionId: string;
    title: string | null;
    lastModified: number;
    running: boolean;
  }> {
    return [...this.#sessions.values()]
      .slice(0, limit)
      .map((s) => ({
        sessionId: s.id,
        title: null,
        lastModified: Date.now(),
        running: s.running,
      }));
  }

  get(id: string): ChatSession {
    const s = this.#sessions.get(id);
    if (!s) throw new WireErr('session_not_found', `No session ${id}`);
    return s;
  }

  create(
    input: {
      cwd?: string | undefined;
      model?: string | undefined;
      permissionMode?: PermissionMode | undefined;
      resume?: string | undefined;
      forkSession?: boolean | undefined;
    },
    tier: TrustTier,
  ): ChatSession {
    const cwd = this.#resolveCwd(input.cwd);

    const policy = policyFor(this.cfg, tier);
    if (input.permissionMode && !policy.allowedPermissionModes.includes(input.permissionMode)) {
      // On the public tier this rejects every prompt-reducing mode outright.
      // On trusted it only rejects bypassPermissions unless the agent's own
      // config opted in.
      throw new WireErr(
        'permission_denied',
        tier === 'public'
          ? `permissionMode "${input.permissionMode}" is not available over the public ` +
            'connection. Connect over the trusted path to use it.'
          : `permissionMode "${input.permissionMode}" is disabled on this agent. Enable ` +
            'allowBypassPermissions in the agent config to allow it.',
      );
    }

    const opts: ChatSessionOptions = {
      cwd,
      model: input.model,
      permissionMode: input.permissionMode,
      resume: input.resume,
      forkSession: input.forkSession,
      permissionTimeoutMs: this.cfg.permissionTimeoutMs,
      publicPermissionTimeoutMs: this.cfg.publicPermissionTimeoutMs,
      queryFn: this.queryFn,
      // Resolved per-ask, not fixed at creation: a session outlives its
      // connections and can be watched from either tier over its lifetime.
      // Trusted wins when both are attached.
      resolveTier: () => {
        // `session` is assigned below, before any permission ask can fire.
        const watching = this.hub.tiersWatching(session.id);
        if (watching.has('trusted')) return 'trusted';
        if (watching.has('public')) return 'public';
        return 'none';
      },
      onEvent: (session, seq, type, body) => {
        this.hub.broadcast({
          kind: 'event',
          ch: 'claude',
          type,
          seq,
          stream: session.id,
          body,
        });
      },
    };

    const session: ChatSession = new ChatSession(opts);
    this.#sessions.set(session.id, session);
    session.start();
    return session;
  }

  closeAll(): void {
    for (const s of this.#sessions.values()) s.close();
    this.#sessions.clear();
  }

  /**
   * Resolve a requested cwd against the configured roots. realpath first, so a
   * symlink cannot be used to escape the allowlist.
   */
  #resolveCwd(requested: string | undefined): string {
    const root = this.cfg.roots[0];
    if (!root) throw new WireErr('internal', 'No workspace root configured');
    if (!requested || requested === '.') return root;

    if (path.isAbsolute(requested)) {
      throw new WireErr('path_outside_workspace', 'cwd must be workspace-relative');
    }

    const abs = path.resolve(root, requested);
    let real: string;
    try {
      real = fs.realpathSync.native(abs);
    } catch {
      throw new WireErr('not_found', `No such directory: ${requested}`);
    }

    const inRoot = this.cfg.roots.some((r) => real === r || real.startsWith(r + path.sep));
    if (!inRoot) {
      throw new WireErr('path_outside_workspace', `Path outside allowed roots: ${requested}`);
    }
    return real;
  }
}

/** Register the claude/* ops against the hub. */
export function registerChatOps(hub: Hub, manager: SessionManager): void {
  hub.register('claude/start', ({ body, conn }) => {
    const input = body as {
      cwd?: string;
      model?: string;
      permissionMode?: PermissionMode;
      resume?: string;
      forkSession?: boolean;
    };
    const session = manager.create(input, conn.tier);
    // Starting a session implies watching it. Without this the creator gets
    // no events until it separately attaches, which reads as a dead session.
    // Safe to do after create(): the session cannot raise a permission ask
    // until a claude/send drives a turn, which is necessarily later.
    conn.subscriptions.add(session.id);
    return { sessionId: session.id, resumed: Boolean(input.resume) };
  });

  hub.register('claude/send', ({ body, conn }) => {
    const { sessionId, text } = body as { sessionId: string; text: string };
    const session = manager.get(sessionId);
    // Sending implies watching.
    conn.subscriptions.add(sessionId);
    session.send(text);
    return { accepted: true as const };
  });

  hub.register('claude/attach', ({ body, conn }) => {
    const { sessionId, sinceSeq } = body as { sessionId: string; sinceSeq: number };
    const session = manager.get(sessionId);
    conn.subscriptions.add(sessionId);

    const { events: replay, truncated, head } = session.log.since(sinceSeq);
    return {
      sessionId,
      running: session.running,
      replay: replay.map((e) => ({ seq: e.seq, type: e.type, body: e.body, ts: e.ts })),
      head,
      truncated,
    };
  });

  hub.register('claude/interrupt', ({ body }) => {
    const { sessionId } = body as { sessionId: string };
    return { interrupted: manager.get(sessionId).interrupt() };
  });

  hub.register('claude/list-sessions', ({ body }) => {
    const { limit } = body as { limit: number };
    return { sessions: manager.list(limit) };
  });

  hub.register('claude/permission-respond', ({ body, conn }) => {
    const { sessionId, requestId, decision } = body as {
      sessionId: string;
      requestId: string;
      decision: Parameters<ChatSession['respondToPermission']>[1];
    };
    // The responder's tier decides whether a session-scoped grant may be
    // created — a public client can allow this call but cannot buy silence
    // for the next one.
    return {
      applied: manager.get(sessionId).respondToPermission(requestId, decision, conn.tier),
    };
  });
}

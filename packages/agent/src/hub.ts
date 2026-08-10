import type { WebSocket } from 'ws';
import { nanoid } from 'nanoid';
import {
  parseEnvelope,
  serializeEnvelope,
  OP_REGISTRY,
  opName,
  type Envelope,
  type Event,
  type ErrorCode,
} from '@vff/protocol';

export class WireErr extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'WireErr';
  }
}

export interface Conn {
  id: string;
  socket: WebSocket;
  /** Set once `system/hello` succeeds. Nothing else is served before then. */
  deviceId: string | null;
  /** Streams this connection is currently receiving events for. */
  subscriptions: Set<string>;
  alive: boolean;
}

export type Handler = (args: {
  body: unknown;
  conn: Conn;
  hub: Hub;
}) => Promise<unknown> | unknown;

/**
 * Owns connections and frame routing. Deliberately knows nothing about Claude,
 * PTYs, or git — those register handlers.
 *
 * Note the asymmetry: clients send requests, the agent sends events. There is
 * no agent-originated request, because anything that blocks on a phone
 * answering has to survive that phone disappearing (see the permission flow).
 */
export class Hub {
  #conns = new Map<string, Conn>();
  #handlers = new Map<string, Handler>();

  register(op: keyof typeof OP_REGISTRY, handler: Handler): void {
    this.#handlers.set(op, handler);
  }

  add(socket: WebSocket): Conn {
    const conn: Conn = {
      id: nanoid(),
      socket,
      deviceId: null,
      subscriptions: new Set(),
      alive: true,
    };
    this.#conns.set(conn.id, conn);

    socket.on('message', (raw) => void this.#onMessage(conn, String(raw)));
    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('close', () => this.#conns.delete(conn.id));
    socket.on('error', () => this.#conns.delete(conn.id));

    return conn;
  }

  get connectionCount(): number {
    return this.#conns.size;
  }

  /** Push an event to every connection subscribed to its stream. */
  broadcast(event: Event): void {
    const frame = serializeEnvelope(event);
    for (const conn of this.#conns.values()) {
      if (conn.deviceId && conn.subscriptions.has(event.stream)) {
        this.#safeSend(conn, frame);
      }
    }
  }

  /** Heartbeat. Mobile sockets go half-open behind carrier NAT without TCP noticing. */
  startHeartbeat(intervalMs = 15_000): () => void {
    const timer = setInterval(() => {
      for (const conn of this.#conns.values()) {
        if (!conn.alive) {
          conn.socket.terminate();
          this.#conns.delete(conn.id);
          continue;
        }
        conn.alive = false;
        try {
          conn.socket.ping();
        } catch {
          /* socket already gone; close handler cleans up */
        }
      }
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async #onMessage(conn: Conn, raw: string): Promise<void> {
    let env: Envelope;
    try {
      env = parseEnvelope(raw);
    } catch (err) {
      // Unparseable frame: no id to correlate a response to, so just log.
      console.warn(`[hub] dropped malformed frame from ${conn.id}:`, String(err));
      return;
    }

    if (env.kind !== 'req') {
      // Clients only send requests. Anything else is a protocol violation.
      console.warn(`[hub] unexpected ${env.kind} frame from client ${conn.id}`);
      return;
    }

    const name = opName(env.ch, env.op);
    if (!name) {
      this.#fail(conn, env.id, 'unsupported_op', `Unknown op ${env.ch}/${env.op}`);
      return;
    }

    // Everything except the handshake requires an authenticated connection.
    if (name !== 'system/hello' && !conn.deviceId) {
      this.#fail(conn, env.id, 'unauthorized', 'Send system/hello first');
      return;
    }

    const handler = this.#handlers.get(name);
    if (!handler) {
      this.#fail(conn, env.id, 'unsupported_op', `No handler for ${name}`);
      return;
    }

    const parsed = OP_REGISTRY[name].req.safeParse(env.body);
    if (!parsed.success) {
      this.#fail(conn, env.id, 'bad_request', `Invalid body for ${name}`, parsed.error.format());
      return;
    }

    try {
      const result = await handler({ body: parsed.data, conn, hub: this });
      this.#ok(conn, env.id, result);
    } catch (err) {
      if (err instanceof WireErr) {
        this.#fail(conn, env.id, err.code, err.message, err.detail);
      } else {
        // Never leak stack traces or host paths to the client.
        console.error(`[hub] handler ${name} threw:`, err);
        this.#fail(conn, env.id, 'internal', 'Internal agent error');
      }
    }
  }

  #ok(conn: Conn, id: string, body: unknown): void {
    this.#safeSend(conn, serializeEnvelope({ kind: 'res', id, ok: true, body: body ?? {} }));
  }

  #fail(conn: Conn, id: string, code: ErrorCode, message: string, detail?: unknown): void {
    this.#safeSend(
      conn,
      serializeEnvelope({ kind: 'res', id, ok: false, error: { code, message, detail } }),
    );
  }

  #safeSend(conn: Conn, frame: string): void {
    try {
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(frame);
    } catch (err) {
      console.warn(`[hub] send failed for ${conn.id}:`, String(err));
    }
  }
}

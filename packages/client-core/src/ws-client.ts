import {
  parseEnvelope,
  serializeEnvelope,
  OP_REGISTRY,
  splitOp,
  PROTOCOL_VERSION,
  type OpName,
  type ReqBody,
  type ResBody,
  type Event,
  type WireError,
} from '@vff/protocol';
import { makeId, SOCKET_OPEN, type SocketFactory, type SocketLike } from './socket.js';

export class RemoteError extends Error {
  readonly retryable: boolean;
  constructor(readonly wire: WireError) {
    super(`${wire.code}: ${wire.message}`);
    this.name = 'RemoteError';
    this.retryable = wire.code === 'internal';
  }
}

export class DisconnectedError extends Error {
  /** Callers may safely retry these once reconnected. */
  readonly retryable = true;
  constructor(message = 'connection lost before a reply arrived') {
    super(message);
    this.name = 'DisconnectedError';
  }
}

/**
 * `syncing` is not cosmetic — it tells the user they are looking at replayed
 * history and that more is still arriving. Collapsing it into `live` makes a
 * reconnect look like a stall.
 */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'handshaking'
  | 'syncing'
  | 'live';

export interface TrackedStream {
  /** Highest seq this client has durably rendered. */
  lastSeq: number;
}

export interface WsClientOptions {
  url: string;
  token: string;
  deviceId: string;
  clientVersion?: string;
  createSocket: SocketFactory;
  /** Overridable for tests; real defaults are tuned for mobile networks. */
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injected so tests can run without real timers. */
  now?: () => number;
}

type Listener<T> = (value: T) => void;

interface Pending {
  reject: (e: Error) => void;
  resolve: (v: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A reconnecting, resuming protocol client.
 *
 * Two behaviours carry the whole product:
 *
 *  - **Resume, not restart.** Every stream's `lastSeq` is tracked, and on
 *    reconnect the client re-attaches with it so the agent replays exactly
 *    what was missed. Work continues on the dev box while the phone is away.
 *  - **Detect dead sockets.** Mobile connections go half-open behind carrier
 *    NAT: the socket still reports OPEN, writes still "succeed", and nothing
 *    ever comes back. TCP will not tell you. Only an application-level
 *    heartbeat notices, which is why one is built in rather than left to the
 *    platform.
 */
export class WsClient {
  #opts: Required<Omit<WsClientOptions, 'createSocket' | 'clientVersion'>> & {
    createSocket: SocketFactory;
    clientVersion: string;
  };
  #socket: SocketLike | null = null;
  #state: ConnectionState = 'disconnected';
  #pending = new Map<string, Pending>();
  #streams = new Map<string, TrackedStream>();
  #closedByUser = false;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  #stateListeners = new Set<Listener<ConnectionState>>();
  #eventListeners = new Set<Listener<Event>>();
  #helloListeners = new Set<Listener<ResBody<'system/hello'>>>();
  #gapListeners = new Set<Listener<{ stream: string; expected: number; got: number }>>();

  constructor(options: WsClientOptions) {
    this.#opts = {
      url: options.url,
      token: options.token,
      deviceId: options.deviceId,
      clientVersion: options.clientVersion ?? '0.1.0',
      createSocket: options.createSocket,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 20_000,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      now: options.now ?? (() => Date.now()),
    };
  }

  get state(): ConnectionState {
    return this.#state;
  }

  onStateChange(fn: Listener<ConnectionState>): () => void {
    this.#stateListeners.add(fn);
    return () => this.#stateListeners.delete(fn);
  }
  onEvent(fn: Listener<Event>): () => void {
    this.#eventListeners.add(fn);
    return () => this.#eventListeners.delete(fn);
  }
  onHello(fn: Listener<ResBody<'system/hello'>>): () => void {
    this.#helloListeners.add(fn);
    return () => this.#helloListeners.delete(fn);
  }
  /** Fires when an event arrives out of sequence, before the forced re-attach. */
  onGap(fn: Listener<{ stream: string; expected: number; got: number }>): () => void {
    this.#gapListeners.add(fn);
    return () => this.#gapListeners.delete(fn);
  }

  /**
   * Follow a stream across reconnects. `lastSeq` starts at 0 (replay
   * everything) unless the caller already has history.
   */
  track(streamId: string, lastSeq = 0): void {
    const existing = this.#streams.get(streamId);
    if (existing) existing.lastSeq = Math.max(existing.lastSeq, lastSeq);
    else this.#streams.set(streamId, { lastSeq });
  }

  untrack(streamId: string): void {
    this.#streams.delete(streamId);
  }

  lastSeqOf(streamId: string): number {
    return this.#streams.get(streamId)?.lastSeq ?? 0;
  }

  connect(): void {
    this.#closedByUser = false;
    this.#open();
  }

  close(): void {
    this.#closedByUser = true;
    this.#clearReconnect();
    this.#stopHeartbeat();
    this.#failPending(new DisconnectedError('client closed'));
    this.#socket?.close();
    this.#socket = null;
    this.#setState('disconnected');
  }

  async request<K extends OpName>(op: K, body: ReqBody<K>): Promise<ResBody<K>> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      throw new DisconnectedError('not connected');
    }

    const id = makeId();
    const { ch, op: opPart } = splitOp(op);

    const raw = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new DisconnectedError(`request ${op} timed out`));
      }, this.#opts.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });

      try {
        socket.send(serializeEnvelope({ kind: 'req', id, ch, op: opPart, body }));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new DisconnectedError(String(err)));
      }
    });

    // Validate the agent's reply against the same schema it answered with, so
    // a drifting or hostile agent fails loudly here rather than corrupting
    // client state downstream.
    return OP_REGISTRY[op].res.parse(raw) as ResBody<K>;
  }

  /* --------------------------------------------------------------- internal */

  #open(): void {
    if (this.#closedByUser) return;
    this.#setState('connecting');

    let socket: SocketLike;
    try {
      socket = this.#opts.createSocket(this.#opts.url, this.#opts.token);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => void this.#handshake();
    socket.onmessage = (ev) => this.#onMessage(String(ev.data));
    socket.onerror = () => {
      /* onclose always follows; handle it there so we don't reconnect twice */
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return; // superseded by a newer socket
      this.#stopHeartbeat();
      this.#failPending(new DisconnectedError());
      this.#socket = null;
      this.#setState('disconnected');
      this.#scheduleReconnect();
    };
  }

  async #handshake(): Promise<void> {
    this.#setState('handshaking');
    try {
      const hello = await this.request('system/hello', {
        protocolVersion: PROTOCOL_VERSION,
        deviceId: this.#opts.deviceId,
        clientVersion: this.#opts.clientVersion,
      });
      for (const fn of this.#helloListeners) fn(hello);

      // Successful handshake means this endpoint works — reset backoff so a
      // later blip retries fast rather than inheriting a long delay.
      this.#attempt = 0;

      await this.#resumeStreams();
      this.#startHeartbeat();
      this.#setState('live');
    } catch {
      // A failed handshake is not retryable in place; drop the socket and let
      // the normal reconnect path handle backoff.
      this.#socket?.close();
    }
  }

  /**
   * Re-attach every tracked stream. This is the difference between "your
   * session is still running and here's what you missed" and "start again".
   */
  async #resumeStreams(): Promise<void> {
    if (this.#streams.size === 0) return;
    this.#setState('syncing');

    for (const [streamId, stream] of this.#streams) {
      try {
        const res = await this.request('claude/attach', {
          sessionId: streamId,
          sinceSeq: stream.lastSeq,
        });

        for (const entry of res.replay) {
          const e = entry as { seq: number; type: string; body: unknown };
          stream.lastSeq = Math.max(stream.lastSeq, e.seq);
          this.#emitEvent({
            kind: 'event',
            ch: 'claude',
            type: e.type,
            seq: e.seq,
            stream: streamId,
            body: e.body,
          });
        }
        stream.lastSeq = Math.max(stream.lastSeq, res.head);
      } catch {
        // A stream that can't be resumed (deleted session, say) shouldn't
        // block the others or kill the connection.
        this.untrack(streamId);
      }
    }
  }

  #onMessage(raw: string): void {
    let env;
    try {
      env = parseEnvelope(raw);
    } catch {
      // A malformed frame must not take the connection down.
      return;
    }

    if (env.kind === 'event') {
      const tracked = this.#streams.get(env.stream);
      if (tracked) {
        const expected = tracked.lastSeq + 1;
        if (env.seq > expected) {
          // Missed something. Re-attach rather than render a hole.
          for (const fn of this.#gapListeners) fn({ stream: env.stream, expected, got: env.seq });
          void this.#resumeStreams();
          return;
        }
        if (env.seq <= tracked.lastSeq) return; // duplicate from a replay overlap
        tracked.lastSeq = env.seq;
      }
      this.#emitEvent(env);
      return;
    }

    if (env.kind !== 'res') return;

    const pending = this.#pending.get(env.id);
    if (!pending) return; // late reply to a timed-out request
    this.#pending.delete(env.id);
    clearTimeout(pending.timer);

    if (env.ok) pending.resolve(env.body);
    else pending.reject(new RemoteError(env.error));
  }

  #emitEvent(e: Event): void {
    for (const fn of this.#eventListeners) fn(e);
  }

  /**
   * Application-level heartbeat. A carrier-NAT half-open socket looks alive
   * to every platform API; only an unanswered round trip reveals it.
   */
  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      const socket = this.#socket;
      if (!socket) return;

      const timeout = setTimeout(() => {
        // Force the close handler to run and trigger a reconnect.
        socket.close(4000, 'heartbeat timeout');
      }, this.#opts.heartbeatTimeoutMs);

      this.request('system/ping', { nonce: makeId() })
        .then(() => clearTimeout(timeout))
        .catch(() => clearTimeout(timeout));
    }, this.#opts.heartbeatIntervalMs);

    // Never hold a Node process open just to heartbeat.
    (this.#heartbeatTimer as { unref?: () => void }).unref?.();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  #scheduleReconnect(): void {
    if (this.#closedByUser || this.#reconnectTimer) return;

    // Exponential backoff with jitter. The jitter matters when several
    // clients reconnect after the same outage — without it they retry in
    // lockstep and hammer the agent.
    const base = Math.min(
      this.#opts.maxBackoffMs,
      this.#opts.minBackoffMs * 2 ** this.#attempt,
    );
    const jitter = base * 0.3 * (Math.random() * 2 - 1);
    const delay = Math.max(this.#opts.minBackoffMs, Math.round(base + jitter));
    this.#attempt++;

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
    (this.#reconnectTimer as { unref?: () => void }).unref?.();
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #failPending(err: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }

  #setState(next: ConnectionState): void {
    if (this.#state === next) return;
    this.#state = next;
    for (const fn of this.#stateListeners) fn(next);
  }
}

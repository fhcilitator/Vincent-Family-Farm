import WebSocket from 'ws';
import { nanoid } from 'nanoid';
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

export class RemoteError extends Error {
  constructor(readonly wire: WireError) {
    super(`${wire.code}: ${wire.message}`);
    this.name = 'RemoteError';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A typed protocol client. Used by the REPL harness and the agent's own tests,
 * so the protocol gets exercised end-to-end long before any React Native
 * exists — which is the difference between finding a protocol bug in seconds
 * and finding it through a rebuild-deploy-squint cycle on a phone.
 *
 * The mobile app's WsClient adds reconnection and per-stream resume on top of
 * this same shape.
 */
export class AgentClient {
  #ws: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #listeners = new Set<(e: Event) => void>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly requestTimeoutMs = 30_000,
  ) {}

  async connect(deviceId = 'harness'): Promise<ResBody<'system/hello'>> {
    const ws = new WebSocket(this.url, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.#ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
      ws.once('close', (code, reason) =>
        reject(new Error(`closed before open: ${code} ${String(reason)}`)),
      );
    });
    ws.removeAllListeners('error');
    ws.removeAllListeners('close');

    ws.on('message', (raw) => this.#onMessage(String(raw)));
    ws.on('close', () => this.#rejectAllPending(new Error('socket closed')));
    ws.on('error', (err) => this.#rejectAllPending(err));

    return this.request('system/hello', {
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      clientVersion: '0.1.0',
    });
  }

  onEvent(fn: (e: Event) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  async request<K extends OpName>(op: K, body: ReqBody<K>): Promise<ResBody<K>> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('not connected');

    const id = nanoid();
    const { ch, op: opPart } = splitOp(op);

    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`request ${op} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
    });

    ws.send(serializeEnvelope({ kind: 'req', id, ch, op: opPart, body }));

    // Validate the reply against the same schema the agent answered with, so
    // a drifting agent fails loudly here rather than corrupting client state.
    return OP_REGISTRY[op].res.parse(await result) as ResBody<K>;
  }

  close(): void {
    this.#rejectAllPending(new Error('client closed'));
    this.#ws?.close();
    this.#ws = null;
  }

  #onMessage(raw: string): void {
    let env;
    try {
      env = parseEnvelope(raw);
    } catch (err) {
      console.warn('[client] dropped malformed frame:', String(err));
      return;
    }

    if (env.kind === 'event') {
      for (const fn of this.#listeners) fn(env);
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

  #rejectAllPending(err: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
  }
}

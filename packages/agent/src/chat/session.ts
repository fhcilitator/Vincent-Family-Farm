import { nanoid } from 'nanoid';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { events } from '@vff/protocol';
import { ChannelLog } from '../channel-log.js';
import { translate } from './translate.js';
import {
  toSdkResult,
  classifyRisk,
  renderPermissionBody,
  normalizePermissionCall,
  type PermissionDecision,
  type CanUseTool,
  type PermissionMode,
} from './sdk-adapter.js';

const E = events.EVENT_TYPES.claude;

export class PermissionTimeout extends Error {
  constructor() {
    super('permission timed out');
    this.name = 'PermissionTimeout';
  }
}
export class PermissionAborted extends Error {
  constructor() {
    super('permission aborted');
    this.name = 'PermissionAborted';
  }
}

interface PendingPermission {
  requestId: string;
  resolve: (d: PermissionDecision) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}

/**
 * The subset of the SDK's `query` we depend on. Injectable so the permission
 * state machine and reconnect behaviour are testable against a fake SDK —
 * these are the safety-critical paths, and gating their tests behind live API
 * credentials would mean they never run in CI.
 */
export type QueryFn = typeof query;

export interface ChatSessionOptions {
  cwd: string;
  model?: string | undefined;
  permissionMode?: PermissionMode | undefined;
  resume?: string | undefined;
  forkSession?: boolean | undefined;
  permissionTimeoutMs: number;
  maxTurns?: number | undefined;
  /** Called for every event appended to the log, so the hub can broadcast it. */
  onEvent: (session: ChatSession, seq: number, type: string, body: unknown) => void;
  /** Defaults to the real SDK. Overridden in tests. */
  queryFn?: QueryFn | undefined;
}

/**
 * One Claude conversation.
 *
 * The critical inversion: **the Query is owned by this session, not by a
 * socket.** A WebSocket is only a view onto the channel log. Events land in
 * the log whether or not a phone is listening, so a phone that loses signal
 * mid-task reconnects, asks for everything after the last seq it rendered,
 * and catches up in one round trip. No session re-creation, no lost turn.
 *
 * That property is the whole reason this app can exist on a mobile network.
 */
export class ChatSession {
  readonly id: string;
  readonly log: ChannelLog;
  readonly cwd: string;

  /** The SDK's own session id, needed to resume after an agent restart. */
  sdkSessionId: string | null = null;

  #query: Query | null = null;
  #inbox: SDKUserMessage[] = [];
  #waiter: ((m: IteratorResult<SDKUserMessage>) => void) | null = null;
  #closed = false;
  #running = false;
  #pending = new Map<string, PendingPermission>();
  #sessionAllows = new Set<string>();
  #abort = new AbortController();

  constructor(private readonly opts: ChatSessionOptions) {
    this.id = nanoid();
    this.cwd = opts.cwd;
    this.log = new ChannelLog('claude', this.id);
  }

  get running(): boolean {
    return this.#running;
  }

  get pendingPermissionIds(): string[] {
    return [...this.#pending.keys()];
  }

  /**
   * The streaming-input prompt. This generator never returns while the session
   * is open, which is what keeps one `query()` alive across many user turns
   * instead of starting a fresh one per message.
   */
  async *#input(): AsyncGenerator<SDKUserMessage> {
    while (!this.#closed) {
      const queued = this.#inbox.shift();
      if (queued) {
        yield queued;
        continue;
      }
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.#waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  send(text: string): void {
    if (this.#closed) throw new Error('session is closed');

    const msg = {
      type: 'user' as const,
      session_id: this.sdkSessionId ?? '',
      parent_tool_use_id: null,
      message: { role: 'user' as const, content: text },
    } as unknown as SDKUserMessage;

    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter({ done: false, value: msg });
    } else {
      this.#inbox.push(msg);
    }
  }

  start(): void {
    if (this.#query) throw new Error('already started');

    const run = this.opts.queryFn ?? query;
    this.#query = run({
      prompt: this.#input(),
      options: {
        cwd: this.cwd,
        // Load-bearing: without this there are no token-level deltas and the
        // chat arrives in whole messages.
        includePartialMessages: true,
        permissionMode: this.opts.permissionMode ?? 'default',
        canUseTool: this.#canUseTool,
        abortController: this.#abort,
        persistSession: true,
        ...(this.opts.model ? { model: this.opts.model } : {}),
        ...(this.opts.resume ? { resume: this.opts.resume } : {}),
        ...(this.opts.forkSession ? { forkSession: true } : {}),
        ...(this.opts.maxTurns ? { maxTurns: this.opts.maxTurns } : {}),
      },
    });

    void this.#pump();
  }

  /**
   * Consumes the SDK's output for the life of the session. Deliberately not
   * awaited by any request handler — nobody blocks on it, so output keeps
   * flowing into the log while no phone is attached.
   */
  async #pump(): Promise<void> {
    const q = this.#query;
    if (!q) return;

    this.#running = true;
    try {
      for await (const msg of q) {
        if (!this.sdkSessionId && 'session_id' in msg && typeof msg.session_id === 'string') {
          this.sdkSessionId = msg.session_id;
        }
        for (const ev of translate(msg)) this.#emit(ev.type, ev.body);
      }
    } catch (err) {
      this.#emit(E.error, {
        message: err instanceof Error ? err.message : String(err),
        fatal: true,
      });
    } finally {
      this.#running = false;
      // Any permission still waiting can never be answered now.
      this.#failAllPending(new PermissionAborted());
    }
  }

  /**
   * The SDK's permission hook. Note the positional arguments — verified
   * against the pinned SDK, and different from both published doc examples.
   *
   * This blocks the tool call until a device answers. It must therefore
   * survive the phone disappearing, which is why the ask goes into the log as
   * a durable event rather than down a socket as an RPC.
   */
  #canUseTool: CanUseTool = async (toolName, input, options) => {
    const call = normalizePermissionCall(toolName, input, options);

    // Previously granted "allow for this session" — don't nag.
    const ruleKey = this.#ruleKey(toolName, input);
    if (this.#sessionAllows.has(ruleKey)) {
      return toSdkResult({ allow: true, scope: 'session' });
    }

    const requestId = nanoid();
    const expiresAt =
      this.opts.permissionTimeoutMs > 0 ? Date.now() + this.opts.permissionTimeoutMs : null;

    this.#emit(E.permissionPending, {
      requestId,
      toolName,
      input,
      render: {
        title: call.title,
        subtitle: call.blockedPath
          ? `Blocked path: ${call.blockedPath}`
          : (call.decisionReason ?? this.cwd),
        body: renderPermissionBody(toolName, input),
        risk: classifyRisk(toolName, input, call.blockedPath),
      },
      expiresAt,
    });

    try {
      const decision = await new Promise<PermissionDecision>((resolve, reject) => {
        // Deliberately NOT unref'd. A pending approval is live work — the
        // process must stay alive to honour the timeout, or a session could
        // be left permanently blocked on an ask that can never resolve.
        const timer =
          this.opts.permissionTimeoutMs > 0
            ? setTimeout(() => reject(new PermissionTimeout()), this.opts.permissionTimeoutMs)
            : null;

        const onAbort = () => reject(new PermissionAborted());
        call.signal.addEventListener('abort', onAbort, { once: true });

        this.#pending.set(requestId, {
          requestId,
          resolve,
          reject,
          cleanup: () => {
            if (timer) clearTimeout(timer);
            call.signal.removeEventListener('abort', onAbort);
          },
        });
      });

      if (decision.allow && decision.scope !== 'once') this.#sessionAllows.add(ruleKey);

      this.#emit(E.permissionResolved, {
        requestId,
        allowed: decision.allow,
        by: 'device',
      });
      return toSdkResult(decision);
    } catch (err) {
      // Fail safe. A timeout or an abort denies — never allows. A phone that
      // is merely offline has not consented to anything.
      const timedOut = err instanceof PermissionTimeout;
      this.#emit(E.permissionResolved, {
        requestId,
        allowed: false,
        by: timedOut ? 'timeout' : 'cancelled',
      });
      return toSdkResult({
        allow: false,
        message: timedOut
          ? 'No response from the paired device within the timeout.'
          : 'Cancelled before the device answered.',
      });
    } finally {
      this.#pending.get(requestId)?.cleanup();
      this.#pending.delete(requestId);
    }
  };

  /** Answer a pending ask. False when it already resolved. */
  respondToPermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    pending.resolve(decision);
    return true;
  }

  interrupt(): boolean {
    if (!this.#query) return false;
    void this.#query.interrupt?.();
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#failAllPending(new PermissionAborted());
    const waiter = this.#waiter;
    if (waiter) {
      this.#waiter = null;
      waiter({ done: true, value: undefined as never });
    }
    this.#abort.abort();
    this.#query?.close?.();
    this.#query = null;
  }

  #emit(type: string, body: unknown): void {
    const entry = this.log.append(type, body);
    this.opts.onEvent(this, entry.seq, type, body);
  }

  #failAllPending(err: Error): void {
    for (const [, p] of this.#pending) {
      p.cleanup();
      p.reject(err);
    }
    this.#pending.clear();
  }

  /**
   * Key for "allow for this session". Scoped to the tool plus its most
   * identifying argument, so approving `Bash(npm test)` does not silently
   * approve `Bash(rm -rf /)`.
   */
  #ruleKey(toolName: string, input: Record<string, unknown>): string {
    if (typeof input.command === 'string') return `${toolName}:${input.command}`;
    if (typeof input.file_path === 'string') return `${toolName}:${input.file_path}`;
    return toolName;
  }
}

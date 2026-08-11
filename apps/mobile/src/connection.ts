import { create } from 'zustand';
import {
  WsClient,
  chatReducer,
  appendUserMessage,
  initialChatState,
  makeId,
  type ChatState,
  type ConnectionState,
} from '@vff/client-core';
import type { ops, PermissionMode } from '@vff/protocol';
import type { z } from 'zod';
import { makeRnSocket } from './socket';
import {
  loadAgent,
  preferredEndpoints,
  type AgentConfig,
  type AgentCredentials,
} from './agent-store';

type Hello = z.infer<typeof ops.SystemHelloRes>;

interface ConnectionSlice {
  config: AgentConfig | null;
  state: ConnectionState;
  hello: Hello | null;
  chat: ChatState;
  sessionId: string | null;
  /** Last handshake/frame problem, shown verbatim rather than as "offline". */
  error: string | null;

  restore: () => Promise<boolean>;
  connect: (creds: AgentCredentials) => void;
  disconnect: () => void;
  startSession: (permissionMode?: PermissionMode) => Promise<void>;
  send: (text: string) => Promise<void>;
  respond: (requestId: string, allow: boolean) => Promise<void>;
  interrupt: () => Promise<void>;
}

/**
 * One client for the whole app.
 *
 * Every screen reads from this store rather than opening its own socket: the
 * session lives on the dev box and is addressed by id, so a second connection
 * would buy nothing and cost a second heartbeat, a second replay, and a race
 * over who answers a permission ask.
 */
let client: WsClient | null = null;

export const useConnection = create<ConnectionSlice>((set, get) => ({
  config: null,
  state: 'disconnected',
  hello: null,
  chat: initialChatState,
  sessionId: null,
  error: null,

  async restore() {
    const saved = await loadAgent();
    if (!saved) return false;
    get().connect(saved);
    return true;
  },

  connect({ config, token, accessSecret }) {
    client?.close();
    set({ config, error: null, hello: null });

    const next = new WsClient({
      url: preferredEndpoints(config),
      token,
      deviceId: 'android',
      createSocket: makeRnSocket({
        clientId: config.accessClientId,
        clientSecret: accessSecret,
      }),
    });

    next.onStateChange((state) => set({ state }));
    next.onHello((hello) => set({ hello }));
    next.onEvent((event) => set((s) => ({ chat: chatReducer(s.chat, event) })));
    next.onError(({ phase, error }) => set({ error: `${phase}: ${error.message}` }));

    next.connect();
    client = next;
  },

  disconnect() {
    client?.close();
    client = null;
    set({ state: 'disconnected', hello: null, sessionId: null, chat: initialChatState });
  },

  async startSession(permissionMode) {
    if (!client) return;
    try {
      // Omitted rather than defaulted here: the agent resolves an absent mode
      // to `default` itself, and sending one it will refuse turns a mode
      // choice into a failed session start.
      const res = await client.request(
        'claude/start',
        permissionMode ? { permissionMode } : {},
      );
      client.track(res.sessionId, 0);
      set({ sessionId: res.sessionId, chat: initialChatState, error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async send(text) {
    const { sessionId } = get();
    if (!client || !sessionId || !text.trim()) return;

    // Echo locally first. The agent does not replay the user's own turn, and
    // waiting for a round trip to show what you just said reads as a dropped
    // message on a slow link.
    set((s) => ({ chat: appendUserMessage(s.chat, text.trim(), makeId()) }));
    try {
      await client.request('claude/send', { sessionId, text: text.trim() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async respond(requestId, allow) {
    const { sessionId } = get();
    if (!client || !sessionId) return;
    try {
      await client.request('claude/permission-respond', {
        sessionId,
        requestId,
        decision: allow
          ? { allow: true, scope: 'once' }
          : { allow: false, message: 'Denied from phone' },
      });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  async interrupt() {
    const { sessionId } = get();
    if (!client || !sessionId) return;
    try {
      await client.request('claude/interrupt', { sessionId });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));

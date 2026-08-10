import { events, type Event } from '@vff/protocol';

const E = events.EVENT_TYPES.claude;

export interface AssistantMessage {
  kind: 'assistant';
  id: string;
  text: string;
  /** False once assistant-end arrives; drives the streaming cursor. */
  streaming: boolean;
}

export interface UserMessage {
  kind: 'user';
  id: string;
  text: string;
}

export interface ToolCard {
  kind: 'tool';
  id: string;
  toolUseId: string;
  toolName: string;
  summary: string;
  input: unknown;
  result: { ok: boolean; preview: string; truncated: boolean } | null;
}

/** Rendered where the gap occurred, so history is never silently discontinuous. */
export interface TruncationMarker {
  kind: 'truncation';
  id: string;
  droppedEvents: number;
}

export interface ErrorItem {
  kind: 'error';
  id: string;
  message: string;
  fatal: boolean;
}

export type ChatItem = AssistantMessage | UserMessage | ToolCard | TruncationMarker | ErrorItem;

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  render: {
    title: string;
    subtitle: string;
    body: { kind: 'command' | 'diff' | 'json' | 'text'; value: string };
    risk: 'low' | 'medium' | 'high';
  };
  expiresAt: number | null;
}

export interface RateLimit {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  limitType: string | null;
  utilization: number | null;
  resetsAt: number | null;
  summary: string;
}

export interface ChatState {
  items: ChatItem[];
  /** Keyed by requestId; more than one can be outstanding. */
  pendingPermissions: Record<string, PendingPermission>;
  thinking: boolean;
  rateLimit: RateLimit | null;
  authTrouble: { message: string; remedy: string | null } | null;
  lastSeq: number;
  /** Cumulative token usage; cost is deliberately not surfaced. */
  usage: { inputTokens: number; outputTokens: number } | null;
}

export const initialChatState: ChatState = {
  items: [],
  pendingPermissions: {},
  thinking: false,
  rateLimit: null,
  authTrouble: null,
  lastSeq: 0,
  usage: null,
};

/**
 * Fold one wire event into chat state.
 *
 * Pure and RN-free on purpose: this is where most client bugs live, and
 * keeping it a plain function means they're caught by fast Node tests rather
 * than by squinting at a phone.
 *
 * Idempotent by sequence number — replaying an overlapping range after a
 * reconnect must not duplicate anything.
 */
export function chatReducer(state: ChatState, event: Event): ChatState {
  // Replay overlap: the agent may resend events we already folded in.
  if (event.seq <= state.lastSeq) return state;

  const next: ChatState = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case E.assistantDelta: {
      const { text } = event.body as { text: string };
      return { ...next, items: appendDelta(state.items, text, event.seq) };
    }

    case E.assistantEnd:
      return { ...next, items: closeStreaming(state.items) };

    case E.thinking:
      return { ...next, thinking: (event.body as { active: boolean }).active };

    case E.toolUse: {
      const b = event.body as {
        toolUseId: string;
        toolName: string;
        summary: string;
        input: unknown;
      };
      return {
        ...next,
        // A tool call ends the current bubble — text after it is a new one.
        items: [
          ...closeStreaming(state.items),
          {
            kind: 'tool',
            id: `tool-${b.toolUseId}`,
            toolUseId: b.toolUseId,
            toolName: b.toolName,
            summary: b.summary,
            input: b.input,
            result: null,
          },
        ],
      };
    }

    case E.toolResult: {
      const b = event.body as {
        toolUseId: string;
        ok: boolean;
        preview: string;
        truncated: boolean;
      };
      return {
        ...next,
        items: state.items.map((item) =>
          item.kind === 'tool' && item.toolUseId === b.toolUseId
            ? { ...item, result: { ok: b.ok, preview: b.preview, truncated: b.truncated } }
            : item,
        ),
      };
    }

    case E.permissionPending: {
      const p = event.body as PendingPermission;
      return {
        ...next,
        pendingPermissions: { ...state.pendingPermissions, [p.requestId]: p },
      };
    }

    case E.permissionResolved: {
      const { requestId } = event.body as { requestId: string };
      const remaining = { ...state.pendingPermissions };
      delete remaining[requestId];
      return { ...next, pendingPermissions: remaining };
    }

    case E.rateLimit:
      return { ...next, rateLimit: event.body as RateLimit };

    case E.authTrouble:
      return { ...next, authTrouble: event.body as { message: string; remedy: string | null } };

    case E.turnDone: {
      const b = event.body as {
        usage: { inputTokens: number; outputTokens: number } | null;
      };
      return {
        ...next,
        thinking: false,
        items: closeStreaming(state.items),
        usage: b.usage
          ? { inputTokens: b.usage.inputTokens, outputTokens: b.usage.outputTokens }
          : state.usage,
      };
    }

    case E.error: {
      const b = event.body as { message: string; fatal: boolean };
      return {
        ...next,
        thinking: false,
        items: [
          ...closeStreaming(state.items),
          { kind: 'error', id: `err-${event.seq}`, message: b.message, fatal: b.fatal },
        ],
      };
    }

    case E.truncated: {
      const b = event.body as { droppedEvents: number };
      return {
        ...next,
        items: [
          ...state.items,
          { kind: 'truncation', id: `trunc-${event.seq}`, droppedEvents: b.droppedEvents },
        ],
      };
    }

    default:
      // Unknown event type from a newer agent. Advancing lastSeq without
      // rendering is correct — dropping it would look like a gap and trigger
      // a pointless re-attach loop.
      return next;
  }
}

/** Locally echo what the user sent, before the agent confirms it. */
export function appendUserMessage(state: ChatState, text: string, id: string): ChatState {
  return {
    ...state,
    items: [...closeStreaming(state.items), { kind: 'user', id, text }],
  };
}

function appendDelta(items: ChatItem[], text: string, seq: number): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === 'assistant' && last.streaming) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { kind: 'assistant', id: `a-${seq}`, text, streaming: true }];
}

function closeStreaming(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.kind === 'assistant' && last.streaming) {
    return [...items.slice(0, -1), { ...last, streaming: false }];
  }
  return items;
}

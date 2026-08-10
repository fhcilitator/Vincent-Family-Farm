import { z } from 'zod';

/**
 * Server-push event bodies. Every event carries `seq` + `stream` on the
 * envelope, so the client renders from an append-only log and reconnect
 * replay is just "everything after seq N".
 */

/* ------------------------------------------------------------------ claude */

/** Incremental assistant text. The app appends; it never re-renders from scratch. */
export const ClaudeAssistantDelta = z.object({
  text: z.string(),
});

/** A complete assistant message boundary — used to close the current bubble. */
export const ClaudeAssistantEnd = z.object({});

/** Claude decided to call a tool. Rendered as a collapsible card. */
export const ClaudeToolUse = z.object({
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  summary: z.string(),
});

export const ClaudeToolResult = z.object({
  toolUseId: z.string(),
  ok: z.boolean(),
  /** Truncated for transport; the full result stays on the dev box. */
  preview: z.string(),
  truncated: z.boolean(),
});

/** Thinking is a progress signal only — never carries reasoning content. */
export const ClaudeThinking = z.object({ active: z.boolean() });

export const ClaudeTurnDone = z.object({
  stopReason: z.string().nullable(),
  /** Cumulative for the session, so the app can show spend. */
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative().nullable(),
    })
    .nullable(),
});

export const ClaudeSessionError = z.object({
  message: z.string(),
  fatal: z.boolean(),
});

/**
 * A tool call is waiting on human approval. This is an *event*, not an RPC
 * reply — it lives in the channel log, so it replays to a phone that
 * reconnects minutes later and is answerable from a fresh socket.
 *
 * `render` is precomputed by the agent so the phone stays dumb: it displays
 * what it's given rather than trying to interpret arbitrary tool input.
 */
export const ClaudePermissionPending = z.object({
  requestId: z.string(),
  toolName: z.string(),
  /** Raw input, for the "show me exactly what it will do" expansion. */
  input: z.unknown(),
  render: z.object({
    title: z.string(),
    subtitle: z.string(),
    body: z.object({
      kind: z.enum(['command', 'diff', 'json', 'text']),
      value: z.string(),
    }),
    /**
     * Drives the approval sheet's styling and the arm-delay on the Allow
     * button. Computed from destructive verbs, writes outside the workspace
     * root, and network access.
     */
    risk: z.enum(['low', 'medium', 'high']),
  }),
  /** Absolute epoch ms, or null to wait indefinitely. */
  expiresAt: z.number().nullable(),
});

/** Resolution, so every attached device converges and dismisses its sheet. */
export const ClaudePermissionResolved = z.object({
  requestId: z.string(),
  allowed: z.boolean(),
  by: z.enum(['device', 'timeout', 'rule', 'cancelled']),
});

/* --------------------------------------------------------------------- pty */

export const PtyData = z.object({
  /** base64 */
  data: z.string(),
});

export const PtyExit = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nullable(),
});

/* ------------------------------------------------------------- files / git */

/** The channel log rolled over while the client was away. */
export const ClaudeTruncated = z.object({
  droppedEvents: z.number().int().nonnegative(),
});

/** Emitted when the agent notices the tree changed (including Claude's edits). */
export const FilesChanged = z.object({
  paths: z.array(z.string()),
});

/** Nudges the diff screen to refetch rather than shipping the whole diff. */
export const GitChanged = z.object({
  reason: z.enum(['status', 'commit', 'push', 'external']),
});

/** Names are the `type` field on the event envelope. */
export const EVENT_TYPES = {
  claude: {
    assistantDelta: 'claude/assistant-delta',
    assistantEnd: 'claude/assistant-end',
    toolUse: 'claude/tool-use',
    toolResult: 'claude/tool-result',
    thinking: 'claude/thinking',
    turnDone: 'claude/turn-done',
    error: 'claude/error',
    permissionPending: 'claude/permission-pending',
    permissionResolved: 'claude/permission-resolved',
    /** Log rolled over; the client renders "…earlier output dropped". */
    truncated: 'claude/truncated',
  },
  pty: {
    data: 'pty/data',
    exit: 'pty/exit',
  },
  files: {
    changed: 'files/changed',
  },
  git: {
    changed: 'git/changed',
  },
} as const;

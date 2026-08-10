import { z } from 'zod';

/**
 * Op payload schemas, grouped by channel.
 *
 * Convention: `X_Req` is the `body` of a `req` envelope, `X_Res` is the `body`
 * of a successful `res`. Event bodies live in `events.ts`.
 */

/* ------------------------------------------------------------------ shared */

/**
 * Mirrors the Agent SDK's PermissionMode exactly, verified against the pinned
 * SDK's type declarations. Kept in sync by a compile-time assertion in the
 * agent's sdk-contract test — if the SDK adds a mode, that test fails.
 *
 * Declared here rather than in the claude section because the system/hello
 * policy references it, and a const referenced before its declaration is a
 * temporal-dead-zone crash at import time.
 */
export const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

/* ------------------------------------------------------------------ system */

export const SystemHelloReq = z.object({
  /** Protocol version the client speaks. Agent rejects mismatched majors. */
  protocolVersion: z.number().int().positive(),
  deviceId: z.string().min(1),
  clientVersion: z.string().min(1),
});

/**
 * Which listener accepted this connection. `trusted` is the tailnet-private
 * path; `public` is reachable from the internet and is deliberately more
 * restricted. Determined by the accepting socket, never by a client-supplied
 * header — see the agent's server.ts.
 */
export const TrustTierSchema = z.enum(['trusted', 'public']);
export type TrustTier = z.infer<typeof TrustTierSchema>;

/**
 * The restrictions actually in force on this connection. Sent by the agent so
 * the app displays the truth rather than inferring it from which URL it
 * dialled — the behaviour difference is visible to the user (more prompts,
 * shorter timeouts) and a silent change reads as a bug.
 */
export const EffectivePolicySchema = z.object({
  /** False on public: every tool call must be approved individually. */
  allowSessionScopedApprovals: z.boolean(),
  /** Permission modes this connection may select. */
  allowedPermissionModes: z.array(PermissionModeSchema),
  permissionTimeoutMs: z.number().int().nonnegative(),
});

/**
 * Whether the dev box can actually talk to Claude.
 *
 * The phone holds no Anthropic credential — the agent inherits whatever the
 * `claude` CLI is signed into. This reports that state so the app can show an
 * actionable banner instead of letting the user discover the problem as a
 * failed message.
 *
 * Best-effort: only a real request proves a credential is valid, so
 * `usable: true` means "nothing is obviously wrong", not "guaranteed".
 */
export const ClaudeAuthStateSchema = z.object({
  usable: z.boolean(),
  source: z.enum(['env-api-key', 'env-auth-token', 'cli-login', 'ant-profile', 'none']),
  binaryFound: z.boolean(),
  detail: z.string(),
  /** Exact command to run on the dev box, when broken. */
  remedy: z.string().nullable(),
});

export const SystemHelloRes = z.object({
  protocolVersion: z.number().int().positive(),
  agentVersion: z.string(),
  workspaceRoot: z.string(),
  tier: TrustTierSchema,
  policy: EffectivePolicySchema,
  claudeAuth: ClaudeAuthStateSchema,
  /** Capabilities the agent actually has, so the app can hide dead UI. */
  capabilities: z.object({
    claude: z.boolean(),
    pty: z.boolean(),
    git: z.boolean(),
    files: z.boolean(),
  }),
});

export const SystemPingReq = z.object({ nonce: z.string() });
export const SystemPingRes = z.object({ nonce: z.string(), serverTime: z.number() });

/* ------------------------------------------------------------------ claude */

export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const ClaudeStartReq = z.object({
  /** Relative to workspace root. Absent means the root itself. */
  cwd: z.string().optional(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  permissionMode: PermissionModeSchema.optional(),
  /** Resume an existing SDK session instead of starting fresh. */
  resume: z.string().optional(),
  forkSession: z.boolean().optional(),
});

export const ClaudeStartRes = z.object({
  sessionId: z.string(),
  resumed: z.boolean(),
});

export const ClaudeSendReq = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
});
export const ClaudeSendRes = z.object({ accepted: z.literal(true) });

/**
 * Re-attach to a session that outlived the socket. `sinceSeq` is the last
 * event the client durably rendered; the agent replays everything after it.
 * This is what makes work survive a phone losing signal.
 */
export const ClaudeAttachReq = z.object({
  sessionId: z.string(),
  sinceSeq: z.number().int().nonnegative().default(0),
});
export const ClaudeAttachRes = z.object({
  sessionId: z.string(),
  /** Whether the agent is mid-turn right now. */
  running: z.boolean(),
  /** Events with seq > sinceSeq, oldest first. */
  replay: z.array(z.unknown()),
  /** Highest seq now in the log, so the client can detect gaps. */
  head: z.number().int().nonnegative(),
  /**
   * The log rolled over and events between sinceSeq and the oldest retained
   * event are gone. The client renders an explicit "earlier output dropped"
   * marker rather than silently showing a discontinuous transcript.
   */
  truncated: z.boolean(),
});

export const ClaudeInterruptReq = z.object({ sessionId: z.string() });
export const ClaudeInterruptRes = z.object({ interrupted: z.boolean() });

export const ClaudeListSessionsReq = z.object({ limit: z.number().int().positive().max(100).default(20) });
export const ClaudeListSessionsRes = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      title: z.string().nullable(),
      lastModified: z.number(),
      running: z.boolean(),
    }),
  ),
});

/**
 * Our permission decision type. Deliberately decoupled from the SDK's — see
 * the note on `canUseTool` drift in the agent's sdk-adapter.
 */
export const PermissionDecisionSchema = z.discriminatedUnion('allow', [
  z.object({
    allow: z.literal(true),
    /** Optional edited tool input. */
    updatedInput: z.unknown().optional(),
    scope: z.enum(['once', 'session', 'always']).default('once'),
  }),
  z.object({
    allow: z.literal(false),
    /** Surfaced back to Claude so it can adapt rather than just failing. */
    message: z.string().optional(),
  }),
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/**
 * The phone answering a pending permission ask. An ordinary client -> agent
 * request; the ask itself arrived as a durable event (see envelope.ts).
 */
export const ClaudePermissionRespondReq = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  decision: PermissionDecisionSchema,
});
export const ClaudePermissionRespondRes = z.object({
  /** False when the ask already resolved — timed out, or another device won. */
  applied: z.boolean(),
});

/* --------------------------------------------------------------------- pty */

export const PtyOpenReq = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(500),
  shell: z.string().optional(),
});
export const PtyOpenRes = z.object({ ptyId: z.string() });

export const PtyInputReq = z.object({
  ptyId: z.string(),
  /** base64 — terminals carry bytes, not text. */
  data: z.string(),
});
export const PtyInputRes = z.object({ accepted: z.literal(true) });

export const PtyResizeReq = z.object({
  ptyId: z.string(),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(500),
});
export const PtyResizeRes = z.object({ ok: z.literal(true) });

export const PtyAttachReq = z.object({ ptyId: z.string() });
export const PtyAttachRes = z.object({
  ptyId: z.string(),
  /** base64 scrollback so a reattaching phone repaints instead of showing blank. */
  scrollback: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const PtyCloseReq = z.object({ ptyId: z.string() });
export const PtyCloseRes = z.object({ closed: z.literal(true) });

/* ------------------------------------------------------------------- files */

/** All paths are workspace-relative, POSIX separators. Never absolute. */
const RelPath = z.string().min(1).max(1024);

export const FilesListReq = z.object({ path: RelPath.default('.') });
export const FilesListRes = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      type: z.enum(['file', 'dir', 'symlink']),
      size: z.number().int().nonnegative(),
      modified: z.number(),
    }),
  ),
});

export const FilesReadReq = z.object({
  path: RelPath,
  maxBytes: z.number().int().positive().max(2_000_000).default(1_000_000),
});
export const FilesReadRes = z.object({
  path: z.string(),
  /** Absent when the file is binary; `binary` says why there's no content. */
  content: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
  size: z.number().int().nonnegative(),
});

export const FilesWriteReq = z.object({
  path: RelPath,
  content: z.string(),
  /**
   * Hash of the content the client last read. Rejects the write with
   * `conflict` if the file changed underneath — Claude and the user edit the
   * same tree concurrently, so this is a real race, not a theoretical one.
   */
  expectedSha256: z.string().nullable(),
});
export const FilesWriteRes = z.object({ path: z.string(), sha256: z.string() });

/* --------------------------------------------------------------------- git */

export const GitStatusReq = z.object({});
export const GitStatusRes = z.object({
  branch: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      path: z.string(),
      index: z.string(),
      workingDir: z.string(),
      staged: z.boolean(),
    }),
  ),
});

export const GitDiffReq = z.object({
  path: RelPath.optional(),
  staged: z.boolean().default(false),
});
export const GitDiffRes = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      oldPath: z.string().nullable(),
      binary: z.boolean(),
      hunks: z.array(
        z.object({
          header: z.string(),
          oldStart: z.number().int(),
          oldLines: z.number().int(),
          newStart: z.number().int(),
          newLines: z.number().int(),
          lines: z.array(
            z.object({
              kind: z.enum(['context', 'add', 'del']),
              text: z.string(),
            }),
          ),
        }),
      ),
    }),
  ),
});

export const GitStageReq = z.object({
  paths: z.array(RelPath).min(1),
  unstage: z.boolean().default(false),
});
export const GitStageRes = z.object({ staged: z.array(z.string()) });

export const GitCommitReq = z.object({
  message: z.string().min(1).max(4096),
});
export const GitCommitRes = z.object({ sha: z.string(), summary: z.string() });

export const GitPushReq = z.object({
  remote: z.string().default('origin'),
  branch: z.string().optional(),
  setUpstream: z.boolean().default(false),
});
export const GitPushRes = z.object({ pushed: z.literal(true), detail: z.string() });

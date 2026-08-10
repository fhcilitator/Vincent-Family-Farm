import { z } from 'zod';
import type { Channel } from './envelope.js';
import * as ops from './ops.js';

/**
 * Single source of truth mapping `${channel}/${op}` to its request and
 * response schemas. Both peers validate against this, and the derived types
 * give call sites end-to-end inference — a protocol change that breaks the app
 * is a compile error, not a runtime surprise on a phone.
 */
export const OP_REGISTRY = {
  'system/hello': { req: ops.SystemHelloReq, res: ops.SystemHelloRes },
  'system/ping': { req: ops.SystemPingReq, res: ops.SystemPingRes },

  'claude/start': { req: ops.ClaudeStartReq, res: ops.ClaudeStartRes },
  'claude/send': { req: ops.ClaudeSendReq, res: ops.ClaudeSendRes },
  'claude/attach': { req: ops.ClaudeAttachReq, res: ops.ClaudeAttachRes },
  'claude/interrupt': { req: ops.ClaudeInterruptReq, res: ops.ClaudeInterruptRes },
  'claude/list-sessions': { req: ops.ClaudeListSessionsReq, res: ops.ClaudeListSessionsRes },
  'claude/permission-respond': {
    req: ops.ClaudePermissionRespondReq,
    res: ops.ClaudePermissionRespondRes,
  },

  'pty/open': { req: ops.PtyOpenReq, res: ops.PtyOpenRes },
  'pty/input': { req: ops.PtyInputReq, res: ops.PtyInputRes },
  'pty/resize': { req: ops.PtyResizeReq, res: ops.PtyResizeRes },
  'pty/attach': { req: ops.PtyAttachReq, res: ops.PtyAttachRes },
  'pty/close': { req: ops.PtyCloseReq, res: ops.PtyCloseRes },

  'files/list': { req: ops.FilesListReq, res: ops.FilesListRes },
  'files/read': { req: ops.FilesReadReq, res: ops.FilesReadRes },
  'files/write': { req: ops.FilesWriteReq, res: ops.FilesWriteRes },

  'git/status': { req: ops.GitStatusReq, res: ops.GitStatusRes },
  'git/diff': { req: ops.GitDiffReq, res: ops.GitDiffRes },
  'git/stage': { req: ops.GitStageReq, res: ops.GitStageRes },
  'git/commit': { req: ops.GitCommitReq, res: ops.GitCommitRes },
  'git/push': { req: ops.GitPushReq, res: ops.GitPushRes },
} as const satisfies Record<string, { req: z.ZodTypeAny; res: z.ZodTypeAny }>;

export type OpName = keyof typeof OP_REGISTRY;

export type ReqBody<K extends OpName> = z.input<(typeof OP_REGISTRY)[K]['req']>;
export type ParsedReqBody<K extends OpName> = z.output<(typeof OP_REGISTRY)[K]['req']>;
export type ResBody<K extends OpName> = z.output<(typeof OP_REGISTRY)[K]['res']>;

export function opName(ch: Channel, op: string): OpName | null {
  const key = `${ch}/${op}`;
  return key in OP_REGISTRY ? (key as OpName) : null;
}

export function splitOp(name: OpName): { ch: Channel; op: string } {
  const idx = name.indexOf('/');
  return {
    ch: name.slice(0, idx) as Channel,
    op: name.slice(idx + 1),
  };
}

/** Current protocol version. Bump the major on any breaking envelope change. */
export const PROTOCOL_VERSION = 1;

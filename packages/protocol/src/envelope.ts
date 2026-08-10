import { z } from 'zod';

/**
 * Every frame on the wire is one of three shapes. The distinction matters:
 *
 *  - `req`  — correlated call, client -> agent only. Short-lived; dies with
 *             the socket.
 *  - `res`  — the reply to a `req`, matched by id.
 *  - `event` — agent -> client push (output deltas, PTY bytes, permission
 *             asks). Carries a monotonic `seq` per stream so a reconnecting
 *             client asks for everything after the last one it saw.
 *
 * There is deliberately NO agent-originated request. A tool-permission ask is
 * modelled as a durable *event*, not an RPC, because an RPC dies with the
 * socket and a phone's socket dies constantly. The agent appends
 * `claude/permission-pending` to the channel log and holds the SDK's
 * `canUseTool` promise open in memory; the phone answers with an ordinary
 * `claude/permission-respond` request whenever it next has a connection.
 *
 * The consequence is the behaviour that makes this app viable: you can
 * background the app mid-task, come back ten minutes later, and the approval
 * prompt is still waiting — replayed from the log, answerable from a fresh
 * socket. Two devices attached to one session both see it; first responder
 * wins and the other gets `permission-resolved`.
 */

export const CHANNELS = ['system', 'claude', 'pty', 'files', 'git'] as const;
export const ChannelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof ChannelSchema>;

/** Stable error codes. Clients branch on these, never on `message`. */
export const ERROR_CODES = [
  'unauthorized',
  'bad_request',
  'not_found',
  'conflict',
  'path_outside_workspace',
  'session_not_found',
  'permission_denied',
  'permission_timeout',
  'unsupported_op',
  'internal',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const WireErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  /** Optional structured detail. Never include stack traces or absolute host paths. */
  detail: z.unknown().optional(),
});
export type WireError = z.infer<typeof WireErrorSchema>;

export const RequestSchema = z.object({
  kind: z.literal('req'),
  id: z.string().min(1),
  ch: ChannelSchema,
  op: z.string().min(1),
  body: z.unknown(),
});
export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    kind: z.literal('res'),
    id: z.string().min(1),
    ok: z.literal(true),
    body: z.unknown(),
  }),
  z.object({
    kind: z.literal('res'),
    id: z.string().min(1),
    ok: z.literal(false),
    error: WireErrorSchema,
  }),
]);
export type Response = z.infer<typeof ResponseSchema>;

export const EventSchema = z.object({
  kind: z.literal('event'),
  ch: ChannelSchema,
  type: z.string().min(1),
  /**
   * Monotonic sequence number scoped to `stream` (a Claude session id or PTY
   * id). Reconnect replay is "send me everything with seq > N".
   */
  seq: z.number().int().nonnegative(),
  stream: z.string().min(1),
  body: z.unknown(),
});
export type Event = z.infer<typeof EventSchema>;

/**
 * A plain union, not a discriminated one: `Response` is itself discriminated
 * on `ok`, so both of its arms share `kind: "res"` — which zod's
 * `discriminatedUnion` rejects outright. The two-level shape (kind, then ok)
 * is worth more than the marginally better error messages.
 */
export const EnvelopeSchema = z.union([RequestSchema, ResponseSchema, EventSchema]);
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Max frame size. Guards against a hostile peer exhausting memory. */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export function isRequest(e: Envelope): e is Request {
  return e.kind === 'req';
}
export function isResponse(e: Envelope): e is Response {
  return e.kind === 'res';
}
export function isEvent(e: Envelope): e is Event {
  return e.kind === 'event';
}

/**
 * Parse an inbound frame. Both peers call this on everything they receive —
 * the agent because it is internet-facing, the app because a compromised or
 * buggy agent should not be able to corrupt client state.
 */
export function parseEnvelope(raw: string): Envelope {
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error('frame exceeds MAX_FRAME_BYTES');
  }
  return EnvelopeSchema.parse(JSON.parse(raw));
}

export function serializeEnvelope(e: Envelope): string {
  return JSON.stringify(e);
}

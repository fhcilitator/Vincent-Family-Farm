import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { events } from '@vff/protocol';
import { renderPermissionBody } from './sdk-adapter.js';

export interface TranslatedEvent {
  type: string;
  body: unknown;
}

const E = events.EVENT_TYPES.claude;

/**
 * SDKMessage -> our wire events.
 *
 * The SDK emits far more message kinds than a phone needs. We translate the
 * handful that drive the UI and drop the rest — an unrecognized message must
 * never crash the pump, because the pump dying silently would strand a live
 * session with no output.
 *
 * Returns an array because one SDK message can produce several events (an
 * assistant turn carrying both text and tool calls).
 */
export function translate(msg: SDKMessage): TranslatedEvent[] {
  switch (msg.type) {
    // Token-level deltas. Requires includePartialMessages: true — without it
    // this case never fires and text arrives only in whole messages.
    case 'stream_event':
      return translateStreamEvent(msg);

    case 'assistant':
      return translateAssistant(msg);

    case 'result':
      return [
        {
          type: E.turnDone,
          body: {
            stopReason: msg.subtype === 'success' ? 'end_turn' : msg.subtype,
            usage: extractUsage(msg),
          },
        },
      ];

    // Rate-limit headroom. Dropping this would mean a run that stalls on a
    // five-hour limit looks like a hang.
    case 'rate_limit_event':
      return [{ type: E.rateLimit, body: translateRateLimit(msg) }];

    // Auth trouble mid-session — an OAuth token can expire between the boot
    // preflight and any given turn. Surfacing it as a generic pump error
    // would read as a mystery failure.
    case 'auth_status':
      return translateAuthStatus(msg);

    case 'system':
      // Only the init handshake is interesting; it confirms model and cwd.
      if (msg.subtype === 'init') {
        return [
          {
            type: E.thinking,
            body: { active: false },
          },
        ];
      }
      return [];

    default:
      // Unknown or uninteresting kind. Dropping is correct and deliberate.
      return [];
  }
}

/** The credential source the SDK reports on session init, if present. */
export function apiKeySourceOf(msg: SDKMessage): string | null {
  if (msg.type !== 'system' || msg.subtype !== 'init') return null;
  const source = (msg as { apiKeySource?: unknown }).apiKeySource;
  return typeof source === 'string' ? source : null;
}

function translateRateLimit(msg: Extract<SDKMessage, { type: 'rate_limit_event' }>): unknown {
  const info = (msg as { rate_limit_info?: Record<string, unknown> }).rate_limit_info ?? {};

  const status =
    info.status === 'rejected' || info.status === 'allowed_warning' ? info.status : 'allowed';
  const limitType = typeof info.rateLimitType === 'string' ? info.rateLimitType : null;
  const utilization = typeof info.utilization === 'number' ? info.utilization : null;
  const resetsAt = typeof info.resetsAt === 'number' ? info.resetsAt : null;

  return {
    status,
    limitType,
    utilization,
    resetsAt,
    summary: summarizeRateLimit(status, limitType, utilization, resetsAt),
  };
}

function summarizeRateLimit(
  status: string,
  limitType: string | null,
  utilization: number | null,
  resetsAt: number | null,
): string {
  const window = describeWindow(limitType);
  const reset = resetsAt ? ` Resets ${new Date(resetsAt).toLocaleTimeString()}.` : '';

  if (status === 'rejected') return `Rate limit reached on your ${window}.${reset}`;

  if (status === 'allowed_warning') {
    const pct = utilization != null ? `${Math.round(utilization * 100)}% of ` : 'Approaching ';
    return `${pct}your ${window} used.${reset}`;
  }

  const pct = utilization != null ? `${Math.round(utilization * 100)}%` : 'OK';
  return `${pct} of your ${window} used.`;
}

function describeWindow(limitType: string | null): string {
  switch (limitType) {
    case 'five_hour':
      return '5-hour limit';
    case 'seven_day':
      return 'weekly limit';
    case 'seven_day_opus':
      return 'weekly Opus limit';
    case 'seven_day_sonnet':
      return 'weekly Sonnet limit';
    case 'overage':
    case 'seven_day_overage_included':
      return 'overage allowance';
    default:
      return 'usage limit';
  }
}

function translateAuthStatus(
  msg: Extract<SDKMessage, { type: 'auth_status' }>,
): TranslatedEvent[] {
  const error = (msg as { error?: unknown }).error;
  // Only an actual error is worth interrupting the user for; the SDK also
  // emits this message during normal, successful authentication.
  if (typeof error !== 'string' || error.length === 0) return [];

  return [
    {
      type: E.authTrouble,
      body: {
        message: error,
        remedy: 'Run `claude` on the dev box (or in this app’s terminal) and sign in.',
      },
    },
  ];
}

function translateStreamEvent(msg: Extract<SDKMessage, { type: 'stream_event' }>): TranslatedEvent[] {
  const event = msg.event as {
    type?: string;
    delta?: { type?: string; text?: string; thinking?: string };
    content_block?: { type?: string };
  };

  if (event.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
      return [{ type: E.assistantDelta, body: { text: event.delta.text } }];
    }
    // Thinking deltas are a progress signal only — we never forward reasoning
    // content to the device.
    if (event.delta?.type === 'thinking_delta') {
      return [{ type: E.thinking, body: { active: true } }];
    }
    return [];
  }

  if (event.type === 'content_block_start' && event.content_block?.type === 'thinking') {
    return [{ type: E.thinking, body: { active: true } }];
  }

  if (event.type === 'message_stop') {
    return [{ type: E.thinking, body: { active: false } }];
  }

  return [];
}

function translateAssistant(msg: Extract<SDKMessage, { type: 'assistant' }>): TranslatedEvent[] {
  const out: TranslatedEvent[] = [];
  const content = (msg.message as { content?: unknown[] }).content ?? [];

  for (const raw of content) {
    const block = raw as {
      type?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    };

    if (block.type === 'tool_use' && block.id && block.name) {
      const rendered = renderPermissionBody(block.name, block.input ?? {});
      out.push({
        type: E.toolUse,
        body: {
          toolUseId: block.id,
          toolName: block.name,
          input: block.input ?? {},
          summary: summarizeToolUse(block.name, block.input ?? {}, rendered.value),
        },
      });
    }
  }

  // Close the streaming bubble. Text already arrived as deltas, so we don't
  // resend it — doing so would double-render every message.
  out.push({ type: E.assistantEnd, body: {} });
  return out;
}

/** One-line label for a collapsed tool card, e.g. "Edit · src/api.ts". */
function summarizeToolUse(
  toolName: string,
  input: Record<string, unknown>,
  fallback: string,
): string {
  const path = typeof input.file_path === 'string' ? input.file_path : null;
  if (path) return `${toolName} · ${path}`;

  if (typeof input.command === 'string') {
    const cmd = input.command.split('\n')[0] ?? '';
    return `${toolName} · ${truncate(cmd, 60)}`;
  }

  if (typeof input.pattern === 'string') return `${toolName} · ${truncate(input.pattern, 60)}`;

  return `${toolName} · ${truncate(fallback.replace(/\s+/g, ' '), 60)}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function extractUsage(msg: Extract<SDKMessage, { type: 'result' }>): unknown {
  const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  const cost = (msg as { total_cost_usd?: number }).total_cost_usd;

  if (!usage) return null;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    costUsd: typeof cost === 'number' ? cost : null,
  };
}

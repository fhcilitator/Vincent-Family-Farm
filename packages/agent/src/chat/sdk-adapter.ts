import type { CanUseTool, PermissionResult, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ops } from '@vff/protocol';
import { z } from 'zod';

/**
 * THE ONLY FILE THAT MAY IMPORT SDK PERMISSION TYPES.
 *
 * The published docs disagree with each other about `canUseTool` — one shows
 * `(request, {signal}) => {approved: boolean}`, another shows
 * `{behavior: 'allow'|'deny'}`. Neither matches the shipped types. Verified
 * against the pinned SDK (0.3.226):
 *
 *   type CanUseTool = (
 *     toolName: string,
 *     input: Record<string, unknown>,
 *     options: { signal, suggestions?, blockedPath?, decisionReason?,
 *                title?, displayName? },
 *   ) => Promise<PermissionResult>
 *
 *   type PermissionResult =
 *     | { behavior: 'allow'; updatedInput?; updatedPermissions?; ... }
 *     | { behavior: 'deny';  message: string; interrupt?; ... }
 *
 * Two things that bite: the arguments are positional (not a request object),
 * and `message` is REQUIRED on deny. The SDK is pinned to an exact version
 * and sdk-contract.test.ts asserts this shape at compile time, so a dependency
 * bump fails loudly in CI rather than silently at 2am when Claude asks to
 * `rm -rf` something.
 */

export type PermissionDecision = z.infer<typeof ops.PermissionDecisionSchema>;

/** Re-exported so nothing else needs to import from the SDK. */
export type { CanUseTool, PermissionResult, PermissionMode };

/** Our decision -> the SDK's result. */
export function toSdkResult(decision: PermissionDecision): PermissionResult {
  if (decision.allow) {
    return {
      behavior: 'allow',
      // Only set when the user actually edited the input; passing an
      // unchanged copy is harmless but noisier in the SDK's logs.
      ...(decision.updatedInput !== undefined
        ? { updatedInput: decision.updatedInput as Record<string, unknown> }
        : {}),
    };
  }
  return {
    behavior: 'deny',
    // Required by the SDK, and surfaced back to Claude so it can adapt
    // rather than just failing opaquely.
    message: decision.message ?? 'Denied from the paired device.',
  };
}

/** Options the SDK hands to `canUseTool`, narrowed to what we actually use. */
export interface SdkPermissionContext {
  signal: AbortSignal;
  /**
   * Pre-rendered prompt sentence, e.g. "Claude wants to read foo.txt".
   * Preferred over anything we could reconstruct from toolName + input.
   */
  title?: string;
  /** Short noun phrase for a button label, e.g. "Read file". */
  displayName?: string;
  /** Why the prompt fired — useful context on the approval sheet. */
  decisionReason?: string;
  /** Set when a command tried to touch a path outside the allowed roots. */
  blockedPath?: string;
  /** "Always allow" options the SDK suggests. Presence drives the UI affordance. */
  suggestions?: unknown[];
}

/**
 * Normalize the SDK's positional arguments into one object, so the rest of
 * the codebase never has to know the argument order.
 */
export function normalizePermissionCall(
  toolName: string,
  input: Record<string, unknown>,
  options: SdkPermissionContext,
): {
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  title: string;
  displayName: string;
  decisionReason: string | null;
  blockedPath: string | null;
  hasSuggestions: boolean;
} {
  return {
    toolName,
    input,
    signal: options.signal,
    title: options.title ?? `Claude wants to use ${toolName}`,
    displayName: options.displayName ?? toolName,
    decisionReason: options.decisionReason ?? null,
    blockedPath: options.blockedPath ?? null,
    hasSuggestions: (options.suggestions?.length ?? 0) > 0,
  };
}

/**
 * Risk classification driving the approval sheet's styling and the arm-delay
 * on the Allow button.
 *
 * Deliberately conservative: this only ever escalates risk. It is a UI hint
 * that makes a dangerous approval harder to tap by accident — it is not a
 * security control, and nothing downstream may treat 'low' as permission to
 * skip asking.
 */
export function classifyRisk(
  toolName: string,
  input: Record<string, unknown>,
  blockedPath: string | null,
): 'low' | 'medium' | 'high' {
  if (blockedPath) return 'high';

  const command = typeof input.command === 'string' ? input.command : '';

  if (toolName === 'Bash' && command) {
    if (DESTRUCTIVE.test(command)) return 'high';
    if (NETWORK.test(command)) return 'medium';
    return 'medium';
  }

  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    return 'medium';
  }

  if (READ_ONLY_TOOLS.has(toolName)) return 'low';

  // Unknown tool — don't assume it's safe.
  return 'medium';
}

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite']);

/** Irreversible or credential-touching operations. */
const DESTRUCTIVE =
  /\b(rm\s+-[a-z]*[rf]|mkfs|dd\s+if=|shutdown|reboot|chmod\s+-R|chown\s+-R|truncate)\b|>\s*\/dev\/|\bgit\s+(push\s+--force|reset\s+--hard|clean\s+-[a-z]*f)|\b(curl|wget)\b.*\|\s*(ba)?sh|\bsudo\b|~\/\.ssh|\.env\b|\bcredentials\b/i;

const NETWORK = /\b(curl|wget|nc|ssh|scp|rsync|npm\s+publish|docker\s+push)\b/i;

/**
 * Human-readable body for the approval sheet. The phone displays what it is
 * given rather than interpreting arbitrary tool input — which keeps tool-shape
 * knowledge on the agent, where it can be updated without shipping an APK.
 */
export function renderPermissionBody(
  toolName: string,
  input: Record<string, unknown>,
): { kind: 'command' | 'diff' | 'json' | 'text'; value: string } {
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return { kind: 'command', value: input.command };
  }

  if ((toolName === 'Write' || toolName === 'Edit') && typeof input.file_path === 'string') {
    if (typeof input.new_string === 'string' && typeof input.old_string === 'string') {
      return {
        kind: 'diff',
        value: `--- ${input.file_path}\n- ${input.old_string}\n+ ${input.new_string}`,
      };
    }
    const content = typeof input.content === 'string' ? input.content : '';
    return { kind: 'diff', value: `+++ ${input.file_path}\n${content}` };
  }

  if (typeof input.file_path === 'string') {
    return { kind: 'text', value: input.file_path };
  }

  try {
    return { kind: 'json', value: JSON.stringify(input, null, 2) };
  } catch {
    return { kind: 'text', value: '(tool input could not be displayed)' };
  }
}

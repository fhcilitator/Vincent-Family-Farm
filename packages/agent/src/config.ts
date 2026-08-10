import path from 'node:path';
import fs from 'node:fs';
import type { TrustTier, PermissionMode } from '@vff/protocol';

/**
 * Restrictions applied to a connection, resolved from its trust tier.
 *
 * The public tier removes convenience, not capability: you can still do
 * everything from the road, you just have to approve each step.
 */
export interface TierPolicy {
  /** False on public — every tool call is approved individually. */
  allowSessionScopedApprovals: boolean;
  /** Modes a connection at this tier may select. */
  allowedPermissionModes: PermissionMode[];
  permissionTimeoutMs: number;
}

export interface AgentConfig {
  /** Bind address for both listeners. Never 0.0.0.0 — see start(). */
  host: string;
  /**
   * Two listeners, two trust tiers. The tier is a property of which socket
   * accepted the connection, which a client cannot forge — unlike a header
   * such as X-Forwarded-For, where one proxy misconfiguration would silently
   * promote the public path to trusted.
   *
   * This also matches a Tailscale constraint rather than fighting it: the
   * same port cannot be both `tailscale serve` (tailnet-private) and
   * `tailscale funnel` (public) — whichever ran last wins.
   *
   * Either may be null to run single-path.
   */
  listeners: {
    /** Reached via `tailscale serve` from inside the tailnet. */
    trusted: { port: number } | null;
    /** Reached via `tailscale funnel` or `cloudflared`. */
    public: { port: number } | null;
  };
  /**
   * Absolute paths the agent will touch. Every file, git, and session cwd is
   * validated against these. Fences this app's API — not the agent process
   * itself, which is why it should also run as a dedicated user.
   */
  roots: string[];
  /** Shared secret for phase 1. Replaced by device tokens in phase 6. */
  token: string;
  /** ms before an unanswered permission ask denies on the trusted path. 0 = forever. */
  permissionTimeoutMs: number;
  /**
   * Whether a trusted connection may select bypassPermissions. Off by
   * default. Never available on the public tier regardless of this setting.
   */
  allowBypassPermissions: boolean;
  /** Shorter ceiling for asks raised while only public clients are attached. */
  publicPermissionTimeoutMs: number;
}

export const DEFAULT_CONFIG: AgentConfig = {
  host: '127.0.0.1',
  listeners: { trusted: { port: 8787 }, public: null },
  roots: [],
  token: '',
  permissionTimeoutMs: 30 * 60 * 1000,
  allowBypassPermissions: false,
  publicPermissionTimeoutMs: 2 * 60 * 1000,
};

/** Modes that reduce or remove prompting, and so are trusted-path only. */
const PROMPT_REDUCING_MODES: PermissionMode[] = [
  'acceptEdits',
  'dontAsk',
  'auto',
  'bypassPermissions',
];

export function policyFor(cfg: AgentConfig, tier: TrustTier): TierPolicy {
  if (tier === 'public') {
    return {
      allowSessionScopedApprovals: false,
      // Only modes that keep every tool call gated behind a prompt.
      allowedPermissionModes: ['default', 'plan'],
      permissionTimeoutMs: cfg.publicPermissionTimeoutMs,
    };
  }

  const allowed: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto'];
  if (cfg.allowBypassPermissions) allowed.push('bypassPermissions');

  return {
    allowSessionScopedApprovals: true,
    allowedPermissionModes: allowed,
    permissionTimeoutMs: cfg.permissionTimeoutMs,
  };
}

export function isPromptReducing(mode: PermissionMode): boolean {
  return PROMPT_REDUCING_MODES.includes(mode);
}

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const fromEnv: Partial<AgentConfig> = {};
  if (process.env.VIBE_HOST) fromEnv.host = process.env.VIBE_HOST;
  if (process.env.VIBE_TOKEN) fromEnv.token = process.env.VIBE_TOKEN;
  if (process.env.VIBE_ROOTS) {
    fromEnv.roots = process.env.VIBE_ROOTS.split(':').filter(Boolean);
  }

  const trustedPort = process.env.VIBE_PORT ?? process.env.VIBE_TRUSTED_PORT;
  const publicPort = process.env.VIBE_PUBLIC_PORT;
  if (trustedPort || publicPort) {
    fromEnv.listeners = {
      trusted: trustedPort ? { port: Number(trustedPort) } : DEFAULT_CONFIG.listeners.trusted,
      public: publicPort ? { port: Number(publicPort) } : null,
    };
  }

  const cfg = { ...DEFAULT_CONFIG, ...fromEnv, ...overrides };

  if (cfg.roots.length === 0) cfg.roots = [process.cwd()];

  // Resolve through realpath so the later prefix checks can't be defeated by
  // a symlinked root.
  cfg.roots = cfg.roots.map((r) => {
    const abs = path.resolve(r);
    try {
      return fs.realpathSync.native(abs);
    } catch {
      return abs;
    }
  });

  return cfg;
}

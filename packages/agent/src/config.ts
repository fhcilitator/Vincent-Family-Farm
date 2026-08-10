import path from 'node:path';
import fs from 'node:fs';

export interface AgentConfig {
  /** Bind address. Never 0.0.0.0 — see the note in start(). */
  host: string;
  port: number;
  /**
   * Absolute paths the agent will touch. Every file, git, and session cwd is
   * validated against these. Fences this app's API — not the agent process
   * itself, which is why it should also run as a dedicated user.
   */
  roots: string[];
  /** Shared secret for phase 1. Replaced by device tokens in phase 6. */
  token: string;
  /** ms before an unanswered permission ask denies. 0 = wait forever. */
  permissionTimeoutMs: number;
  /**
   * Whether the phone may select bypassPermissions. Off by default: a
   * remotely-selectable kill switch for the only safety mechanism does not
   * belong on a device that gets left in bars.
   */
  allowBypassPermissions: boolean;
}

export const DEFAULT_CONFIG: AgentConfig = {
  host: '127.0.0.1',
  port: 8787,
  roots: [],
  token: '',
  permissionTimeoutMs: 30 * 60 * 1000,
  allowBypassPermissions: false,
};

export function loadConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const fromEnv: Partial<AgentConfig> = {};
  if (process.env.VIBE_HOST) fromEnv.host = process.env.VIBE_HOST;
  if (process.env.VIBE_PORT) fromEnv.port = Number(process.env.VIBE_PORT);
  if (process.env.VIBE_TOKEN) fromEnv.token = process.env.VIBE_TOKEN;
  if (process.env.VIBE_ROOTS) {
    fromEnv.roots = process.env.VIBE_ROOTS.split(':').filter(Boolean);
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

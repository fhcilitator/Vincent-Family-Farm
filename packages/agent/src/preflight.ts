import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AuthSource = 'env-api-key' | 'env-auth-token' | 'cli-login' | 'ant-profile' | 'none';

export interface ClaudeAuthState {
  /** Whether chat should be offered at all. */
  usable: boolean;
  /** Where the credential appears to come from. Best-effort. */
  source: AuthSource;
  /** Whether the claude binary resolved on PATH. */
  binaryFound: boolean;
  /** Human-readable, actionable. Shown verbatim in the app's banner. */
  detail: string;
  /** Exact command to run on the dev box to fix it, when broken. */
  remedy: string | null;
}

/** Injectable so the preflight is testable without touching the real machine. */
export interface PreflightDeps {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  exists: (p: string) => boolean;
  pathEntries: () => string[];
}

export const realDeps: PreflightDeps = {
  env: process.env,
  homedir: () => os.homedir(),
  exists: (p) => {
    try {
      fs.accessSync(p);
      return true;
    } catch {
      return false;
    }
  },
  pathEntries: () => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
};

/**
 * Best-effort check that the dev box can actually talk to Claude.
 *
 * The Agent SDK spawns the Claude Code binary, so it inherits whatever
 * `claude` is already logged into — there is no API key for this agent to
 * hold. What we can do cheaply is notice the common broken states at boot
 * rather than 30 seconds into the user's first message, where the failure
 * looks like a mystery.
 *
 * Deliberately NOT authoritative: only a real request proves a credential is
 * valid, and an OAuth token can expire between this check and the next turn.
 * Treat a `usable: true` here as "nothing is obviously wrong", and rely on
 * `auth_status` events for the truth.
 */
export function checkClaudeAuth(deps: PreflightDeps = realDeps): ClaudeAuthState {
  const binaryFound = findBinary('claude', deps) !== null;

  const source = detectSource(deps);

  if (!binaryFound && source === 'none') {
    return {
      usable: false,
      source: 'none',
      binaryFound: false,
      detail: 'The claude CLI was not found and no Anthropic credential is configured.',
      remedy: 'Install Claude Code on the dev box, then run: claude',
    };
  }

  if (!binaryFound) {
    return {
      usable: false,
      source,
      binaryFound: false,
      detail: 'A credential is configured but the claude CLI is not on PATH.',
      remedy: 'Install Claude Code on the dev box, or set pathToClaudeCodeExecutable.',
    };
  }

  if (source === 'none') {
    return {
      usable: false,
      source: 'none',
      binaryFound: true,
      detail: 'The claude CLI is installed but not signed in.',
      // The built-in terminal is the intended fix path — it is a real shell,
      // so the normal login flow just works there.
      remedy: 'Run `claude` on the dev box (or in this app’s terminal) and sign in.',
    };
  }

  return {
    usable: true,
    source,
    binaryFound: true,
    detail: describeSource(source),
    remedy: null,
  };
}

function detectSource(deps: PreflightDeps): AuthSource {
  // Mirrors the SDK's own resolution order: explicit env wins over stored
  // credentials, so report whichever would actually be used.
  if (deps.env.ANTHROPIC_API_KEY) return 'env-api-key';
  if (deps.env.ANTHROPIC_AUTH_TOKEN) return 'env-auth-token';

  const home = deps.homedir();
  if (deps.exists(path.join(home, '.claude', '.credentials.json'))) return 'cli-login';
  if (deps.exists(path.join(home, '.config', 'anthropic', 'credentials'))) return 'ant-profile';

  return 'none';
}

function describeSource(source: AuthSource): string {
  switch (source) {
    case 'env-api-key':
      return 'Authenticated with an API key from the environment.';
    case 'env-auth-token':
      return 'Authenticated with an auth token from the environment.';
    case 'cli-login':
      return 'Authenticated via the signed-in Claude CLI on the dev box.';
    case 'ant-profile':
      return 'Authenticated via a stored Anthropic CLI profile.';
    case 'none':
      return 'No credential found.';
  }
}

function findBinary(name: string, deps: PreflightDeps): string | null {
  for (const dir of deps.pathEntries()) {
    const candidate = path.join(dir, name);
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

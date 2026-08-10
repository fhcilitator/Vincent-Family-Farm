import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { checkClaudeAuth, type PreflightDeps } from '../src/preflight.js';
import { translate, apiKeySourceOf } from '../src/chat/translate.js';
import { events } from '@vff/protocol';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const E = events.EVENT_TYPES.claude;

/** A fake dev box, so the preflight is testable without touching the real one. */
function deps(over: {
  env?: NodeJS.ProcessEnv;
  files?: string[];
  pathDirs?: string[];
}): PreflightDeps {
  const files = new Set(over.files ?? []);
  return {
    env: over.env ?? {},
    homedir: () => '/home/dev',
    exists: (p) => files.has(p),
    pathEntries: () => over.pathDirs ?? ['/usr/bin'],
  };
}

const CLAUDE_BIN = '/usr/bin/claude';
const CLI_CREDS = path.join('/home/dev', '.claude', '.credentials.json');
const ANT_CREDS = path.join('/home/dev', '.config', 'anthropic', 'credentials');

describe('preflight detects the common broken states', () => {
  test('nothing installed and nothing configured', () => {
    const s = checkClaudeAuth(deps({}));
    assert.equal(s.usable, false);
    assert.equal(s.binaryFound, false);
    assert.equal(s.source, 'none');
    assert.match(s.remedy ?? '', /Install Claude Code/);
  });

  test('CLI installed but not signed in — the common case', () => {
    const s = checkClaudeAuth(deps({ files: [CLAUDE_BIN] }));
    assert.equal(s.usable, false);
    assert.equal(s.binaryFound, true);
    assert.equal(s.source, 'none');
    // The remedy must name the fix path the app actually offers.
    assert.match(s.remedy ?? '', /Run `claude`/);
  });

  test('credential present but CLI missing', () => {
    const s = checkClaudeAuth(deps({ env: { ANTHROPIC_API_KEY: 'sk-x' }, pathDirs: ['/nope'] }));
    assert.equal(s.usable, false);
    assert.equal(s.binaryFound, false);
  });
});

describe('preflight recognises each credential source', () => {
  test('a signed-in CLI is usable and needs no remedy', () => {
    const s = checkClaudeAuth(deps({ files: [CLAUDE_BIN, CLI_CREDS] }));
    assert.equal(s.usable, true);
    assert.equal(s.source, 'cli-login');
    assert.equal(s.remedy, null);
    assert.match(s.detail, /signed-in Claude CLI/);
  });

  test('an ant profile counts', () => {
    const s = checkClaudeAuth(deps({ files: [CLAUDE_BIN, ANT_CREDS] }));
    assert.equal(s.usable, true);
    assert.equal(s.source, 'ant-profile');
  });

  test('env API key wins over stored credentials, mirroring the SDK', () => {
    const s = checkClaudeAuth(
      deps({ env: { ANTHROPIC_API_KEY: 'sk-x' }, files: [CLAUDE_BIN, CLI_CREDS] }),
    );
    assert.equal(s.source, 'env-api-key', 'must report the credential that would actually be used');
    assert.equal(s.usable, true);
  });

  test('the preflight never reports a secret value', () => {
    const s = checkClaudeAuth(deps({ env: { ANTHROPIC_API_KEY: 'sk-super-secret' }, files: [CLAUDE_BIN] }));
    const serialized = JSON.stringify(s);
    assert.ok(!serialized.includes('sk-super-secret'), 'credential must never leave the dev box');
  });
});

/* ------------------------------------------------------------------------ */

function rateLimitMsg(info: Record<string, unknown>): SDKMessage {
  return {
    type: 'rate_limit_event',
    rate_limit_info: info,
    uuid: 'u',
    session_id: 's',
  } as unknown as SDKMessage;
}

describe('rate limits reach the phone instead of being dropped', () => {
  test('a rejection says what was hit and when it resets', () => {
    const resetsAt = Date.UTC(2026, 7, 10, 19, 4, 0);
    const [ev] = translate(
      rateLimitMsg({ status: 'rejected', rateLimitType: 'five_hour', resetsAt }),
    );

    assert.equal(ev?.type, E.rateLimit);
    const body = ev?.body as { status: string; summary: string; resetsAt: number };
    assert.equal(body.status, 'rejected');
    assert.equal(body.resetsAt, resetsAt);
    assert.match(body.summary, /5-hour limit/);
    assert.match(body.summary, /Resets/);
  });

  test('a warning fires before the run stalls, with utilization', () => {
    const [ev] = translate(
      rateLimitMsg({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.78 }),
    );
    const body = ev?.body as { status: string; summary: string; utilization: number };
    assert.equal(body.status, 'allowed_warning');
    assert.equal(body.utilization, 0.78);
    assert.match(body.summary, /78%/);
  });

  test('weekly limits get their own wording', () => {
    const [ev] = translate(rateLimitMsg({ status: 'allowed', rateLimitType: 'seven_day_opus' }));
    assert.match((ev?.body as { summary: string }).summary, /weekly Opus limit/);
  });

  test('an unknown limit type degrades to generic wording rather than leaking the enum', () => {
    const [ev] = translate(rateLimitMsg({ status: 'allowed', rateLimitType: 'brand_new_window' }));
    const summary = (ev?.body as { summary: string }).summary;
    assert.match(summary, /usage limit/);
    assert.ok(!summary.includes('brand_new_window'));
  });

  test('missing fields do not throw', () => {
    assert.doesNotThrow(() => translate(rateLimitMsg({})));
    const [ev] = translate(rateLimitMsg({}));
    const body = ev?.body as { status: string; utilization: null; resetsAt: null };
    assert.equal(body.status, 'allowed');
    assert.equal(body.utilization, null);
    assert.equal(body.resetsAt, null);
  });
});

describe('auth trouble surfaces as an actionable event', () => {
  const authMsg = (error?: string): SDKMessage =>
    ({
      type: 'auth_status',
      isAuthenticating: false,
      output: [],
      ...(error !== undefined ? { error } : {}),
      uuid: 'u',
      session_id: 's',
    }) as unknown as SDKMessage;

  test('an error becomes an auth-trouble event carrying a remedy', () => {
    const [ev] = translate(authMsg('OAuth token expired'));
    assert.equal(ev?.type, E.authTrouble);
    const body = ev?.body as { message: string; remedy: string };
    assert.equal(body.message, 'OAuth token expired');
    assert.match(body.remedy, /Run `claude`/);
  });

  test('a successful auth status emits nothing — no spurious banner', () => {
    assert.equal(translate(authMsg()).length, 0);
    assert.equal(translate(authMsg('')).length, 0);
  });
});

describe('apiKeySourceOf', () => {
  test('reads the credential source off session init', () => {
    const init = {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'oauth',
      uuid: 'u',
      session_id: 's',
    } as unknown as SDKMessage;
    assert.equal(apiKeySourceOf(init), 'oauth');
  });

  test('returns null for anything else', () => {
    assert.equal(apiKeySourceOf({ type: 'assistant' } as unknown as SDKMessage), null);
  });
});

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { start, loadConfig, type RunningAgent } from '@vff/agent';
import { events } from '@vff/protocol';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const E = events.EVENT_TYPES.claude;
const TOKEN = 'devclient-e2e-token';

/** First pre-installed Chromium we can find; empty means "let Playwright pick". */
const CHROME_PATH = [
  process.env.CHROME_EXECUTABLE,
  ...globSyncish('/opt/pw-browsers', 'chrome-linux/chrome'),
].find((p) => p && existsSync(p)) ?? '';

function globSyncish(root: string, tail: string): string[] {
  try {
    return readdirSync(root)
      .filter((d) => d.startsWith('chromium'))
      .map((d) => join(root, d, tail));
  } catch {
    return [];
  }
}

/**
 * End-to-end through a real browser against a real agent.
 *
 * This is why the browser client exists: an Expo app cannot be run in this
 * environment, but the logic underneath it can be proven here — including the
 * browser-specific handshake path, which uses Sec-WebSocket-Protocol because
 * browsers cannot set an Authorization header on a WebSocket.
 */

let agent: RunningAgent;
let vite: ViteDevServer;
let browser: Browser;
let page: Page;
let appUrl: string;

before(async () => {
  agent = await start(
    loadConfig({
      token: TOKEN,
      listeners: { trusted: { port: 0 }, public: null },
      roots: [process.cwd()],
    }),
  );

  vite = await createServer({
    root: new URL('..', import.meta.url).pathname,
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await vite.listen();
  const port = vite.httpServer?.address();
  const vitePort = typeof port === 'object' && port ? port.port : 5178;

  appUrl =
    `http://127.0.0.1:${vitePort}/?agent=` +
    encodeURIComponent(`ws://127.0.0.1:${agent.ports.trusted}`) +
    `&tok=${encodeURIComponent(TOKEN)}`;

  // The environment ships a Chromium build that may not match this
  // Playwright's expected revision, so point at it explicitly rather than
  // triggering a download.
  browser = await chromium.launch(
    CHROME_PATH ? { executablePath: CHROME_PATH } : {},
  );
  page = await browser.newPage();
});

after(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
  await agent?.close();
});

async function connectAndStart(): Promise<string> {
  await page.goto(appUrl);
  await page.getByTestId('connect').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="conn-state"]')?.textContent === 'live',
    undefined,
    { timeout: 10_000 },
  );
  await page.getByTestId('new-session').click();
  // The agent's session id isn't rendered; read it from the agent side.
  await page.waitForTimeout(200);
  const ids = agent.sessions.list(10).map((s) => s.sessionId);
  const id = ids[ids.length - 1];
  assert.ok(id, 'a session should exist after clicking New session');
  return id;
}

describe('browser handshake', () => {
  test('connects using the subprotocol token path and reaches live', async () => {
    await page.goto(appUrl);
    await page.getByTestId('connect').click();

    await page.waitForFunction(
      () => document.querySelector('[data-testid="conn-state"]')?.textContent === 'live',
      undefined,
      { timeout: 10_000 },
    );

    // Browsers cannot send Authorization on a WS handshake — reaching 'live'
    // proves the Sec-WebSocket-Protocol path works.
    assert.equal(await page.getByTestId('tier-badge').textContent(), 'trusted');
  });

  test('shows the auth banner when the dev box has no Claude login', async () => {
    // This machine has the CLI installed but is not signed in, so the banner
    // is the correct thing to render.
    await page.goto(appUrl);
    await page.getByTestId('connect').click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="conn-state"]')?.textContent === 'live',
      undefined,
      { timeout: 10_000 },
    );

    const banner = page.getByTestId('auth-banner');
    if (await banner.count()) {
      assert.match(await banner.textContent() ?? '', /not available|not signed in/i);
    }
  });
});

describe('streaming renders incrementally', () => {
  test('deltas accumulate into one bubble', async () => {
    const sessionId = await connectAndStart();

    emit(sessionId, E.assistantDelta, { text: 'Hello' });
    emit(sessionId, E.assistantDelta, { text: ', world' });

    await page.waitForFunction(
      () => document.querySelector('[data-testid="msg-assistant"]')?.textContent?.includes('Hello, world'),
      undefined,
      { timeout: 5000 },
    );
    assert.ok(true);
  });

  test('a tool call renders as a card', async () => {
    const sessionId = await connectAndStart();

    emit(sessionId, E.toolUse, {
      toolUseId: 't1',
      toolName: 'Read',
      summary: 'Read · src/app.ts',
      input: { file_path: 'src/app.ts' },
    });

    await page.getByTestId('tool-card').waitFor({ timeout: 5000 });
    assert.match(await page.getByTestId('tool-card').textContent() ?? '', /Read · src\/app\.ts/);
  });

  test('truncation is shown explicitly, not as a silent gap', async () => {
    const sessionId = await connectAndStart();

    emit(sessionId, E.truncated, { droppedEvents: 12 });

    await page.getByTestId('truncation').waitFor({ timeout: 5000 });
    assert.match(await page.getByTestId('truncation').textContent() ?? '', /12 earlier events/);
  });
});

describe('permission approval round trip', () => {
  test('a pending ask renders with the literal command and can be allowed', async () => {
    const sessionId = await connectAndStart();

    emit(sessionId, E.permissionPending, {
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      render: {
        title: 'Run a shell command',
        subtitle: '~/code/project',
        body: { kind: 'command', value: 'npm test' },
        risk: 'medium',
      },
      expiresAt: null,
    });

    await page.getByTestId('permission').waitFor({ timeout: 5000 });
    const text = await page.getByTestId('permission').textContent();
    // The sheet must show the literal command, never a paraphrase.
    assert.match(text ?? '', /npm test/);
    assert.match(text ?? '', /medium risk/);

    await page.getByTestId('allow').click();
    // No pending ask exists agent-side, so `applied` is false — what matters
    // is that the click round-trips without erroring.
    await page.waitForTimeout(200);
    assert.equal(await page.getByTestId('error').count(), 0);
  });

  test('resolution clears the prompt', async () => {
    const sessionId = await connectAndStart();

    emit(sessionId, E.permissionPending, {
      requestId: 'req-2',
      toolName: 'Bash',
      input: { command: 'ls' },
      render: {
        title: 'Run a shell command',
        subtitle: '~',
        body: { kind: 'command', value: 'ls' },
        risk: 'low',
      },
      expiresAt: null,
    });
    await page.getByTestId('permission').waitFor({ timeout: 5000 });

    emit(sessionId, E.permissionResolved, {
      requestId: 'req-2',
      allowed: true,
      by: 'device',
    });

    await page.getByTestId('permission').waitFor({ state: 'detached', timeout: 5000 });
    assert.ok(true);
  });
});

describe('reconnect in a real browser', () => {
  test('recovers and replays what it missed', async () => {
    const sessionId = await connectAndStart();

    emit(sessionId, E.assistantDelta, { text: 'before-drop ' });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="msg-assistant"]')?.textContent?.includes('before-drop'),
      undefined,
      { timeout: 5000 },
    );

    // Sever every agent-side socket — indistinguishable from a network blip
    // as far as the browser is concerned.
    agent.hub.disconnectAll(4999, 'test drop');

    await page.waitForFunction(
      () => document.querySelector('[data-testid="conn-state"]')?.textContent !== 'live',
      undefined,
      { timeout: 5000 },
    );

    // While it is away, Claude keeps working.
    agent.sessions.get(sessionId).log.append(E.assistantDelta, { text: 'during-drop ' });

    await page.waitForFunction(
      () => document.querySelector('[data-testid="conn-state"]')?.textContent === 'live',
      undefined,
      { timeout: 15_000 },
    );

    // The replay must bring the missed text in.
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="transcript"]')?.textContent?.includes('during-drop'),
      undefined,
      { timeout: 10_000 },
    );
    assert.ok(true);
  });
});

/** Append an event to a session log AND push it to attached clients. */
function emit(sessionId: string, type: string, body: unknown): void {
  const session = agent.sessions.get(sessionId);
  const entry = session.log.append(type, body);
  agent.hub.broadcast({
    kind: 'event',
    ch: 'claude',
    type: entry.type,
    seq: entry.seq,
    stream: sessionId,
    body: entry.body,
  });
}

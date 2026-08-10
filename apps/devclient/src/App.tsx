import { useCallback, useEffect, useRef, useState } from 'react';
import {
  WsClient,
  chatReducer,
  appendUserMessage,
  initialChatState,
  makeId,
  type ChatState,
  type ConnectionState,
  type SocketLike,
} from '@vff/client-core';
import type { ops } from '@vff/protocol';
import type { z } from 'zod';

type Hello = z.infer<typeof ops.SystemHelloRes>;

/**
 * Browsers cannot set headers on a WebSocket handshake, so the token rides in
 * `Sec-WebSocket-Protocol` — the one handshake header browsers do control.
 * The agent echoes it back. Node and React Native use a real Authorization
 * header instead and never take this path.
 */
const browserSocket = (url: string, token: string): SocketLike =>
  new WebSocket(url, [`vff.token.${token}`]) as unknown as SocketLike;

// Param names deliberately avoid `url`: Vite treats `?url` as an import
// suffix, and a request for `/?url=...` gets rejected by its fs allow-list.
const DEFAULTS = {
  url: new URLSearchParams(location.search).get('agent') ?? 'ws://127.0.0.1:8787',
  token: new URLSearchParams(location.search).get('tok') ?? '',
};

export function App() {
  const [url, setUrl] = useState(DEFAULTS.url);
  const [token, setToken] = useState(DEFAULTS.token);
  const [state, setState] = useState<ConnectionState>('disconnected');
  const [hello, setHello] = useState<Hello | null>(null);
  const [chat, setChat] = useState<ChatState>(initialChatState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<WsClient | null>(null);

  const connect = useCallback(() => {
    clientRef.current?.close();
    setError(null);

    const client = new WsClient({
      url,
      token,
      deviceId: 'devclient',
      createSocket: browserSocket,
    });
    client.onStateChange(setState);
    client.onHello(setHello);
    client.onEvent((e) => setChat((prev) => chatReducer(prev, e)));
    client.onError(({ phase, error }) => setError(`${phase}: ${error.message}`));
    client.connect();
    clientRef.current = client;
  }, [url, token]);

  useEffect(() => () => clientRef.current?.close(), []);

  const startSession = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const res = await client.request('claude/start', {});
      client.track(res.sessionId, 0);
      setSessionId(res.sessionId);
      setChat(initialChatState);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const send = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !sessionId || !draft.trim()) return;
    const text = draft.trim();
    setDraft('');
    setChat((prev) => appendUserMessage(prev, text, makeId()));
    try {
      await client.request('claude/send', { sessionId, text });
    } catch (e) {
      setError(String(e));
    }
  }, [draft, sessionId]);

  const respond = useCallback(
    async (requestId: string, allow: boolean) => {
      const client = clientRef.current;
      if (!client || !sessionId) return;
      try {
        await client.request('claude/permission-respond', {
          sessionId,
          requestId,
          decision: allow
            ? { allow: true, scope: 'once' }
            : { allow: false, message: 'Denied from dev client' },
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [sessionId],
  );

  const pending = Object.values(chat.pendingPermissions);

  return (
    <main style={S.page}>
      <header style={S.header}>
        <strong>vibe agent</strong>
        <span data-testid="conn-state" style={S.badge(stateColor(state))}>
          {state}
        </span>
        {hello && (
          <span data-testid="tier-badge" style={S.badge(hello.tier === 'trusted' ? '#2b7' : '#c62')}>
            {hello.tier}
          </span>
        )}
        {chat.rateLimit && (
          <span data-testid="rate-badge" style={S.badge('#666')}>
            {chat.rateLimit.summary}
          </span>
        )}
        {chat.thinking && <span data-testid="thinking">thinking…</span>}
      </header>

      {hello && !hello.claudeAuth.usable && (
        <div data-testid="auth-banner" style={S.banner}>
          <strong>Claude is not available on the dev box.</strong> {hello.claudeAuth.detail}
          {hello.claudeAuth.remedy && <div style={{ marginTop: 4 }}>{hello.claudeAuth.remedy}</div>}
        </div>
      )}
      {chat.authTrouble && (
        <div data-testid="auth-trouble" style={S.banner}>
          {chat.authTrouble.message} {chat.authTrouble.remedy}
        </div>
      )}

      <section style={S.row}>
        <input
          data-testid="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={S.input}
          placeholder="ws://127.0.0.1:8787"
        />
        <input
          data-testid="token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={S.input}
          placeholder="agent token"
        />
        <button data-testid="connect" onClick={connect}>
          Connect
        </button>
        <button data-testid="new-session" onClick={startSession} disabled={state !== 'live'}>
          New session
        </button>
      </section>

      {error && <div data-testid="error" style={S.error}>{error}</div>}

      {pending.map((p) => (
        <div key={p.requestId} data-testid="permission" style={S.permission(p.render.risk)}>
          <div>
            <strong>{p.render.title}</strong> <em>({p.render.risk} risk)</em>
          </div>
          <div style={S.subtitle}>{p.render.subtitle}</div>
          <pre style={S.pre}>{p.render.body.value}</pre>
          <button data-testid="allow" onClick={() => respond(p.requestId, true)}>
            Allow
          </button>{' '}
          <button data-testid="deny" onClick={() => respond(p.requestId, false)}>
            Deny
          </button>
        </div>
      ))}

      <section data-testid="transcript" style={S.transcript}>
        {chat.items.map((item) => {
          switch (item.kind) {
            case 'user':
              return (
                <div key={item.id} data-testid="msg-user" style={S.user}>
                  {item.text}
                </div>
              );
            case 'assistant':
              return (
                <div key={item.id} data-testid="msg-assistant" style={S.assistant}>
                  {item.text}
                  {item.streaming && <span style={{ opacity: 0.5 }}>▍</span>}
                </div>
              );
            case 'tool':
              return (
                <details key={item.id} data-testid="tool-card" style={S.tool}>
                  <summary>
                    {item.summary} {item.result ? (item.result.ok ? '✓' : '✗') : '…'}
                  </summary>
                  <pre style={S.pre}>{JSON.stringify(item.input, null, 2)}</pre>
                  {item.result && <pre style={S.pre}>{item.result.preview}</pre>}
                </details>
              );
            case 'truncation':
              return (
                <div key={item.id} data-testid="truncation" style={S.truncation}>
                  … {item.droppedEvents} earlier events were dropped from the log
                </div>
              );
            case 'error':
              return (
                <div key={item.id} data-testid="msg-error" style={S.error}>
                  {item.message}
                </div>
              );
          }
        })}
      </section>

      <section style={S.row}>
        <input
          data-testid="draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
          style={{ ...S.input, flex: 1 }}
          placeholder={sessionId ? 'Message Claude…' : 'Start a session first'}
          disabled={!sessionId}
        />
        <button data-testid="send" onClick={() => void send()} disabled={!sessionId}>
          Send
        </button>
      </section>

      {chat.usage && (
        <footer data-testid="usage" style={S.footer}>
          {chat.usage.inputTokens} in / {chat.usage.outputTokens} out
        </footer>
      )}
    </main>
  );
}

function stateColor(s: ConnectionState): string {
  if (s === 'live') return '#2b7';
  if (s === 'disconnected') return '#c33';
  return '#c92';
}

const S = {
  page: { fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto', padding: 16 },
  header: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 },
  badge: (bg: string) => ({
    background: bg,
    color: '#fff',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 12,
  }),
  row: { display: 'flex', gap: 8, marginBottom: 12 },
  input: { padding: 6, border: '1px solid #ccc', borderRadius: 4 },
  transcript: { minHeight: 240, border: '1px solid #eee', borderRadius: 6, padding: 12 },
  user: { background: '#eef', padding: 8, borderRadius: 6, margin: '6px 0' },
  assistant: { padding: 8, margin: '6px 0', whiteSpace: 'pre-wrap' as const },
  tool: { background: '#f7f7f7', padding: 8, borderRadius: 6, margin: '6px 0' },
  truncation: { color: '#888', fontStyle: 'italic' as const, margin: '6px 0' },
  permission: (risk: string) => ({
    border: `2px solid ${risk === 'high' ? '#c33' : '#c92'}`,
    borderRadius: 6,
    padding: 12,
    marginBottom: 12,
  }),
  subtitle: { color: '#666', fontSize: 13 },
  pre: { background: '#f4f4f4', padding: 8, overflowX: 'auto' as const, fontSize: 13 },
  banner: { background: '#fee', border: '1px solid #c33', padding: 10, borderRadius: 6, marginBottom: 12 },
  error: { color: '#c33', margin: '8px 0' },
  footer: { color: '#888', fontSize: 12, marginTop: 8 },
};

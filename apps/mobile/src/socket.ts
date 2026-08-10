import type { SocketFactory, SocketLike } from '@vff/client-core';

/**
 * React Native's WebSocket accepts a third `options` argument carrying real
 * request headers, so the device uses `Authorization: Bearer` — the same thing
 * the Node harness does.
 *
 * This is the one place the phone is better off than the browser client, which
 * has to smuggle its token through `Sec-WebSocket-Protocol` because browsers
 * cannot set handshake headers at all. Both paths are accepted by the agent;
 * the header is preferred because a subprotocol value is echoed back in the
 * response and shows up in proxy logs more readily than a header does.
 *
 * The cast is unavoidable: the ambient `WebSocket` type in React Native's
 * bundled libdefs is the two-argument DOM signature, while the runtime is
 * `WebSocket(url, protocols, options)`.
 */
type RNWebSocket = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => SocketLike;

export const rnSocket: SocketFactory = (url, token) =>
  new (WebSocket as unknown as RNWebSocket)(url, null, {
    headers: { Authorization: `Bearer ${token}` },
  });

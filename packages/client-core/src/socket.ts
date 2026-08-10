/**
 * The minimum WebSocket surface this client needs.
 *
 * Deliberately structural rather than importing a concrete implementation:
 * the browser and React Native supply a global `WebSocket`, Node tests inject
 * the `ws` package. One implementation of the client logic then runs
 * everywhere, instead of a browser copy and a Node copy drifting apart.
 */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export const SOCKET_OPEN = 1;

/**
 * Opens a socket to `url`.
 *
 * The auth token is passed differently per platform, which is the main reason
 * this is injectable: Node's `ws` accepts real headers, browsers cannot set
 * any on a WebSocket handshake. See the devclient for how the browser case is
 * handled.
 */
export type SocketFactory = (url: string, token: string) => SocketLike;

/** Small, dependency-free id generator. */
export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

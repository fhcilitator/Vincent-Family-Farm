import * as SecureStore from 'expo-secure-store';

/**
 * Where a paired agent lives.
 *
 * Both endpoints are recorded at pairing time. `trusted` is the tailnet URL
 * (`tailscale serve`, so it has a real ts.net certificate and needs no
 * cleartext exception); `public` is the tunnel. The app prefers trusted and
 * falls back, because the tier it lands on decides how much the agent will
 * let it do — see `preferredEndpoints`.
 */
export interface AgentConfig {
  name: string;
  trustedUrl: string | null;
  publicUrl: string | null;
  /**
   * Cloudflare Access service token id, when the tunnel sits behind Access.
   *
   * Access intercepts the request at Cloudflare's edge and answers an
   * unauthenticated one with a redirect to a login page. A browser follows
   * that and nothing looks wrong; this app cannot, so the WebSocket handshake
   * simply fails. A service token is the non-interactive way in.
   *
   * Null on a tunnel without Access, which is the common case.
   */
  accessClientId: string | null;
}

/** Config plus the secrets that go with it. */
export interface AgentCredentials {
  config: AgentConfig;
  token: string;
  /** Cloudflare Access service token secret; null unless Access is in use. */
  accessSecret: string | null;
}

const CONFIG_KEY = 'vff.agent.config';
const TOKEN_KEY = 'vff.agent.token';
const ACCESS_SECRET_KEY = 'vff.agent.accessSecret';

/**
 * The token is the only thing standing between the internet and command
 * execution on the dev box, so it goes in SecureStore (Android Keystore) and
 * never in AsyncStorage. The endpoints are not secret and ride along with it
 * only for convenience.
 */
export async function saveAgent(creds: AgentCredentials): Promise<void> {
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(creds.config));
  await SecureStore.setItemAsync(TOKEN_KEY, creds.token);
  // Cleared rather than left behind when Access is turned off, so a stale
  // secret cannot outlive the setup that needed it.
  if (creds.accessSecret) await SecureStore.setItemAsync(ACCESS_SECRET_KEY, creds.accessSecret);
  else await SecureStore.deleteItemAsync(ACCESS_SECRET_KEY);
}

export async function loadAgent(): Promise<AgentCredentials | null> {
  const [raw, token, accessSecret] = await Promise.all([
    SecureStore.getItemAsync(CONFIG_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
    SecureStore.getItemAsync(ACCESS_SECRET_KEY),
  ]);
  if (!raw || !token) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    return {
      // accessClientId is defaulted rather than assumed present: an install
      // that paired before Access support existed has no such field.
      config: { accessClientId: null, ...parsed } as AgentConfig,
      token,
      accessSecret: accessSecret ?? null,
    };
  } catch {
    // Corrupt entry: treat as unpaired rather than crashing on launch.
    return null;
  }
}

export async function forgetAgent(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(CONFIG_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(ACCESS_SECRET_KEY),
  ]);
}

/**
 * Trusted first, public second. Ordering matters beyond speed: the trusted
 * endpoint is the only one that can create session-scoped approvals, so
 * dialling it first is what makes "approve once at home" work at all.
 */
export function preferredEndpoints(config: AgentConfig): string[] {
  return [config.trustedUrl, config.publicUrl].filter((u): u is string => !!u);
}

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
}

const CONFIG_KEY = 'vff.agent.config';
const TOKEN_KEY = 'vff.agent.token';

/**
 * The token is the only thing standing between the internet and command
 * execution on the dev box, so it goes in SecureStore (Android Keystore) and
 * never in AsyncStorage. The endpoints are not secret and ride along with it
 * only for convenience.
 */
export async function saveAgent(config: AgentConfig, token: string): Promise<void> {
  await SecureStore.setItemAsync(CONFIG_KEY, JSON.stringify(config));
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

export async function loadAgent(): Promise<{ config: AgentConfig; token: string } | null> {
  const [raw, token] = await Promise.all([
    SecureStore.getItemAsync(CONFIG_KEY),
    SecureStore.getItemAsync(TOKEN_KEY),
  ]);
  if (!raw || !token) return null;
  try {
    return { config: JSON.parse(raw) as AgentConfig, token };
  } catch {
    // Corrupt entry: treat as unpaired rather than crashing on launch.
    return null;
  }
}

export async function forgetAgent(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(CONFIG_KEY),
    SecureStore.deleteItemAsync(TOKEN_KEY),
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

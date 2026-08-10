export const C = {
  bg: '#0f1115',
  surface: '#171a21',
  surfaceAlt: '#1e222b',
  border: '#2a2f3a',
  text: '#e6e8ee',
  dim: '#9aa1b1',
  accent: '#5b9dff',
  ok: '#2fbf71',
  warn: '#e0a03a',
  danger: '#e0524a',
} as const;

/**
 * Android's accessibility guidance is a 48dp minimum touch target, and this
 * app's most consequential control — approving a shell command — is one you
 * may be tapping one-handed on a phone. Nothing interactive goes below this.
 */
export const TAP_MIN = 48;

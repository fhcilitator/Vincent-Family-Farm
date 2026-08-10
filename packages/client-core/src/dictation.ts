/**
 * Post-processing for dictated prompts.
 *
 * Android's on-device recognizer is trained on ordinary speech, so it reliably
 * mangles the vocabulary this app is used for: `useEffect` comes back as "use
 * effect", `cd` as "see d", `npm` as "N P M". A find/replace pass over the
 * transcript recovers most of that gap for no latency and no server round
 * trip, which is a far better trade than sending audio somewhere to be
 * transcribed by a bigger model.
 *
 * It lives here, rather than in the app, for one reason: it is pure, it is
 * where the fiddly correctness lives, and this package is the one that gets
 * tested. Recognition accuracy itself can only be judged on a real device
 * against real speech — and that testing is also how this list should grow.
 */

export interface DictationRule {
  /** Spoken form, matched case-insensitively on word boundaries. */
  spoken: string;
  /** What to write instead. Case is preserved exactly as given. */
  written: string;
}

/**
 * Starting rules, not a finished list.
 *
 * Ordered longest-phrase-first at apply time, so "use effect" wins over a rule
 * for "use" alone regardless of the order written here.
 */
export const DEFAULT_DICTATION_RULES: DictationRule[] = [
  { spoken: 'use effect', written: 'useEffect' },
  { spoken: 'use state', written: 'useState' },
  { spoken: 'use callback', written: 'useCallback' },
  { spoken: 'use memo', written: 'useMemo' },
  { spoken: 'use ref', written: 'useRef' },
  { spoken: 'see d', written: 'cd' },
  { spoken: 'ell ess', written: 'ls' },
  { spoken: 'n p m', written: 'npm' },
  { spoken: 'p npm', written: 'pnpm' },
  { spoken: 'ts config', written: 'tsconfig' },
  { spoken: 'package json', written: 'package.json' },
  { spoken: 'read me', written: 'README' },
  { spoken: 'git hub', written: 'GitHub' },
  { spoken: 'type script', written: 'TypeScript' },
  { spoken: 'java script', written: 'JavaScript' },
  { spoken: 'node modules', written: 'node_modules' },
  { spoken: 'dot ts', written: '.ts' },
  { spoken: 'dot tsx', written: '.tsx' },
  { spoken: 'dot json', written: '.json' },
  { spoken: 'async await', written: 'async/await' },
  { spoken: 'pull request', written: 'PR' },
];

/**
 * Rewrite a transcript using `rules`.
 *
 * Matching is case-insensitive and anchored to word boundaries, so "see d into
 * source" becomes "cd into source" while "guaranteed" is left alone —
 * substring replacement would corrupt it. Longer phrases are applied first so
 * a multi-word rule is never pre-empted by one of its own words.
 */
export function applyDictation(
  transcript: string,
  rules: DictationRule[] = DEFAULT_DICTATION_RULES,
): string {
  const ordered = [...rules].sort((a, b) => b.spoken.length - a.spoken.length);

  let out = transcript;
  for (const rule of ordered) {
    const pattern = rule.spoken
      .trim()
      .split(/\s+/)
      .map(escapeRegExp)
      // Speech transcripts vary in spacing and can carry a comma between
      // words the recognizer thought were separate clauses.
      .join('[\\s,]+');
    if (!pattern) continue;
    out = out.replace(new RegExp(`\\b${pattern}\\b`, 'gi'), rule.written);
  }
  return out;
}

/**
 * Merge dictated text into whatever is already in the composer.
 *
 * Dictation appends rather than replaces: the common flow is to speak, notice
 * one wrong word, fix it by hand, then speak the rest. Replacing the field
 * would throw away the correction.
 */
export function appendDictation(existing: string, dictated: string): string {
  const clean = dictated.trim();
  if (!clean) return existing;
  if (!existing.trim()) return clean;
  return `${existing.replace(/\s+$/, '')} ${clean}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

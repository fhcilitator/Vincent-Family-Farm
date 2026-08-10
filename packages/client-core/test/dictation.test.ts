import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDictation,
  appendDictation,
  DEFAULT_DICTATION_RULES,
  type DictationRule,
} from '../src/dictation.js';

describe('dictation dictionary', () => {
  const cases: Array<[string, string]> = [
    ['add a use effect to the component', 'add a useEffect to the component'],
    ['see d into the source directory', 'cd into the source directory'],
    ['run n p m test', 'run npm test'],
    ['open ts config', 'open tsconfig'],
    ['check package json', 'check package.json'],
    ['update the read me', 'update the README'],
    ['rename it to dot tsx', 'rename it to .tsx'],
  ];

  for (const [spoken, expected] of cases) {
    test(`"${spoken}" -> "${expected}"`, () => {
      assert.equal(applyDictation(spoken), expected);
    });
  }

  test('matches on word boundaries, not substrings', () => {
    // "see d" inside "guaranteed" must not be rewritten, and neither must a
    // word that merely starts with a rule.
    assert.equal(applyDictation('guaranteed to work'), 'guaranteed to work');
    assert.equal(applyDictation('useful state machine'), 'useful state machine');
  });

  test('is case-insensitive but writes the canonical casing', () => {
    assert.equal(applyDictation('Use Effect and USE STATE'), 'useEffect and useState');
  });

  test('tolerates the comma a recognizer inserts mid-phrase', () => {
    assert.equal(applyDictation('add a use, effect here'), 'add a useEffect here');
  });

  test('applies the longest matching phrase first', () => {
    // With a short rule listed first, naive iteration would rewrite "use" and
    // leave "effect" stranded.
    const rules: DictationRule[] = [
      { spoken: 'use', written: 'USE' },
      { spoken: 'use effect', written: 'useEffect' },
    ];
    assert.equal(applyDictation('use effect', rules), 'useEffect');
  });

  test('leaves text with no matches untouched', () => {
    const text = 'refactor the billing module and add tests';
    assert.equal(applyDictation(text), text);
  });

  test('no default rule contains regex metacharacters that would misparse', () => {
    for (const rule of DEFAULT_DICTATION_RULES) {
      assert.doesNotThrow(() => applyDictation(`x ${rule.spoken} y`), `rule "${rule.spoken}" broke`);
      assert.match(applyDictation(`x ${rule.spoken} y`), /^x .* y$/);
    }
  });
});

describe('appending dictation to the composer', () => {
  test('appends rather than replacing, so a hand correction survives', () => {
    assert.equal(appendDictation('fix the useEffect', 'and add a test'), 'fix the useEffect and add a test');
  });

  test('fills an empty composer', () => {
    assert.equal(appendDictation('', 'hello'), 'hello');
    assert.equal(appendDictation('   ', 'hello'), 'hello');
  });

  test('an empty transcript changes nothing', () => {
    assert.equal(appendDictation('keep me', '   '), 'keep me');
  });

  test('does not double the separating space', () => {
    assert.equal(appendDictation('one ', 'two'), 'one two');
  });
});

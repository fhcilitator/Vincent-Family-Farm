import { test, describe } from 'node:test';
import { assertNoNodeGlobals } from '../../../tools/no-node-globals.js';

/**
 * client-core exists precisely so one tested implementation runs in Node
 * tests, the browser client, and the Expo app. A Node-only global silently
 * breaks two of those three, and neither `tsc` nor the Node-hosted tests here
 * can see it — see tools/no-node-globals.ts.
 */
describe('runs outside Node', () => {
  test('the source uses no Node-only globals', () => {
    assertNoNodeGlobals(new URL('../src/', import.meta.url));
  });
});

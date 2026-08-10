import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Globals that exist in Node but not in a browser or React Native.
 *
 * `process` is the near-miss: bundlers often shim `process.env.NODE_ENV`, so
 * it appears to work until it doesn't. Treat all of these as banned in
 * packages that ship to a client.
 */
const BANNED = ['Buffer', 'process', 'require', '__dirname', '__filename', 'global'];

const IDENT = (name: string) => new RegExp(String.raw`(?<![.\w$'"\`])${name}\b`);

/**
 * Fail if any source file under `dir` references a Node-only global.
 *
 * Packages shared with the browser and React Native cannot be protected from
 * this by `tsc` — `@types/node` is in scope for the whole workspace, so
 * `Buffer.byteLength` typechecks perfectly — nor by Node-hosted unit tests,
 * which run in the very environment that has it. The failure surfaces only in
 * a browser, at runtime. A source scan is the cheapest thing that actually
 * catches it.
 */
export function assertNoNodeGlobals(dir: URL | string): void {
  const root = typeof dir === 'string' ? dir : fileURLToPath(dir);

  for (const file of walk(root)) {
    // Strip line comments so prose naming a banned global (this file's own
    // docs included) doesn't trip the scan.
    const code = readFileSync(file, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    for (const name of BANNED) {
      assert.ok(
        !IDENT(name).test(code),
        `${file} references the Node-only global \`${name}\`; this package must run in a browser and React Native too`,
      );
    }
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

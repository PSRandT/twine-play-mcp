/** Dedicated smoke harness, not a modification of any user game or existing fixture.
 * Upstream smoke expects a third external choice and a visible Continue control at Start.
 * Derive a test-only input from the committed SugarCube engine without changing it. */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const original = readFileSync(new URL('../test/fixtures/compiled/sugarcube.html', import.meta.url), 'utf8');
const marker = '[[Look in the mirror-&gt;Mirror]]';
if (!original.includes(marker)) throw new Error('Smoke fixture marker changed');
const source = original
  .replace('[[Open the door-&gt;Hall]]', '[[Continue-&gt;Hall]]')
  .replace(marker, marker + '\n[[External-&gt;https://example.org/]]');
const folder = mkdtempSync(path.join(os.tmpdir(), 'twine-smoke-'));
const dest = path.join(folder, 'index.html');
writeFileSync(dest, source);
console.log(dest);

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('key asset approval stays enabled for a current reference image', async () => {
  const source = await readFile(new URL('../src/assets.tsx', import.meta.url), 'utf8');
  assert.match(source, /disabled=\{busy \|\| !selected\.reference \|\| !currentReference\(selected\) \|\| selected\.approved\}/);
  assert.doesNotMatch(source, /disabled=\{busy \|\| !!selected\.reference \|\| !currentReference\(selected\)/);
});

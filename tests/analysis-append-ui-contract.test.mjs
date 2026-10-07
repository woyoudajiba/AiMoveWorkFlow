import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('workbench exposes append-analysis controls without locking the analyzed manuscript', async () => {
  const source = await readFile(path.resolve('src/App.tsx'), 'utf8');
  assert.match(source, /analysisSourceLength/);
  assert.match(source, /analyze-append/);
  assert.match(source, /novel\.startsWith\(project\.novel\)/);
  assert.match(source, /分析新增内容/);
  assert.match(source, /重试当前分析块/);
  assert.match(source, /analysisRetryable/);
});

test('hidden Electron titlebar has a draggable topbar and interactive no-drag controls', async () => {
  const source = await readFile(path.resolve('src/styles.css'), 'utf8');
  assert.match(source, /\.topbar\{[^}]*-webkit-app-region:drag/);
  assert.match(source, /\.topbar button,\.topbar a,\.topbar input,\.topbar select,\.topbar-right\{[^}]*-webkit-app-region:no-drag/);
});

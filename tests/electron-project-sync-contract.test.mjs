import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('project sync IPC passes the resolved client target URL to local storage', async () => {
  const source = await readFile(path.resolve('electron/main.cjs'), 'utf8');
  assert.match(source, /localProjectStorage\.sync\(\{\.\.\.payload,root:folder\.path,targetBaseUrl:targetUrl\}\)/);
  assert.doesNotMatch(source, /localProjectStorage\.sync\(\{\.\.\.payload,root:folder\.path,targetBaseUrl\}\)/);
});

test('packaged Windows window keeps the native titlebar in the workbench dark palette', async () => {
  const source = await readFile(path.resolve('electron/main.cjs'), 'utf8');
  assert.match(source, /titleBarStyle:process\.platform==='win32'\?'hidden':'default'/);
  assert.match(source, /color:'#171b18',symbolColor:'#bcedce',height:36/);
  assert.match(source, /win\.setTitleBarOverlay\(titleBarOverlay\)/);
});

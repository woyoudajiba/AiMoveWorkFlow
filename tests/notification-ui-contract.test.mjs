import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('task state changes drive system notifications and distinct sound categories', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const effects = await readFile(new URL('../src/task-notification-effects.ts', import.meta.url), 'utf8');
  const preload = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
  const main = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  assert.match(app, /collectTaskNotifications/);
  assert.match(app, /sendTaskNotification/);
  assert.match(effects, /failure:/);
  assert.match(effects, /stuck:/);
  assert.match(effects, /completed:/);
  assert.match(preload, /notification:show/);
  assert.match(main, /ipcMain\.handle\('notification:show'/);
});

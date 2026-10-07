import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFileAuthStore} from '../server/auth-store.mjs';

test('file auth store atomically persists private session data and clears it', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiframe-auth-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'nested', 'auth-session.json');
  const store = createFileAuthStore(file);
  assert.equal(await store.load(), null);
  const value = { token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z', user: { id: 'account-a' } };
  await store.save(value);
  assert.deepEqual(await store.load(), value);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file, 'utf8')).includes('fixture-token'), true);
  await store.save(null);
  assert.equal(await store.load(), null);
});

test('file auth store refuses relative paths', () => {
  assert.throws(() => createFileAuthStore('auth-session.json'), /absolute path/);
});

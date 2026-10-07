import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REMOTE_URL, resolveClientTarget } from '../electron/runtime-config.cjs';
import { hasDesktopUpdateBridge } from '../src/desktop-update.ts';

test('packaged client defaults to the shared cloud workbench', () => {
  assert.deepEqual(resolveClientTarget({ isPackaged: true, env: {} }), { mode: 'remote', url: DEFAULT_REMOTE_URL });
});

test('development and smoke modes stay local and never call the cloud', () => {
  assert.deepEqual(resolveClientTarget({ isPackaged: false, env: {} }), { mode: 'local', url: '' });
  assert.deepEqual(resolveClientTarget({ isPackaged: true, smokeDirectory: 'C:/tmp/smoke', env: {} }), { mode: 'local', url: '' });
  assert.deepEqual(resolveClientTarget({ isPackaged: true, env: { AIFRAME_LOCAL_MODE: '1' } }), { mode: 'local', url: '' });
});

test('remote target can be overridden only with an HTTPS URL', () => {
  assert.equal(resolveClientTarget({ isPackaged: true, env: { AIFRAME_REMOTE_URL: 'https://example.test/workf' } }).url, 'https://example.test/workf/');
  assert.throws(() => resolveClientTarget({ isPackaged: true, env: { AIFRAME_REMOTE_URL: 'http://example.test' } }), /HTTPS/);
});

test('desktop update surface detects a missing or incomplete preload bridge', () => {
  assert.equal(hasDesktopUpdateBridge(undefined), false);
  assert.equal(hasDesktopUpdateBridge({ checkForUpdate() {} }), false);
  assert.equal(hasDesktopUpdateBridge({ checkForUpdate() {}, installUpdate() {} }), true);
});

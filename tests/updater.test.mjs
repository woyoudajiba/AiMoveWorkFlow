import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createUpdater, compareVersions, UPDATE_MANIFEST_URL } from '../electron/updater.cjs';

const payload = Buffer.from('test installer payload');
const sha256 = createHash('sha256').update(payload).digest('hex');
const manifest = { version: '0.2.3', displayVersion: '0.2.3', url: 'https://wsfile.cn/workf/downloads/YingXu-0.2.3-win-x64-setup.exe', sha256, releaseNotes: '更新测试' };

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return value; } };
}

function binaryResponse(value) {
  return { ok: true, status: 200, headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(value.length) : null; } }, async arrayBuffer() { return value; } };
}

test('compareVersions orders stable semantic versions', () => {
  assert.equal(compareVersions('0.2.3', '0.2.2') > 0, true);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.2.2', '0.2.3') < 0, true);
  assert.equal(compareVersions('10.6.0-v1', '0.2.3') > 0, true);
});

test('compareVersions orders numbered daily release suffixes numerically', () => {
  assert.equal(compareVersions('2026.10.6-v10', '2026.10.6-v9') > 0, true);
  assert.equal(compareVersions('2026.10.6-v9', '2026.10.6-v10') < 0, true);
});

test('check rejects an untrusted manifest URL and exposes a newer version', async () => {
  const updater = createUpdater({ currentVersion: '0.2.2', fetchImpl: async url => {
    assert.equal(url, UPDATE_MANIFEST_URL);
    return response(manifest);
  } });
  const result = await updater.checkForUpdate();
  assert.equal(result.available, true);
  assert.equal(result.version, '0.2.3');
  assert.equal(result.displayVersion, '0.2.3');
  await assert.rejects(createUpdater({ currentVersion: '0.2.2', fetchImpl: async () => response({ ...manifest, url: 'https://evil.example/update.exe' }) }).checkForUpdate(), /下载地址/);
});

test('check accepts the daily date display version used by client releases', async () => {
  const dailyManifest = { ...manifest, version: '2026.10.6-v7', displayVersion: '2026-10-06-v7', url: 'https://wsfile.cn/workf/downloads/YingXu-2026-10-06-v7-win-x64-setup.exe' };
  const updater = createUpdater({ currentVersion: '2026.10.6-v6', fetchImpl: async () => response(dailyManifest) });
  const result = await updater.checkForUpdate();
  assert.equal(result.available, true);
  assert.equal(result.displayVersion, '2026-10-06-v7');
});

test('download verifies sha256 before starting installer', async () => {
  const started = [];
  const updater = createUpdater({
    currentVersion: '0.2.2',
    fetchImpl: async url => url === UPDATE_MANIFEST_URL ? response(manifest) : binaryResponse(payload),
    tempRoot: process.env.TEMP,
    spawnImpl: (file, args, options) => { started.push({ file, args, options }); return { unref() {} }; },
  });
  const info = await updater.checkForUpdate();
  const result = await updater.installUpdate(info);
  assert.equal(result.started, true);
  assert.equal(started.length, 1);
  assert.match(started[0].file, /YingXu-0\.2\.3-win-x64-setup\.exe$/);
});

test('download refuses a hash mismatch without starting installer', async () => {
  let started = false;
  const updater = createUpdater({
    currentVersion: '0.2.2',
    fetchImpl: async url => url === UPDATE_MANIFEST_URL ? response({ ...manifest, sha256: '0'.repeat(64) }) : binaryResponse(payload),
    spawnImpl: () => { started = true; return { unref() {} }; },
  });
  const info = await updater.checkForUpdate();
  await assert.rejects(updater.installUpdate(info), /校验/);
  assert.equal(started, false);
});

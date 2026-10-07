const { createHash } = require('node:crypto');
const { mkdtemp, open, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const UPDATE_MANIFEST_URL = 'https://wsfile.cn/workf/downloads/latest.json';
const UPDATE_HOST = 'wsfile.cn';
const UPDATE_PATH_PREFIX = '/workf/downloads/';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_INSTALLER_BYTES = 700 * 1024 * 1024;

function updateError(message, code = 'UPDATE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function versionParts(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) throw updateError('更新清单版本号无效');
  const [stable, pre = ''] = value.split('-', 2);
  return { stable: stable.split('.').map(Number), pre: pre ? pre.split('.') : [] };
}

function displayVersion(value, fallback) {
  if (value === undefined) return fallback;
  const validVersion = /^(?:\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?|\d{4}-\d{2}-\d{2}-v\d+)$/.test(value);
  if (typeof value !== 'string' || !validVersion || value.length > 80) throw updateError('更新清单显示版本号无效');
  return value;
}

function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 3; index += 1) if (a.stable[index] !== b.stable[index]) return a.stable[index] > b.stable[index] ? 1 : -1;
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    if (index >= a.pre.length) return -1;
    if (index >= b.pre.length) return 1;
    const av = a.pre[index], bv = b.pre[index];
    if (av === bv) continue;
    const avRelease = /^v(\d+)$/.exec(av);
    const bvRelease = /^v(\d+)$/.exec(bv);
    if (avRelease && bvRelease) {
      const leftRelease = Number(avRelease[1]);
      const rightRelease = Number(bvRelease[1]);
      if (leftRelease !== rightRelease) return leftRelease > rightRelease ? 1 : -1;
      continue;
    }
    const an = /^\d+$/.test(av), bn = /^\d+$/.test(bv);
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

function validateUpdateUrl(value) {
  if (typeof value !== 'string' || value.length > 500) throw updateError('更新下载地址无效');
  let parsed;
  try { parsed = new URL(value); } catch { throw updateError('更新下载地址无效'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== UPDATE_HOST || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith(UPDATE_PATH_PREFIX) || parsed.pathname.includes('..') || !parsed.pathname.endsWith('.exe') || parsed.pathname.slice(UPDATE_PATH_PREFIX.length).includes('/')) throw updateError('更新下载地址不受信任');
  return parsed.href;
}

function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw updateError('更新清单格式无效');
  const version = versionParts(raw.version) && raw.version;
  const url = validateUpdateUrl(raw.url);
  if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.sha256)) throw updateError('更新清单校验值无效');
  if (raw.releaseNotes !== undefined && (typeof raw.releaseNotes !== 'string' || raw.releaseNotes.length > 2000)) throw updateError('更新说明无效');
  return { version, displayVersion: displayVersion(raw.displayVersion, version), url, sha256: raw.sha256.toLowerCase(), releaseNotes: raw.releaseNotes || '' };
}

async function readBinary(response, file, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > maxBytes) throw updateError('更新安装包过大');
  const handle = await open(file, 'wx');
  const hash = createHash('sha256');
  let total = 0;
  try {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        total += chunk.length;
        if (total > maxBytes) throw updateError('更新安装包过大');
        hash.update(chunk);
        await handle.write(chunk);
      }
    } else {
      const chunk = Buffer.from(await response.arrayBuffer());
      if (chunk.length > maxBytes) throw updateError('更新安装包过大');
      total = chunk.length;
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } finally { await handle.close(); }
  return { total, sha256: hash.digest('hex') };
}

function createUpdater({ currentVersion, fetchImpl = globalThis.fetch, tempRoot = os.tmpdir(), spawnImpl = spawn } = {}) {
  versionParts(currentVersion);
  if (typeof fetchImpl !== 'function') throw updateError('更新服务不可用', 'UPDATE_UNAVAILABLE');
  async function checkForUpdate() {
    let response;
    try { response = await fetchImpl(UPDATE_MANIFEST_URL, { method: 'GET', cache: 'no-store', redirect: 'error' }); } catch { throw updateError('暂时无法检查更新，请稍后重试', 'UPDATE_NETWORK'); }
    if (!response?.ok) throw updateError('更新服务暂时不可用', 'UPDATE_NETWORK');
    let manifest;
    try {
      const declared = Number(response.headers?.get?.('content-length') || 0);
      if (declared > MAX_MANIFEST_BYTES) throw updateError('更新清单过大');
      manifest = validateManifest(await response.json());
    } catch (error) { if (error?.code === 'UPDATE_INVALID') throw error; throw updateError('更新清单无法读取'); }
    const available = compareVersions(manifest.version, currentVersion) > 0;
    return { available, currentVersion, version: manifest.version, displayVersion: manifest.displayVersion, url: manifest.url, sha256: manifest.sha256, releaseNotes: manifest.releaseNotes };
  }
  async function installUpdate(info) {
    if (!info || info.available !== true) throw updateError('当前没有可安装的更新', 'UPDATE_NOT_AVAILABLE');
    const manifest = validateManifest(info);
    if (compareVersions(manifest.version, currentVersion) <= 0) throw updateError('更新版本不高于当前客户端', 'UPDATE_NOT_AVAILABLE');
    let response;
    try { response = await fetchImpl(manifest.url, { method: 'GET', cache: 'no-store', redirect: 'error' }); } catch { throw updateError('更新下载失败，请稍后重试', 'UPDATE_NETWORK'); }
    if (!response?.ok) throw updateError('更新下载失败，请稍后重试', 'UPDATE_NETWORK');
    const directory = await mkdtemp(path.join(tempRoot, 'aiframe-update-'));
    const installer = path.join(directory, `YingXu-${manifest.displayVersion}-win-x64-setup.exe`);
    try {
      const digest = await readBinary(response, installer, MAX_INSTALLER_BYTES);
      if (digest.sha256 !== manifest.sha256) throw updateError('更新安装包校验失败', 'UPDATE_CHECKSUM');
      const child = spawnImpl(installer, [], { detached: true, stdio: 'ignore', windowsHide: false });
      if (!child || typeof child.unref !== 'function') throw updateError('无法启动更新安装程序', 'UPDATE_INSTALL');
      child.unref();
      return { started: true, version: manifest.version, displayVersion: manifest.displayVersion };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error?.code ? error : updateError('更新安装失败', 'UPDATE_INSTALL');
    }
  }
  return { checkForUpdate, installUpdate };
}

exports.UPDATE_MANIFEST_URL = UPDATE_MANIFEST_URL;
exports.compareVersions = compareVersions;
exports.createUpdater = createUpdater;

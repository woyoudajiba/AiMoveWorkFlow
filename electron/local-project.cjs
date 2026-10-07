const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');

const FIXED_DIRECTORIES = Object.freeze(['Actor_image', 'Story_image', 'Movie', 'Analysis']);
const ACCOUNT_PATTERN = /^[a-f0-9]{64}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_ASSETS = 1200;
const MAX_ASSET_BYTES = 700 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.json', '.csv', '.txt']);

function safeError(message, code = 'LOCAL_PROJECT_INVALID') { const error = new Error(message); error.code = code; return error; }
function assertAccountKey(value) { if (typeof value !== 'string' || !ACCOUNT_PATTERN.test(value)) throw safeError('账号工作区标识无效。'); return value; }
function assertProjectId(value) { if (typeof value !== 'string' || !PROJECT_PATTERN.test(value)) throw safeError('项目标识无效。'); return value; }
function samePath(left, right) { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function assertAbsoluteDirectory(value) { if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 2000) throw safeError('本地项目文件夹必须是绝对路径。'); return path.resolve(value); }
function assertRelativeFile(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 260 || value.includes('\0')) throw safeError('本地文件名无效。');
  const pieces = value.split(/[\\/]/);
  if (!FIXED_DIRECTORIES.includes(pieces[0]) || pieces.length < 2 || pieces.some(piece => !piece || piece === '.' || piece === '..' || piece.includes(':'))) throw safeError('本地文件必须位于固定项目目录内。');
  const basename = pieces.at(-1);
  if (basename.startsWith('.') || !ALLOWED_EXTENSIONS.has(path.extname(basename).toLowerCase())) throw safeError('本地文件扩展名不受支持。');
  return pieces.join(path.sep);
}
async function ensureRealDirectory(directory, create = true) {
  const target = assertAbsoluteDirectory(directory);
  if (create) await fs.mkdir(target, { recursive: true });
  const info = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') throw safeError('本地项目文件夹不存在。', 'LOCAL_PROJECT_MISSING'); throw error; });
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(target), target)) throw safeError('本地项目文件夹不能使用符号链接。', 'LOCAL_PROJECT_UNSAFE_PATH');
  return target;
}
async function ensureFixedDirectories(root) {
  const target = await ensureRealDirectory(root);
  const directories = {};
  for (const name of FIXED_DIRECTORIES) {
    const directory = path.join(target, name);
    await fs.mkdir(directory, { recursive: true });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) throw safeError(`本地目录 ${name} 不安全。`, 'LOCAL_PROJECT_UNSAFE_PATH');
    directories[name] = directory;
  }
  return { root: target, directories };
}
async function writeAtomic(file, content) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const existing = await fs.lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) throw safeError('本地文件不能使用符号链接。', 'LOCAL_PROJECT_UNSAFE_PATH');
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, content, { flag: 'wx' }); await fs.rename(temp, file); }
  catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
}
function resolveRemoteUrl(value, targetBaseUrl) {
  if (typeof value !== 'string' || value.length > 2000) throw safeError('远程媒体地址无效。');
  let base, url;
  try { base = new URL(targetBaseUrl); url = new URL(value, base); } catch { throw safeError('远程媒体地址无效。'); }
  if (!['http:', 'https:'].includes(base.protocol) || url.origin !== base.origin || (base.protocol === 'https:' && url.protocol !== 'https:')) throw safeError('远程媒体地址不受信任。');
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  // API project records use canonical /media URLs. Packaged clients point at
  // the mounted /workf/ application path, so resolve that canonical path
  // under the same origin before enforcing the workbench boundary.
  if (basePath !== '/' && url.pathname.startsWith('/media/')) {
    const search = url.search;
    const hash = url.hash;
    url = new URL(`${basePath}media/${url.pathname.slice('/media/'.length)}`, base);
    url.search = search;
    url.hash = hash;
  }
  if (!url.pathname.startsWith(basePath) && !(basePath === '/' && url.pathname.startsWith('/media/'))) throw safeError('远程媒体地址不属于当前工作台。');
  return url;
}
function assertSessionId(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw safeError('客户端会话已失效，请重新登录。', 'SESSION_INVALID'); return value; }

async function downloadOne({ file, url, targetBaseUrl, sessionId, fetchImpl }) {
  const response = await fetchImpl(resolveRemoteUrl(url, targetBaseUrl), { method: 'GET', cache: 'no-store', redirect: 'error', headers: { 'X-Local-Client': 'aiframe', 'X-Studio-Session': sessionId } });
  if (!response?.ok) {
    if (response?.status === 401 || response?.status === 409) throw safeError('客户端登录状态已失效，请重新登录后再同步。', 'SESSION_EXPIRED');
    throw safeError(`下载文件失败（${response?.status || 0}）。`, 'LOCAL_DOWNLOAD_FAILED');
  }
  const declared = Number(response.headers?.get?.('content-length') || 0);
  if (declared > MAX_ASSET_BYTES) throw safeError('下载文件超过本地保存上限。', 'LOCAL_ASSET_TOO_LARGE');
  const temp = `${file}.${randomUUID()}.part`;
  const handle = await fs.open(temp, 'wx');
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
        if (total > MAX_ASSET_BYTES) throw safeError('下载文件超过本地保存上限。', 'LOCAL_ASSET_TOO_LARGE');
        hash.update(chunk); await handle.write(chunk);
      }
    } else {
      const chunk = Buffer.from(await response.arrayBuffer());
      if (chunk.length > MAX_ASSET_BYTES) throw safeError('下载文件超过本地保存上限。', 'LOCAL_ASSET_TOO_LARGE');
      total = chunk.length; hash.update(chunk); await handle.write(chunk);
    }
    await handle.sync(); await handle.close();
    const existing = await fs.lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw safeError('本地目标文件不安全。', 'LOCAL_PROJECT_UNSAFE_PATH');
    await fs.rename(temp, file);
    return { bytes: total, sha256: hash.digest('hex') };
  } catch (error) { await handle.close().catch(() => {}); await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
}

function descriptor(root, meta = {}) { return { path: root, directories: Object.fromEntries(FIXED_DIRECTORIES.map(name => [name, path.join(root, name)])), ...meta }; }
function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw safeError('本地同步请求无效。');
  const accountKey = assertAccountKey(input.accountKey); const projectId = assertProjectId(input.projectId); const root = assertAbsoluteDirectory(input.root); const sessionId = assertSessionId(input.sessionId);
  if (!Array.isArray(input.assets) || input.assets.length > MAX_ASSETS) throw safeError('本地同步文件数量超出上限。');
  const assets = input.assets.map(asset => {
    if (!asset || typeof asset !== 'object' || typeof asset.url !== 'string') throw safeError('本地同步文件清单无效。');
    return { url: asset.url, relativePath: assertRelativeFile(asset.relativePath), kind: ['image', 'video', 'metadata'].includes(asset.kind) ? asset.kind : 'metadata' };
  });
  if (!input.snapshot || typeof input.snapshot !== 'object' || Array.isArray(input.snapshot)) throw safeError('本地项目快照无效。');
  return { accountKey, projectId, root, sessionId, assets, snapshot: input.snapshot, targetBaseUrl: input.targetBaseUrl };
}

function createProjectFolderStore(file) {
  let state = null;
  async function load() {
    if (state) return state;
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value?.version !== 1 || !value.folders || typeof value.folders !== 'object' || Array.isArray(value.folders)) throw safeError('本地项目目录配置结构无效。', 'LOCAL_PROJECT_STORE_INVALID');
      state = value;
    }
    catch (error) {
      if (error.code === 'ENOENT') state = { version: 1, folders: {} };
      else if (error.code === 'LOCAL_PROJECT_STORE_INVALID') throw error;
      else throw safeError('本地项目目录配置损坏，未覆盖原配置文件。', 'LOCAL_PROJECT_STORE_INVALID');
    }
    return state;
  }
  async function save() { await fs.mkdir(path.dirname(file), { recursive: true }); await writeAtomic(file, JSON.stringify(state, null, 2)); }
  async function get(accountKey, projectId) { assertAccountKey(accountKey); assertProjectId(projectId); const current = await load(); const item = current.folders[accountKey]?.[projectId]; return item?.path ? descriptor(item.path, item) : null; }
  async function set(accountKey, projectId, root) { assertAccountKey(accountKey); assertProjectId(projectId); const target = await ensureRealDirectory(root); const current = await load(); current.folders[accountKey] ||= {}; current.folders[accountKey][projectId] = { ...(current.folders[accountKey][projectId] || {}), path: target }; await save(); return descriptor(target, current.folders[accountKey][projectId]); }
  async function update(accountKey, projectId, patch) { assertAccountKey(accountKey); assertProjectId(projectId); const current = await load(); if (!current.folders[accountKey]?.[projectId]) throw safeError('尚未选择本地项目文件夹。', 'LOCAL_PROJECT_FOLDER_REQUIRED'); Object.assign(current.folders[accountKey][projectId], patch); await save(); return descriptor(current.folders[accountKey][projectId].path, current.folders[accountKey][projectId]); }
  return { get, set, update };
}

function createLocalProjectStorage({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw safeError('本地下载服务不可用。');
  async function prepare(root) { return ensureFixedDirectories(root); }
  async function sync(input) {
    const request = validateRequest(input); const prepared = await prepare(request.root); const files = []; let totalBytes = 0;
    for (const asset of request.assets) {
      const file = path.join(prepared.root, asset.relativePath);
      const result = await downloadOne({ file, url: asset.url, targetBaseUrl: request.targetBaseUrl, sessionId: request.sessionId, fetchImpl });
      files.push({ relativePath: asset.relativePath, kind: asset.kind, bytes: result.bytes, sha256: result.sha256 }); totalBytes += result.bytes;
    }
    await writeAtomic(path.join(prepared.directories.Analysis, 'project.json'), `${JSON.stringify(request.snapshot, null, 2)}\n`);
    await writeAtomic(path.join(prepared.directories.Analysis, '原始内容.txt'), `${typeof request.snapshot.novel === 'string' ? request.snapshot.novel : ''}`);
    await writeAtomic(path.join(prepared.directories.Analysis, '同步清单.json'), `${JSON.stringify({ version: 1, projectId: request.projectId, projectTitle: request.snapshot.title || '', syncedAt: new Date().toISOString(), files }, null, 2)}\n`);
    return { ...descriptor(prepared.root), files, totalBytes, syncedAt: new Date().toISOString() };
  }
  async function markCleaned(root, projectId, videoCount, snapshot) {
    const prepared = await prepare(root);
    assertProjectId(projectId);
    if (snapshot !== undefined && (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))) throw safeError('本地清理快照无效。');
    if (snapshot !== undefined) await writeAtomic(path.join(prepared.directories.Analysis, 'project.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    const statusFile = path.join(prepared.directories.Analysis, '同步清理状态.json');
    const status = { version: 1, projectId, remoteVideosDeleted: true, videoCount, cleanedAt: new Date().toISOString() };
    await writeAtomic(statusFile, `${JSON.stringify(status, null, 2)}\n`);
    return status;
  }
  return { prepare, sync, markCleaned };
}

module.exports = { FIXED_DIRECTORIES, createProjectFolderStore, createLocalProjectStorage, ensureFixedDirectories, assertRelativeFile, resolveRemoteUrl };

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createLocalProjectStorage, createProjectFolderStore, assertRelativeFile } from '../electron/local-project.cjs';

const accountKey = 'a'.repeat(64);

function response(value, status = 200) {
  const bytes = Buffer.from(value);
  return { ok: status >= 200 && status < 300, status, headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(bytes.length) : null; } }, async arrayBuffer() { return bytes; } };
}

test('local storage creates fixed directories, writes files atomically and keeps a project snapshot', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-local-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createLocalProjectStorage({ fetchImpl: async () => response('video') });
  const result = await storage.sync({ accountKey, projectId: 'project-1', root, sessionId: 'b'.repeat(64), targetBaseUrl: 'https://wsfile.cn/workf/', snapshot: { id: 'project-1', title: '借我灵根', novel: '原文' }, assets: [{ url: '/workf/media/project-1/a.mp4?account=abc', relativePath: 'Movie/segment-001.mp4', kind: 'video' }] });
  assert.equal(result.files.length, 1);
  assert.equal(await readFile(path.join(root, 'Movie', 'segment-001.mp4'), 'utf8'), 'video');
  assert.match(await readFile(path.join(root, 'Analysis', 'project.json'), 'utf8'), /借我灵根/);
  assert.equal(await readFile(path.join(root, 'Analysis', '原始内容.txt'), 'utf8'), '原文');
});

test('local cleanup refreshes the project snapshot while retaining the sync manifest', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-local-project-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createLocalProjectStorage({ fetchImpl: async () => response('video') });
  await storage.sync({ accountKey, projectId: 'project-1', root, sessionId: 'b'.repeat(64), targetBaseUrl: 'https://wsfile.cn/workf/', snapshot: { id: 'project-1', title: '借我灵根', novel: '原文', segments: [{ video: '/media/project-1/old.mp4' }] }, assets: [{ url: '/workf/media/project-1/a.mp4', relativePath: 'Movie/segment-001.mp4', kind: 'video' }] });
  await storage.markCleaned(root, 'project-1', 1, { id: 'project-1', title: '借我灵根', novel: '原文', segments: [{ video: null, remoteVideoDeleted: true }] });
  const snapshot = JSON.parse(await readFile(path.join(root, 'Analysis', 'project.json'), 'utf8'));
  assert.equal(snapshot.segments[0].video, null);
  assert.equal(snapshot.segments[0].remoteVideoDeleted, true);
  assert.match(await readFile(path.join(root, 'Analysis', '同步清单.json'), 'utf8'), /segment-001\.mp4/);
  assert.match(await readFile(path.join(root, 'Analysis', '同步清理状态.json'), 'utf8'), /"videoCount": 1/);
});

test('local storage rejects traversal and symlink destinations', async t => {
  assert.throws(() => assertRelativeFile('Movie/../outside.mp4'), /固定项目目录/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-local-project-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'aiframe-local-project-outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await symlink(outside, path.join(root, 'Movie'), 'junction');
  const storage = createLocalProjectStorage({ fetchImpl: async () => response('x') });
  await assert.rejects(storage.prepare(root), /符号链接|不安全/);
});

test('folder mapping is account and project scoped', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-folder-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createProjectFolderStore(path.join(root, 'folders.json'));
  const folder = await mkdtemp(path.join(os.tmpdir(), 'aiframe-folder-target-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await store.set(accountKey, 'project-1', folder);
  assert.equal((await store.get(accountKey, 'project-1')).path, folder);
  assert.equal(await store.get('b'.repeat(64), 'project-1'), null);
});

test('folder mapping does not silently erase a corrupt configuration file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-folder-store-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'folders.json');
  await writeFile(file, '{not-json', 'utf8');
  const store = createProjectFolderStore(file);
  await assert.rejects(store.get(accountKey, 'project-1'), error => error.code === 'LOCAL_PROJECT_STORE_INVALID');
  assert.equal(await readFile(file, 'utf8'), '{not-json');
});

test('folder mapping rejects a valid JSON file with an invalid schema', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-folder-store-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'folders.json');
  await writeFile(file, JSON.stringify({ version: 1, folders: [] }), 'utf8');
  const store = createProjectFolderStore(file);
  await assert.rejects(store.get(accountKey, 'project-1'), error => error.code === 'LOCAL_PROJECT_STORE_INVALID');
  assert.match(await readFile(file, 'utf8'), /"folders":\[\]/);
});

test('local storage accepts canonical /media URLs under the remote workf base path', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-local-project-media-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createLocalProjectStorage({ fetchImpl: async url => {
    assert.equal(url.href, 'https://wsfile.cn/workf/media/project-1/board.png');
    return response('image');
  } });
  await storage.sync({ accountKey, projectId: 'project-1', root, sessionId: 'b'.repeat(64), targetBaseUrl: 'https://wsfile.cn/workf/', snapshot: { id: 'project-1', title: '借我灵根' }, assets: [{ url: '/media/project-1/board.png', relativePath: 'Story_image/segment-001-storyboard.png', kind: 'image' }] });
  assert.equal(await readFile(path.join(root, 'Story_image', 'segment-001-storyboard.png'), 'utf8'), 'image');
});

test('local storage sends the current session to remote media downloads', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-local-project-session-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = 'c'.repeat(64);
  const storage = createLocalProjectStorage({ fetchImpl: async (_url, options) => {
    assert.equal(options.headers['X-Local-Client'], 'aiframe');
    assert.equal(options.headers['X-Studio-Session'], sessionId);
    return response('image');
  } });
  await storage.sync({ accountKey, projectId: 'project-1', root, sessionId, targetBaseUrl: 'https://wsfile.cn/workf/', snapshot: { id: 'project-1', title: '测试' }, assets: [{ url: '/media/project-1/board.png', relativePath: 'Story_image/segment-001-storyboard.png', kind: 'image' }] });
});

test('local storage reports an expired session instead of a generic download failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiframe-local-project-expired-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createLocalProjectStorage({ fetchImpl: async () => response('', 401) });
  await assert.rejects(
    storage.sync({ accountKey, projectId: 'project-1', root, sessionId: 'c'.repeat(64), targetBaseUrl: 'https://wsfile.cn/workf/', snapshot: { id: 'project-1', title: '测试' }, assets: [{ url: '/media/project-1/board.png', relativePath: 'Story_image/segment-001-storyboard.png', kind: 'image' }] }),
    error => error.code === 'SESSION_EXPIRED' && /重新登录/.test(error.message),
  );
});

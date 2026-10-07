import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { api, ApiError, isMissingProjectError, setApiSession, subscribeAuthFailure } from '../src/api.ts';
import { scopedAccountStorage } from '../src/accountStorage.ts';
import { readDrafts, writeDrafts } from '../src/drafts.ts';
import { clearWorkspaceRecovery, readWorkspaceRecovery, writeWorkspaceRecovery, workspaceRecoveryKey } from '../src/workspaceRecovery.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.window; setApiSession(null); });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values }; };

test('API uses only the current in-memory local session with same-origin cookies', async () => {
  let request;
  globalThis.fetch = async (path, options) => { request = { path, ...options }; return json({ ok: true }); };
  setApiSession('local-session-a');
  assert.deepEqual(await api('/api/config', 'POST', { llmModel: 'test-model' }), { ok: true });
  assert.equal(request.headers['X-Local-Client'], 'aiframe');
  assert.equal(request.headers['X-Studio-Session'], 'local-session-a');
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.credentials, 'same-origin');
  assert.equal(request.redirect, 'error');
  assert.equal(request.cache, 'no-store');
});

test('API keeps the deployed application subpath for browser requests', async () => {
  let requestPath = '';
  globalThis.window = { location: { pathname: '/workf/' } };
  globalThis.fetch = async (path) => { requestPath = String(path); return json({ ok: true }); };
  await api('/api/auth/status');
  assert.equal(requestPath, '/workf/api/auth/status');
});

test('a late success from a logged-out account cannot enter a new account', async () => {
  const response = deferred();
  globalThis.fetch = () => response.promise;
  setApiSession('local-session-a');
  const oldRequest = api('/api/state');
  setApiSession(null); setApiSession('local-session-b');
  response.resolve(json({ projects: [{ id: 'private-a' }] }));
  await assert.rejects(oldRequest, error => error.name === 'AbortError');
});

test('session is checked again after a delayed response body completes', async () => {
  const body = deferred();
  globalThis.fetch = async () => ({ ok: true, status: 200, text: () => body.promise });
  setApiSession('local-session-a');
  const oldRequest = api('/api/state');
  await Promise.resolve();
  setApiSession('local-session-b');
  body.resolve(JSON.stringify({ projects: [{ id: 'private-a' }] }));
  await assert.rejects(oldRequest, error => error.name === 'AbortError');
});

test('a late auth rejection from an old account cannot sign out the new account', async () => {
  const response = deferred(); let events = 0; let headers;
  const unsubscribe = subscribeAuthFailure(() => { events++; });
  try {
    globalThis.fetch = () => response.promise;
    setApiSession('local-session-a');
    const oldRequest = api('/api/state');
    setApiSession('local-session-b');
    response.resolve(json({ code: 'AUTH_EXPIRED', error: '已失效' }, 401));
    await assert.rejects(oldRequest, error => error.name === 'AbortError');
    globalThis.fetch = async (_path, options) => { headers = options.headers; return json({ ok: true }); };
    await api('/api/state');
    assert.equal(events, 0);
    assert.equal(headers['X-Studio-Session'], 'local-session-b');
  } finally { unsubscribe(); }
});

for (const [status, code] of [[401, 'AUTH_EXPIRED'], [403, 'AUTH_DISABLED'], [409, 'SESSION_CHANGED']]) {
  test(code + ' clears local business access and notifies the auth gate', async () => {
    const failures = []; let headers;
    const unsubscribe = subscribeAuthFailure(error => failures.push(error));
    try {
      setApiSession('local-session-a');
      globalThis.fetch = async () => json({ error: '请重新验证账号。', code }, status);
      await assert.rejects(api('/api/state'), error => error instanceof ApiError && error.code === code);
      globalThis.fetch = async (_path, options) => { headers = options.headers; return json({ authenticated: false }); };
      await api('/api/auth/status');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].code, code);
      assert.equal(headers['X-Studio-Session'], undefined);
    } finally { unsubscribe(); }
  });
}

test('a temporary auth-unavailable response keeps the current session and does not notify the auth gate', async () => {
  const failures = [];
  const unsubscribe = subscribeAuthFailure(error => failures.push(error));
  try {
    setApiSession('local-session-a');
    globalThis.fetch = async () => json({ error: '账号服务暂时不可用，请稍后重试。', code: 'AUTH_UNAVAILABLE' }, 503);
    await assert.rejects(api('/api/state'), error => error instanceof ApiError && error.code === 'AUTH_UNAVAILABLE');
    globalThis.fetch = async (_path, options) => json({ ok: true, session: options.headers['X-Studio-Session'] });
    assert.deepEqual(await api('/api/state'), { ok: true, session: 'local-session-a' });
    assert.equal(failures.length, 0);
  } finally { unsubscribe(); }
});

test('ordinary authorization errors keep the current account while failed login remains local to its form', async () => {
  const failures = []; let headers;
  const unsubscribe = subscribeAuthFailure(error => failures.push(error));
  try {
    setApiSession('local-session-a');
    globalThis.fetch = async () => json({ code: 'APPROVAL_REQUIRED', error: '请先审核。' }, 403);
    await assert.rejects(api('/api/projects/a/video'), error => error.code === 'APPROVAL_REQUIRED');
    globalThis.fetch = async (_path, options) => { headers = options.headers; return json({ ok: true }); };
    await api('/api/state');
    assert.equal(headers['X-Studio-Session'], 'local-session-a');
    setApiSession(null);
    globalThis.fetch = async () => json({ code: 'AUTH_INVALID', error: '账号或密码错误。' }, 401);
    await assert.rejects(api('/api/auth/login', 'POST', { username: 'fixture', password: 'fixture-password' }), error => error.code === 'AUTH_INVALID');
    assert.equal(failures.length, 0);
  } finally { unsubscribe(); }
});

test('a project missing from the server is treated as a stale project card', () => {
  assert.equal(isMissingProjectError(new ApiError('找不到该作品', 404, 'NOT_FOUND')), true);
  assert.equal(isMissingProjectError(new ApiError('找不到该项目', 404, 'PROJECT_NOT_FOUND')), true);
  assert.equal(isMissingProjectError(new ApiError('禁止访问', 403, 'FORBIDDEN')), false);
  assert.equal(isMissingProjectError(new ApiError('服务器异常', 500, 'INTERNAL_ERROR')), false);
});

test('network and malformed error bodies produce safe errors without exposing transport details', async () => {
  globalThis.fetch = async () => { throw new Error('transport implementation detail'); };
  await assert.rejects(api('/api/auth/status'), error => error instanceof ApiError && error.code === 'LOCAL_UNAVAILABLE' && !error.message.includes('transport'));
  globalThis.fetch = async () => json(null, 502);
  await assert.rejects(api('/api/auth/status'), error => error instanceof ApiError && error.status === 502);
});

test('account storage does not read unowned legacy drafts or another account project selection', () => {
  const local = storage();
  const draft = { title: '旧作品', novel: '需要留在原账号中的故事。', style: '电影写实' };
  writeDrafts(local, 'story', { legacy: draft });
  local.setItem('aiframe-project', 'legacy-project');
  const accountA = scopedAccountStorage(local, 'account-a');
  const accountB = scopedAccountStorage(local, 'account-b');
  assert.deepEqual(readDrafts(accountA, 'story').drafts, {});
  assert.equal(accountA.getItem('aiframe-project'), null);
  accountA.setItem('aiframe-project', 'project-a');
  assert.equal(accountB.getItem('aiframe-project'), null);
  assert.equal(local.getItem('aiframe-project'), 'legacy-project');
  assert.deepEqual(readDrafts(local, 'story').drafts, { legacy: draft });
});

test('workspace recovery is account-scoped, restores the selected workflow point, and rejects stale or unsafe state', () => {
  const local = storage();
  const accountA = scopedAccountStorage(local, 'account-a');
  const accountB = scopedAccountStorage(local, 'account-b');
  assert.equal(writeWorkspaceRecovery(accountA, { projectId: 'project-a', view: 'looks', segmentId: 'segment-1', shotId: 'shot-2', characterId: 'character-3', sceneId: 'scene-4', lookId: 'look-5' }, 1000), true);
  assert.deepEqual(readWorkspaceRecovery(accountA, 1000), { projectId: 'project-a', view: 'looks', segmentId: 'segment-1', shotId: 'shot-2', characterId: 'character-3', sceneId: 'scene-4', lookId: 'look-5', savedAt: 1000 });
  assert.equal(readWorkspaceRecovery(accountB, 1000), null);
  assert.equal(writeWorkspaceRecovery(accountA, { projectId: '../outside', view: 'story' }, 1000), false);
  accountA.setItem(workspaceRecoveryKey, JSON.stringify({ version: 1, projectId: 'project-a', view: 'history', savedAt: 1000 }));
  assert.equal(readWorkspaceRecovery(accountA, 1000), null);
  accountA.setItem(workspaceRecoveryKey, JSON.stringify({ version: 1, projectId: 'project-a', view: 'story', savedAt: 0 }));
  assert.equal(readWorkspaceRecovery(accountA, 30 * 24 * 60 * 60 * 1000), null);
  clearWorkspaceRecovery(accountA);
  assert.equal(accountA.getItem(workspaceRecoveryKey), null);
});

test('an old component cleanup stays bound to the old account after the active account changes', () => {
  const local = storage();
  const accountA = scopedAccountStorage(local, 'account-a');
  const accountB = scopedAccountStorage(local, 'account-b');
  const draftA = { title: '甲账号的草稿', novel: '仅属于甲的内容。', style: '写实' };
  const draftB = { title: '乙账号的草稿', novel: '仅属于乙的内容。', style: '动画' };
  writeDrafts(accountB, 'story', { sameProjectId: draftB });
  const cleanupFromOldComponent = () => writeDrafts(accountA, 'story', { sameProjectId: draftA });
  cleanupFromOldComponent();
  assert.deepEqual(readDrafts(accountA, 'story').drafts, { sameProjectId: draftA });
  assert.deepEqual(readDrafts(accountB, 'story').drafts, { sameProjectId: draftB });
  assert.equal(scopedAccountStorage(local, ''), null);
  assert.equal(scopedAccountStorage(local, '../unsafe'), null);
  assert.equal(scopedAccountStorage(null, 'account-a'), null);
});

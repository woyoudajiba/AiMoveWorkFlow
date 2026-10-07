import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHttpServer } from '../server/http.mjs';
import { createWorkspaces } from '../server/workspaces.mjs';
import { createAdminAuth, hashAdminPassword, verifyAdminPassword } from '../server/admin-auth.mjs';

const alice = { id: 'admin-fixture-alice' };

test('admin password uses a verifiable scrypt hash without storing plaintext', () => {
  const encoded = hashAdminPassword('fixture-admin');
  assert.match(encoded, /^scrypt\$/);
  assert.equal(verifyAdminPassword('fixture-admin', encoded), true);
  assert.equal(verifyAdminPassword('wrong', encoded), false);
  assert.equal(verifyAdminPassword('fixture-admin', 'admin123'), false);
});

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'aiframe-admin-'));
  const distDir = await mkdtemp(path.join(tmpdir(), 'aiframe-admin-dist-'));
  await writeFile(path.join(distDir, 'index.html'), '<html>workf</html>');
  const workspaces = await createWorkspaces({ dataDir, createProvidersImpl: () => ({}) });
  const adminAuth = createAdminAuth({ passwordHash: hashAdminPassword('fixture-admin'), secureCookie: false, cookiePath: '/admin' });
  const authUser = { id: 'ordinary-user', username: 'ordinary' };
  const auth = { public: () => ({ authenticated: true }), validate: async () => ({ user: authUser }), login: async () => ({ user: authUser }), logout: async () => ({ ok: true }) };
  const server = await createHttpServer({ auth, workspaces, distDir, adminAuth });
  t.after(async () => { await server.close(); await workspaces.close(); await rm(dataDir, { recursive: true, force: true }); await rm(distDir, { recursive: true, force: true }); });
  const baseHeaders = { 'X-Local-Client': 'aiframe', 'content-type': 'application/json' };
  const call = (route, method = 'GET', body, cookie) => fetch(server.url + route, { method, headers: { ...baseHeaders, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async () => { const response = await call('/api/admin/auth/login', 'POST', { password: 'fixture-admin' }); assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0]; };
  return { dataDir, workspaces, call, login, account: await workspaces.get(alice) };
}

test('admin API is isolated from ordinary sessions and can list/delete one project', async t => {
  const f = await fixture(t);
  const project = await f.account.service.create({ title: '管理员测试项目', novel: '原始内容' });
  await mkdir(path.join(f.account.dataDir, 'media', project.id), { recursive: true });
  await writeFile(path.join(f.account.dataDir, 'media', project.id, 'frame.png'), 'fixture-image');
  await mkdir(path.join(f.account.dataDir, 'provider-receipts', 'analysis'), { recursive: true });
  await writeFile(path.join(f.account.dataDir, 'provider-receipts', `${project.id}-receipt.json`), '{}');
  await writeFile(path.join(f.account.dataDir, 'provider-receipts', 'analysis', `${project.id}-checkpoint.json`), '{}');
  assert.equal((await f.call('/api/admin/projects')).status, 401);
  const cookie = await f.login();
  const listing = await (await f.call('/api/admin/projects', 'GET', undefined, cookie)).json();
  assert.equal(listing.totals.projects, 1);
  assert.equal(listing.accounts[0].projects[0].title, '管理员测试项目');
  const accountRef = listing.accounts[0].accountRef;
  assert.equal((await f.call('/api/admin/projects', 'DELETE', { accountRef, projectId: project.id }, cookie)).status, 409);
  const deleted = await f.call('/api/admin/projects', 'DELETE', { confirm: true, accountRef, projectId: project.id }, cookie);
  assert.equal(deleted.status, 200);
  await assert.rejects(readFile(path.join(f.account.dataDir, `${project.id}.json`)), e => e.code === 'ENOENT');
  await assert.rejects(readFile(path.join(f.account.dataDir, 'media', project.id, 'frame.png')), e => e.code === 'ENOENT');
  await assert.rejects(readFile(path.join(f.account.dataDir, 'provider-receipts', `${project.id}-receipt.json`)), e => e.code === 'ENOENT');
});

test('global cleanup keeps project identity/source but removes derived analysis and media', async t => {
  const f = await fixture(t);
  const project = await f.account.service.create({ title: '保留索引', novel: '原始内容' });
  const file = path.join(f.account.dataDir, `${project.id}.json`);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.characters = [{ id: 'hero' }]; saved.segments = [{ id: 'segment', shots: [{ id: 'shot' }] }]; saved.jobs = [{ id: 'job', status: 'completed' }];
  await writeFile(file, JSON.stringify(saved));
  await mkdir(path.join(f.account.dataDir, 'media', project.id), { recursive: true });
  await writeFile(path.join(f.account.dataDir, 'media', project.id, 'movie.mp4'), 'fixture-video');
  await mkdir(path.join(f.account.dataDir, 'provider-receipts', 'analysis'), { recursive: true });
  await writeFile(path.join(f.account.dataDir, 'provider-receipts', 'analysis', `${project.id}-checkpoint.json`), '{}');
  const cookie = await f.login();
  assert.equal((await f.call('/api/admin/cleanup', 'POST', { confirm: true, scope: 'wrong' }, cookie)).status, 409);
  const response = await f.call('/api/admin/cleanup', 'POST', { confirm: true, scope: 'media-analysis' }, cookie);
  assert.equal(response.status, 200);
  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(after.title, '保留索引'); assert.equal(after.novel, '原始内容'); assert.deepEqual(after.characters, []); assert.deepEqual(after.segments, []); assert.deepEqual(after.jobs, []);
  assert.equal((await f.call('/api/admin/projects', 'GET', undefined, cookie)).status, 200);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHttpServer,authenticatedFetch as fetch} from './helpers/http-fixture.mjs';

async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'aiframe-http-'));
  await mkdir(path.join(dir,'media'));
  await mkdir(path.join(dir,'dist'));
  await mkdir(path.join(dir,'client'));
  await writeFile(path.join(dir,'dist','index.html'),'<html>studio</html>');
  await writeFile(path.join(dir,'client','YingXu-test.exe'),Buffer.from('MZ-test-client'));
  await writeFile(path.join(dir,'media','test.mp4'),Buffer.from('0123456789'));
  const service={list:async()=>[],history:async()=>[{id:'export-1',projectId:'p1',projectTitle:'历史作品',segmentId:'s1',segmentTitle:'雨夜',number:1,videoUrl:'/media/p1/export-1/001.mp4',gridUrl:'/media/p1/export-1/001.jpg',pages:[{number:1,gridUrl:'/media/p1/export-1/001.jpg'}],manifestUrl:'/media/p1/export-1/manifest.json',csvUrl:'/media/p1/export-1/shots.csv',templateId:'classic-nine',createdAt:'2026-10-03T01:02:03.000Z'}],ledger:async()=>[{id:'image-1',projectId:'p1',projectTitle:'历史作品',recordType:'shot-image',assetUrl:'/media/p1/image.png',assetTitle:'镜头 01 · 分镜图片',createdAt:'2026-10-03T01:03:03.000Z'}],create:async x=>({id:'p1',...x}),remove:async id=>({id,title:`删除 ${id}`}),get:async()=>{throw new Error('Bearer private-secret');},previewSegment:async(id,sid)=>({projectId:id,segmentId:sid,number:1,gridUrl:`/media/${id}/preview/001.jpg`,manifestUrl:`/media/${id}/preview/manifest.json`,csvUrl:`/media/${id}/preview/shots.csv`})};
  const server=await createHttpServer({service,config:{public:()=>({llmConfigured:false})},dataDir:dir,distDir:path.join(dir,'dist'),downloadsDir:path.join(dir,'client')});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  return server;
}
test('local writes require explicit custom header and allowed origin',async t=>{
  const {url}=await fixture(t);
  assert.equal((await fetch(url+'/api/projects',{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/projects',{method:'POST',headers:{'X-Local-Client':'aiframe',origin:'https://attacker.test','content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(url+'/api/projects',{method:'POST',headers:{'X-Local-Client':'aiframe',origin:url,'content-type':'application/json'},body:'{"title":"test"}'})).status,200);
});
test('configured cloud host and origin are accepted without weakening the source marker', async t => {
  const { url } = await fixture(t);
  const previousHost = process.env.AI_FRAME_ALLOWED_HOSTS;
  const previousOrigin = process.env.AI_FRAME_ALLOWED_ORIGINS;
  process.env.AI_FRAME_ALLOWED_HOSTS = 'wsfile.cn';
  process.env.AI_FRAME_ALLOWED_ORIGINS = 'https://wsfile.cn';
  try {
    const accepted = await fetch(url + '/api/auth/status', { headers: { Host: 'wsfile.cn', Origin: 'https://wsfile.cn', 'X-Local-Client': 'aiframe' } });
    assert.equal(accepted.status, 200);
    const rejected = await fetch(url + '/api/auth/status', { headers: { Host: 'wsfile.cn', Origin: 'https://attacker.example', 'X-Local-Client': 'aiframe' } });
    assert.equal(rejected.status, 403);
  } finally {
    if (previousHost === undefined) delete process.env.AI_FRAME_ALLOWED_HOSTS; else process.env.AI_FRAME_ALLOWED_HOSTS = previousHost;
    if (previousOrigin === undefined) delete process.env.AI_FRAME_ALLOWED_ORIGINS; else process.env.AI_FRAME_ALLOWED_ORIGINS = previousOrigin;
  }
});
test('media range response supports seeking and sensitive data never appears in errors',async t=>{
  const {url}=await fixture(t);
  const r=await fetch(url+'/media/test.mp4',{headers:{Range:'bytes=2-5'}});
  assert.equal(r.status,206); assert.equal(await r.text(),'2345');
  const error=await fetch(url+'/api/projects/missing');
  assert.equal(error.status,500);assert.equal((await error.text()).includes('private-secret'),false);
  assert.equal((await fetch(url+'/data/projects.json')).status,404);
});

test('media full response advertises browser-playable MP4 metadata', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + '/media/test.mp4');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('content-length'), '10');
  assert.equal((await response.arrayBuffer()).byteLength, 10);
});
test('project storyboard images receive the same account-scoped media URL as other assets', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiframe-storyboard-http-'));
  const server = await createHttpServer({
    dataDir: dir,
    distDir: dir,
    config: { public: () => ({}) },
    service: {
      get: async () => ({ id: 'p1', segments: [{ id: 's1', storyboardImage: '/media/p1/board.png', video: '/media/p1/video.mp4' }] }),
    },
  });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(server.url + '/api/projects/p1');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.segments[0].storyboardImage, /^\/media\/p1\/board\.png\?account=/);
  assert.match(result.segments[0].video, /^\/media\/p1\/video\.mp4\?account=/);
});
test('invalid JSON and oversized request produce bounded errors',async t=>{
  const {url}=await fixture(t);
  const r=await fetch(url+'/api/projects',{method:'POST',headers:{'X-Local-Client':'aiframe','content-type':'application/json'},body:'{invalid'});
  assert.equal(r.status,400);
});

test('preview route returns synchronous artifacts behind the existing local write boundary',async t=>{
  const {url}=await fixture(t);const endpoint=url+'/api/projects/p1/segments/s1/preview';
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','X-Local-Client':'aiframe'},body:'{}'});
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.segmentId,'s1');assert.ok(new URL(result.gridUrl,url).pathname.endsWith('/001.jpg'));assert.equal('videoUrl' in result,false);
});

test('analysis retry route keeps the authenticated write boundary and forwards explicit acknowledgment',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'aiframe-retry-http-'));let calls=0;
  const server=await createHttpServer({dataDir:dir,distDir:dir,config:{public:()=>({})},service:{retryAnalysis:async(id,jid,body)=>{calls++;return {id,jobId:jid,confirmation:body.confirmDuplicateCost};}}});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const endpoint=server.url+'/api/projects/p1/jobs/j1/retry-analysis';
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{"confirmDuplicateCost":true}'})).status,403);
  assert.equal(calls,0);
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','X-Local-Client':'aiframe'},body:'{"confirmDuplicateCost":true}'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:'p1',jobId:'j1',confirmation:true});assert.equal(calls,1);
});

test('append analysis route keeps the authenticated write boundary', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiframe-append-http-')); let calls = 0;
  const server = await createHttpServer({ dataDir: dir, distDir: dir, config: { public: () => ({}) }, service: {
    analyzeAppend: async id => { calls++; return { id, accepted: true }; },
  } });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const endpoint = `${server.url}/api/projects/p1/analyze-append`;
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Local-Client': 'aiframe' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'p1', accepted: true });
  assert.equal(calls, 1);
});

test('history route returns only safe account-scoped media URLs and no physical paths',async t=>{
  const {url}=await fixture(t);
  const response=await fetch(url+'/api/history');
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.records.length,1);
  assert.equal(result.records[0].projectTitle,'历史作品');
  assert.match(result.records[0].videoUrl,/^\/media\/p1\/export-1\/001\.mp4\?account=/);
  assert.match(result.records[0].pages[0].gridUrl,/^\/media\/p1\/export-1\/001\.jpg\?account=/);
  assert.equal(JSON.stringify(result).includes('D:\\\\'),false);
  assert.equal(JSON.stringify(result).includes('outputRoot'),false);
});

test('ledger route returns account-scoped image and video records for the history page', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url + '/api/ledger');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].recordType, 'shot-image');
  assert.match(result.records[0].assetUrl, /^\/media\/p1\/image\.png\?account=/);
  assert.equal(result.records[0].assetTitle, '镜头 01 · 分镜图片');
});

test('project delete route uses the authenticated local write boundary', async t => {
  const { url } = await fixture(t);
  const endpoint = url + '/api/projects/project-1';
  assert.equal((await fetch(endpoint, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 403);
  const response = await fetch(endpoint, { method: 'DELETE', headers: { 'content-type': 'application/json', 'X-Local-Client': 'aiframe' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'project-1', title: '删除 project-1' });
});

test('project delete route forwards explicit force confirmation', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiframe-force-delete-http-'));
  const calls = [];
  const server = await createHttpServer({
    dataDir: dir,
    distDir: dir,
    config: { public: () => ({}) },
    service: { remove: async (id, options) => { calls.push({ id, options }); return { id, title: '强制删除' }; } },
  });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(server.url + '/api/projects/p1', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', 'X-Local-Client': 'aiframe' },
    body: JSON.stringify({ force: true }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ id: 'p1', options: { force: true } }]);
});

test('project video cleanup route forwards the explicit local archive confirmation', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiframe-cleanup-http-'));
  const calls = [];
  const server = await createHttpServer({
    dataDir: dir,
    distDir: dir,
    config: { public: () => ({}) },
    service: { cleanupVideos: async (id, body) => { calls.push({ id, body }); return { id, remoteVideoCleanupAt: 'now' }; } },
  });
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });
  const endpoint = server.url + '/api/projects/p1/cleanup-videos';
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, urls: ['/media/p1/video.mp4'] }) })).status, 403);
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Local-Client': 'aiframe' }, body: JSON.stringify({ confirm: true, urls: ['/media/p1/video.mp4'] }) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ id: 'p1', body: { confirm: true, urls: ['/media/p1/video.mp4'] } }]);
});

test('client download is public, bounded to the configured directory, and marked as an attachment',async t=>{
  const {url}=await fixture(t);
  const response=await fetch(url+'/downloads/YingXu-test.exe');
  assert.equal(response.status,200);
  assert.equal(response.headers.get('content-type'),'application/vnd.microsoft.portable-executable');
  assert.match(response.headers.get('content-disposition')||'',/attachment; filename="YingXu-test\.exe"/);
  assert.equal(await response.text(),'MZ-test-client');
  assert.equal((await fetch(url+'/downloads/..%2Fmedia%2Ftest.mp4')).status,404);
  assert.equal((await fetch(url+'/downloads/missing.exe')).status,404);
});

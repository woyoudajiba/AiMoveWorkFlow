import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { createHttpServer, authenticatedFetch as fetch } from './helpers/http-fixture.mjs';
import { createService } from '../server/service.mjs';
import { createProviders } from '../server/providers.mjs';
import { runProcess, probeVideo, resolveMediaPath } from '../server/media.mjs';

test('HTTP workflow uploads and approves roles and nine shots, generates bounded mock video tasks, and exports real numbered media', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiframe-integration-'));
  let service;
  let server;
  t.after(async () => {
    if (server) await server.close();
    if (service) await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  const mediaRoot = path.join(directory, 'media');
  const distDir = path.join(directory, 'dist');
  await Promise.all([mkdir(mediaRoot), mkdir(distDir)]);
  await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>Integration fixture</title>');

  // This is a local technical fixture. No generated frame, credential, model
  // response or network request comes from a real external model service.
  const sourceFile = path.join(directory, 'fixture.mp4');
  await runProcess(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=teal:s=180x320:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-shortest',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sourceFile,
  ]);
  const videoBytes = await readFile(sourceFile);
  const png = await sharp({ create: { width: 180, height: 320, channels: 3, background: '#46716b' } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
  const tasks = new Map();
  let postCount = 0;
  let downloadCount = 0;
  const providers = createProviders({
    mediaRoot,
    getSettings: () => ({ llmKey: '', grsaiKey: '', minimaxKey: 'integration-fixture-only', videoModel: 'MiniMax-H3' }),
    requestJson: async (url, options) => {
      if (options.method === 'POST') {
        assert.equal(url, 'https://api.minimax.cn/v2/video_generation');
        assert.equal(options.body.model, 'MiniMax-H3');
        assert.equal(options.body.duration, 4);
        assert.equal(options.body.ratio, 'adaptive');
        const media = options.body.content.slice(1);
        assert.ok(['first_frame', 'reference_image'].includes(media[0]?.role));
        assert.equal(media.every(item => item.role === media[0].role), true);
        assert.ok(options.body.content[1].image_url.url.startsWith('data:image/png;base64,'));
        const id = `fixture-task-${++postCount}`;
        tasks.set(id, { queries: 0 });
        return { task_id: id, status: 'queued', progress: 0 };
      }
      assert.equal(options.method, 'GET');
      const id = url.split('/').at(-1);
      const task = tasks.get(id);
      assert.ok(task, 'polling must refer to one persisted task');
      task.queries++;
      return task.queries === 1
        ? { task_id: id, status: 'running', progress: 50 }
        : { task_id: id, status: 'succeeded', content: { url: `https://fixture.example/${id}.mp4` } };
    },
    download: async (url, options) => {
      assert.match(url, /^https:\/\/fixture\.example\/fixture-task-\d+\.mp4$/);
      assert.equal(options.maxBytes, 250 * 1024 * 1024);
      downloadCount++;
      return videoBytes;
    },
  });
  service = await createService({ dataDir: directory, providers, pollIntervalMs: 1, pollTimeoutMs: 30000 });
  server = await createHttpServer({
    service, dataDir: directory, distDir,
     config: { public: () => ({ llmConfigured: false, grsaiConfigured: false, minimaxConfigured: true, arkConfigured: false, llmModel: 'qwen3.7-plus', imageModel: 'nano-banana-pro', videoModel: 'MiniMax-H3', credentialStorage: 'session', ffmpegAvailable: true }) },
  });

  async function api(route, method = 'GET', body) {
    const response = await fetch(server.url + route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Local-Client': 'aiframe', Origin: server.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(value)}`);
    return value;
  }
  const created = await api('/api/projects', 'POST', { title: 'HTTP 原稿', novel: '林遥走进书店，陈默认出了她。他们一起等到雨停。', duration: 30, aspectRatio: '9:16' });
  assert.equal(created.segments.length, 0);
  let project = await api('/api/demo', 'POST', {});
  const base = `/api/projects/${project.id}`;
  assert.equal(project.characters.length, 2);
  assert.equal(project.segments[0].shots.length, 9);
  assert.equal(postCount, 0, 'creating and opening demo must not call a model');

  for (const character of project.characters) {
    const uploaded = await api(`${base}/characters/${character.id}/upload`, 'POST', { dataUrl });
    assert.equal(uploaded.characters.find(item => item.id === character.id).approved, false);
    project = await api(`${base}/characters/${character.id}/approve`, 'POST', {});
  }
  assert.ok(project.characters.every(character => character.approved && character.reference));
  for(const look of project.looks){
    project=await api(`${base}/looks/${look.id}/upload`,'POST',{dataUrl});
    const current=project.looks.find(item=>item.id===look.id);
    project=await api(`${base}/looks/${look.id}/approve`,'POST',{reviewedVersion:current.version});
  }
  assert.ok(project.looks.every(look=>look.approved&&look.referenceVersion===look.version));
  for (const shot of project.segments[0].shots) project = await api(`${base}/shots/${shot.id}/upload`, 'POST', { dataUrl });
  const segmentId = project.segments[0].id;
  project = await api(`${base}/segments/${segmentId}/approve`, 'POST', {});
  assert.ok(project.segments[0].shots.every(shot => shot.approved && shot.image));

  const premature = await fetch(server.url + `${base}/segments/${segmentId}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Client': 'aiframe', Origin: server.url }, body: '{}' });
  assert.equal(premature.status, 409, 'export cannot silently skip missing videos');
  project = await api(`${base}/segments/${segmentId}/generate-videos`, 'POST', {});
  assert.equal(project.jobs.filter(job => job.kind === 'video').length, 9);
  async function waitFor(condition) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const state = await api(base);
      const failure = state.jobs.find(job => ['failed', 'unknown', 'interrupted'].includes(job.status));
      assert.equal(failure, undefined, failure ? `${failure.kind}: ${failure.error}` : undefined);
      if (condition(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    assert.fail('real local media workflow did not finish before its bounded deadline');
  }
  project = await waitFor(state => state.segments[0].shots.every(shot => shot.video && shot.videoVersion === shot.version));
  assert.equal(postCount, 9);
  assert.equal(downloadCount, 9);
  assert.ok([...tasks.values()].every(task => task.queries === 2));
  assert.ok(project.segments[0].shots.every(shot => shot.videoDuration === 4));
  const disk = JSON.parse(await readFile(path.join(directory, `${project.id}.json`), 'utf8'));
  assert.ok(disk.jobs.filter(job => job.kind === 'video').every(job => job.providerTaskId && job.businessId && job.status === 'completed'));

  await api(`${base}/segments/${segmentId}/export`, 'POST', {});
  project = await waitFor(state => state.exports.length === 1);
  const output = project.exports[0];
  assert.match(new URL(output.videoUrl,server.url).pathname, new RegExp(`^/media/${project.id}/export-[a-z0-9-]+/001\\.mp4$`));
  assert.ok(new URL(output.gridUrl,server.url).pathname.endsWith('/001.jpg'));
  const exported = await probeVideo(await resolveMediaPath(mediaRoot, project.id, new URL(output.videoUrl,server.url).pathname), { decode: true });
  assert.ok(Math.abs(exported.duration - 30) < 0.1);
  assert.deepEqual([exported.width, exported.height, exported.hasAudio], [720, 1280, true]);
  const videoResponse = await fetch(server.url + output.videoUrl);
  assert.equal(videoResponse.status, 200);
  assert.equal(videoResponse.headers.get('Content-Type'), 'video/mp4');
  assert.ok((await videoResponse.arrayBuffer()).byteLength > 1000);
  const range = await fetch(server.url + output.videoUrl, { headers: { Range: 'bytes=0-31' } });
  assert.equal(range.status, 206);
  assert.ok(range.headers.get('Content-Range').startsWith('bytes 0-31/'));
  assert.equal((await range.arrayBuffer()).byteLength, 32);
  const csv = await (await fetch(server.url + output.csvUrl)).text();
  assert.ok(csv.includes('"001","01"'));
  assert.ok(csv.includes('你还留着？'));
  const manifest = await (await fetch(server.url + output.manifestUrl)).json();
  assert.deepEqual(manifest.shots.map(shot => shot.number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(manifest.audio, 'present');
  const grid = await fetch(server.url + output.gridUrl);
  assert.equal(grid.status, 200);
  assert.equal((await sharp(Buffer.from(await grid.arrayBuffer())).metadata()).format, 'jpeg');
  const history = await api('/api/history');
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].projectId, project.id);
  assert.equal(history.records[0].videoUrl, output.videoUrl);
  assert.equal(postCount, 9, 'export and read-only downloads must not create any extra generation requests');
});

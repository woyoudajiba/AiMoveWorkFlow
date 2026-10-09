import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.mjs';
import {SAMPLE_ANALYSIS} from '../server/sample.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(service, id, check) {
  for (let i = 0; i < 100; i++) { const p = await service.get(id); if (check(p)) return p; await delay(10); }
  assert.fail('queue did not reach expected state');
}
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiframe-state-'));
  const calls = { submit: 0, poll: 0 };
  const providers = {
    importImage: async p => `/media/${p.id}/reference.png`,
    generateCharacter: async p => `/media/${p.id}/character.png`,
    generateLook: async p => `/media/${p.id}/look.png`,
    generateShot: async p => `/media/${p.id}/shot.png`,
    submitVideo: async () => { calls.submit++; return { id: 'provider-1', status: 'queued', progress: 0 }; },
    pollVideo: async () => { calls.poll++; return { id: 'provider-1', status: 'completed', progress: 100, url: 'https://example.com/video.mp4' }; },
    downloadVideo: async p => `/media/${p.id}/video.mp4`,
    exportSegment: async p => Object.fromEntries(['videoUrl', 'gridUrl', 'manifestUrl', 'csvUrl'].map(k => [k, `/media/${p.id}/${k}`])),
    ...overrides,
  };
  const service = await createService({ dataDir: dir, providers, pollIntervalMs: 1 });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  return { service, dir, providers, calls };
}
async function approved(service) {
  let project = await service.demo();
  for (const c of project.characters) { await service.characterAction(project.id, c.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' }); await service.characterAction(project.id, c.id, 'approve'); }
  for(const look of project.looks){await service.lookAction(project.id,look.id,'upload',{dataUrl:'data:image/png;base64,AA=='});await service.lookAction(project.id,look.id,'approve');}
  for (const s of project.segments[0].shots) await service.shotAction(project.id, s.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  project = await service.segmentAction(project.id, project.segments[0].id, 'approve');
  return project;
}

test('uncertain analysis needs explicit cost confirmation, retains its record and deduplicates continuation',async t=>{
  let calls=0;const attempts=[];
  const {service}=await fixture(t,{analyze:async(_p,_business,options)=>{
    calls++;attempts.push(options);
    if(calls===1)throw Object.assign(new Error('模型超时'),{code:'NETWORK_TIMEOUT'});
    return structuredClone(SAMPLE_ANALYSIS);
  }});
  const p=await service.create({title:'测试',novel:'雨夜，林晚回到车站。',duration:30,aspectRatio:'9:16',style:'写实'});
  await service.analyze(p.id);
  let live=await waitFor(service,p.id,p=>p.jobs.at(-1)?.status==='unknown');
  const original=live.jobs[0];
  for(const body of [{},{confirmDuplicateCost:false},{confirmDuplicateCost:'true'},{confirmDuplicateCost:true,reset:true}]){
    await assert.rejects(service.retryAnalysis(p.id,original.id,body));
  }
  await service.analyze(p.id);assert.equal(calls,1);
  await Promise.all([service.retryAnalysis(p.id,original.id,{confirmDuplicateCost:true}),service.retryAnalysis(p.id,original.id,{confirmDuplicateCost:true})]);
  live=await waitFor(service,p.id,p=>p.jobs.at(-1)?.status==='completed');
  assert.equal(calls,2);assert.equal(live.jobs.length,2);
  assert.equal(live.jobs[0].status,'unknown');
  assert.equal(live.jobs[0].analysisRetryJobId,live.jobs[1].id);
  assert.ok(live.jobs[0].analysisRetryAcceptedAt);
  assert.equal(live.jobs[1].analysisRetryOf,original.id);
  assert.equal(attempts[1].retryUncertain,true);
  assert.ok(live.characters.length);assert.equal(live.novel,p.novel);
});

test('projects persist independent analysis models, snapshot the job model, and analyze different projects concurrently', async t => {
  let executing = 0;
  let maxExecuting = 0;
  const seenModels = [];
  const { service } = await fixture(t, {
    analyze: async (project, _businessId, options = {}) => {
      executing += 1;
      maxExecuting = Math.max(maxExecuting, executing);
      seenModels.push(options.analysisModel);
      await delay(20);
      executing -= 1;
      return structuredClone(SAMPLE_ANALYSIS);
    },
  });
  const deepseek = await service.create({ title: 'DeepSeek 项目', novel: '第一份正文。', llmModel: 'deepseek-v4-pro' });
  const qwen = await service.create({ title: 'Qwen 项目', novel: '第二份正文。' });
  const configuredQwen = await service.update(qwen.id, { llmModel: 'qwen3.7-plus' });
  assert.equal((await service.get(deepseek.id)).llmModel, 'deepseek-v4-pro');
  assert.equal(configuredQwen.llmModel, 'qwen3.7-plus');
  await service.analyze(deepseek.id);
  await service.analyze(qwen.id);
  const completed = await waitFor(service, qwen.id, item => item.jobs.at(-1)?.status === 'completed');
  await waitFor(service, deepseek.id, item => item.jobs.at(-1)?.status === 'completed');
  assert.ok(maxExecuting >= 2, `expected different projects to overlap, got ${maxExecuting}`);
  assert.deepEqual(seenModels.sort(), ['deepseek-v4-pro', 'qwen3.7-plus']);
  await assert.rejects(service.update(deepseek.id, { llmModel: 'qwen3.7-plus' }), error => error.code === 'STRUCTURE_LOCKED');
  assert.equal(completed.llmModel, 'qwen3.7-plus');
});

test('projects using the same analysis model still run concurrently', async t => {
  let executing = 0;
  let maxExecuting = 0;
  const seenModels = [];
  const { service } = await fixture(t, {
    analyze: async (_project, _businessId, options = {}) => {
      executing += 1;
      maxExecuting = Math.max(maxExecuting, executing);
      seenModels.push(options.analysisModel);
      await delay(20);
      executing -= 1;
      return structuredClone(SAMPLE_ANALYSIS);
    },
  });
  const first = await service.create({ title: 'Qwen 项目一', novel: '第一份正文。', llmModel: 'qwen3.7-plus' });
  const second = await service.create({ title: 'Qwen 项目二', novel: '第二份正文。', llmModel: 'qwen3.7-plus' });
  await service.analyze(first.id);
  await service.analyze(second.id);
  await waitFor(service, first.id, item => item.jobs.at(-1)?.status === 'completed');
  await waitFor(service, second.id, item => item.jobs.at(-1)?.status === 'completed');
  assert.ok(maxExecuting >= 2, `expected same-model projects to overlap, got ${maxExecuting}`);
  assert.deepEqual(seenModels, ['qwen3.7-plus', 'qwen3.7-plus']);
});

test('analyzed projects accept strict suffixes and append only new analysis while preserving old records', async t => {
  const calls = [];
  const { service } = await fixture(t, {
    analyze: async (project, _businessId, options = {}) => {
      calls.push({ novel: project.novel, options });
      if (!options.analysisAppend) return structuredClone(SAMPLE_ANALYSIS);
      const existingCharacter = project.characters[0];
      const existingScene = project.scenes[0];
      return {
        characters: [...project.characters, { id: 'new-character', name: '新增角色', role: 'supporting', aliases: [], appearance: '成年女性，短发。', evidence: '新增段落出现。' }],
        scenes: [...project.scenes, { id: 'new-scene', name: '新增场景', description: '新增段落的场景。' }],
        looks: [...project.looks, { id: 'new-look', sceneId: 'new-scene', characterId: 'new-character', name: '新增造型', appearance: '深色长袍。' }],
        segments: [...project.segments, {
          title: '新增片段', summary: '新增内容', duration: 30,
          shots: Array.from({ length: 9 }, (_, index) => ({
            sceneId: index === 0 ? 'new-scene' : existingScene.id,
            scene: '新增场景', action: '新增动作', camera: '中景', dialogue: '', narration: '',
            characterIds: index === 0 ? ['new-character'] : [existingCharacter.id], duration: index === 8 ? 6 : 3,
          })),
        }],
      };
    },
  });
  const original = await service.create({ title: '可追加作品', novel: '第一集原稿', duration: 30, aspectRatio: '9:16', style: '电影写实' });
  await service.analyze(original.id);
  const analyzed = await waitFor(service, original.id, item => item.jobs.at(-1)?.status === 'completed');
  const oldSegmentId = analyzed.segments[0].id;
  const oldCharacterId = analyzed.characters[0].id;
  const oldCharacterVersion = analyzed.characters[0].version;
  const appendedNovel = `${analyzed.novel}\n第2集：新增段落。`;
  const appended = await service.update(original.id, { novel: appendedNovel });
  assert.equal(appended.novel, appendedNovel);
  assert.equal(appended.analysisSourceLength, analyzed.analysisSourceLength);
  await service.analyzeAppend(original.id);
  const completed = await waitFor(service, original.id, item => item.jobs.at(-1)?.status === 'completed' && item.segments.length > 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.analysisAppend, true);
  assert.equal(calls[1].options.appendFrom, analyzed.novel.length);
  assert.equal(calls[1].options.analysisBaseSegments, analyzed.segments.length);
  assert.equal(calls[1].novel, appendedNovel);
  assert.equal(completed.segments[0].id, oldSegmentId);
  assert.equal(completed.characters[0].id, oldCharacterId);
  assert.equal(completed.characters[0].version, oldCharacterVersion);
  assert.equal(completed.segments.length, 2);
  assert.equal(completed.characters.some(character => character.id === 'new-character'), true);
  assert.equal(completed.analysisSourceLength, appendedNovel.length);
});

test('analyzed projects reject edits before the analyzed prefix and append analysis without new text', async t => {
  const { service } = await fixture(t, { analyze: async () => structuredClone(SAMPLE_ANALYSIS) });
  const original = await service.create({ title: '只允许追加', novel: '稳定原稿', duration: 30 });
  await service.analyze(original.id);
  const analyzed = await waitFor(service, original.id, item => item.jobs.at(-1)?.status === 'completed');
  await assert.rejects(service.update(original.id, { novel: '修改了原稿' }), error => error.code === 'STRUCTURE_LOCKED');
  await assert.rejects(service.analyzeAppend(original.id), error => error.code === 'NO_APPEND_CONTENT');
  assert.equal((await service.get(original.id)).novel, analyzed.novel);
});

test('reopening a legacy project normalizes copied character evidence before it reaches the editor', async t => {
  const { service, dir, providers } = await fixture(t);
  const project = await service.demo();
  project.characters[0].appearance = '原文：蓝色外套，肩头淋湿。创作设定待确认：青年女性，黑色及肩发，自然妆容。';
  project.characters[0].evidence = '林遥推开门，蓝色外套的肩头淋湿。';
  await service.close();
  await writeFile(path.join(dir, `${project.id}.json`), JSON.stringify(project));
  const reopened = await createService({ dataDir: dir, providers });
  t.after(() => reopened.close());
  const loaded = await reopened.get(project.id);
  assert.equal(loaded.characters[0].appearance, '创作设定待确认：青年女性，黑色及肩发，自然妆容。');
  assert.equal(loaded.characters[0].evidence, '林遥推开门，蓝色外套的肩头淋湿。');
});

test('analysis continuation rejects missing, non-analysis and obsolete jobs',async t=>{
  const {service,dir,providers}=await fixture(t,{analyze:async()=>{throw Object.assign(new Error('超时'),{code:'NETWORK_TIMEOUT'});}});
  const p=await service.create({title:'测试',novel:'雨夜，林晚回到车站。',duration:30});
  await service.analyze(p.id);
  const live=await waitFor(service,p.id,p=>p.jobs[0]?.status==='unknown');
  const jid=live.jobs[0].id;
  await assert.rejects(service.retryAnalysis(p.id,'missing',{confirmDuplicateCost:true}),e=>e.code==='NOT_FOUND');
  const demo=await service.demo();
  await service.characterAction(demo.id,demo.characters[0].id,'generate');
  const withJob=await waitFor(service,demo.id,p=>p.jobs[0]?.status==='completed');
  await assert.rejects(service.retryAnalysis(demo.id,withJob.jobs[0].id,{confirmDuplicateCost:true}),e=>e.code==='CANNOT_RESUME');
  await service.close();
  await writeFile(path.join(dir,`${p.id}.json`),JSON.stringify({...live,novel:'外部迁移后另一版原稿'}));
  const reopened=await createService({dataDir:dir,providers});
  t.after(()=>reopened.close());
  await assert.rejects(reopened.retryAnalysis(p.id,jid,{confirmDuplicateCost:true}),e=>e.code==='STALE_INPUT');
});

test('a new unknown continuation needs new confirmation and service restart never repeats it',async t=>{
  let calls=0;
  const {service,dir,providers}=await fixture(t,{analyze:async()=>{calls++;throw Object.assign(new Error('超时'),{code:'NETWORK_TIMEOUT'});}});
  const p=await service.create({title:'测试',novel:'雨夜，林晚回到车站。',duration:30});
  await service.analyze(p.id);
  let live=await waitFor(service,p.id,p=>p.jobs[0]?.status==='unknown');
  const original=live.jobs[0];
  await service.retryAnalysis(p.id,original.id,{confirmDuplicateCost:true});
  live=await waitFor(service,p.id,p=>p.jobs.length===2&&p.jobs[1].status==='unknown');
  await service.retryAnalysis(p.id,original.id,{confirmDuplicateCost:true});
  await service.analyze(p.id);
  assert.equal(calls,2);
  await service.close();
  const reopened=await createService({dataDir:dir,providers});
  try {
    assert.equal((await reopened.get(p.id)).jobs.length,2);
    await delay(30);assert.equal(calls,2);
    await assert.rejects(reopened.retryAnalysis(p.id,live.jobs[1].id,{}),e=>e.code==='RETRY_CONFIRMATION_REQUIRED');
  }finally{await reopened.close();}
});

test('a restarted analysis with a published checkpoint can be explicitly continued', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  let retryOptions;
  const { service, dir, providers } = await fixture(t, {
    analyze: async (_project, _businessId, options = {}) => {
      calls += 1;
      if (calls === 1) {
        const partial = structuredClone(SAMPLE_ANALYSIS);
        partial.segments[0].analysisChunk = 0;
        await options.onProgress({ completedChunks: 4, totalChunks: 56, phase: 'analyzing', model: 'qwen3.7-plus', readyThroughChunk: 4, readySegmentCount: 1, partialAnalysis: partial });
        await gate;
        return structuredClone(SAMPLE_ANALYSIS);
      }
      retryOptions = options;
      return structuredClone(SAMPLE_ANALYSIS);
    },
  });
  const project = await service.create({ title: '重启后继续分析', novel: '一段足够长的原稿。', duration: 30 });
  await service.analyze(project.id);
  const running = await waitFor(service, project.id, item => item.jobs[0]?.status === 'running' && item.analysisReady?.complete === false);
  const originalJobId = running.jobs[0].id;
  await service.close();
  release();
  const savedPath = path.join(dir, `${project.id}.json`);
  const savedProject = JSON.parse(await readFile(savedPath, 'utf8'));
  delete savedProject.analysisReady;
  await writeFile(savedPath, JSON.stringify(savedProject));

  const reopened = await createService({ dataDir: dir, providers, pollIntervalMs: 1 });
  t.after(async () => { await reopened.close(); });
  const recovered = await waitFor(reopened, project.id, item => item.jobs[0]?.status === 'unknown');
  assert.equal(recovered.segments.length, 1);
  await reopened.retryAnalysis(project.id, originalJobId, { confirmDuplicateCost: true });
  const completed = await waitFor(reopened, project.id, item => item.jobs.at(-1)?.status === 'completed');
  assert.equal(calls, 2);
  assert.equal(retryOptions.retryUncertain, true);
  assert.equal(completed.jobs[0].status, 'unknown');
  assert.equal(completed.jobs[0].analysisRetryJobId, completed.jobs[1].id);
});

test('an actively running analysis cannot be continued as an unknown request',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const {service}=await fixture(t,{analyze:async()=>{await gate;throw Object.assign(new Error('超时'),{code:'NETWORK_TIMEOUT'});}});
  t.after(()=>release());
  const p=await service.create({title:'测试',novel:'雨夜，林晚回到车站。',duration:30});
  await service.analyze(p.id);
  const live=await waitFor(service,p.id,p=>p.jobs[0]?.status==='running');
  await assert.rejects(service.retryAnalysis(p.id,live.jobs[0].id,{confirmDuplicateCost:true}),e=>e.code==='CANNOT_RESUME');
  release();
});

test('failed analysis keeps the safe chunk error visible for recovery', async t => {
  const { service } = await fixture(t, {
    analyze: async () => { throw Object.assign(new Error('第 5/11 块分析未通过校验，原稿已保留。'), { code: 'ANALYSIS_INVALID', safe: true, definitive: true }); },
  });
  const project = await service.create({ title: '分块失败', novel: '一段正文。' });
  await service.analyze(project.id);
  const failed = await waitFor(service, project.id, item => item.jobs[0]?.status === 'failed');
  assert.equal(failed.jobs[0].error, '第 5/11 块分析未通过校验，原稿已保留。');
});

test('legacy episode budget failure can resume without discarding the project', async t => {
  let calls = 0;
  const { service } = await fixture(t, {
    analyze: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('第 55 集规划了 240 秒，不能超过约 200 秒；请拆成更短片段。'), { code: 'ANALYSIS_INVALID' });
      return { ...structuredClone(SAMPLE_ANALYSIS), analysisWarnings: [{ episodeNumber: 55, totalDuration: 240, maximumDuration: 200, message: '第 55 集规划了 240 秒，超过约 200 秒的建议上限；已保留完整内容。' }] };
    },
  });
  const project = await service.create({ title: '旧时长失败', novel: '完整剧本正文。', duration: 30 });
  await service.analyze(project.id);
  const failed = await waitFor(service, project.id, item => item.jobs[0]?.status === 'failed');
  assert.equal(failed.jobs[0].analysisRetryable, true);
  await service.retryAnalysis(project.id, failed.jobs[0].id, { confirmDuplicateCost: true });
  const completed = await waitFor(service, project.id, item => item.jobs.at(-1)?.status === 'completed');
  assert.equal(calls, 2);
  assert.equal(completed.jobs.length, 2);
  assert.equal(completed.segments.length, SAMPLE_ANALYSIS.segments.length);
  assert.equal(completed.analysisWarnings?.[0]?.totalDuration, 240);
});

test('deterministic analysis validation failure retries the current block automatically', async t => {
  let calls = 0;
  const attempts = [];
  const { service } = await fixture(t, {
    analyze: async (_project, _businessId, options) => {
      calls++;
      attempts.push(options);
      if (calls === 1) throw Object.assign(new Error('第 5/11 块分析未通过校验，已纠正一次：每个片段必须有 3 到 12 个完整分镜。原稿已保留。'), { code: 'ANALYSIS_INVALID', definitive: true, analysisRetryable: true, analysisChunk: 4, safe: true });
      return structuredClone(SAMPLE_ANALYSIS);
    },
  });
  const project = await service.create({ title: '当前块重试', novel: '一段正文。' });
  await service.analyze(project.id);
  const completed = await waitFor(service, project.id, item => item.jobs[0]?.status === 'completed');
  assert.equal(calls, 2);
  assert.equal(attempts[1].retryDeterministic, true);
  assert.ok(completed.segments.length);
});

test('initial analysis can retry a failed block after publishing a partial checkpoint', async t => {
  let calls = 0;
  const { service } = await fixture(t, {
    analyze: async (_project, _businessId, options) => {
      calls += 1;
      const partial = structuredClone(SAMPLE_ANALYSIS);
      partial.segments = partial.segments.slice(0, 1);
      await options.onProgress({ completedChunks: 1, totalChunks: 3, phase: 'analyzing', model: 'qwen3.7-plus', readyThroughChunk: 1, readySegmentCount: 1, partialAnalysis: partial });
      if (calls <= 4) throw Object.assign(new Error('第 2 块分析未通过校验，原稿已保留。'), { code: 'ANALYSIS_INVALID', definitive: true, analysisRetryable: true, analysisChunk: 1, safe: true });
      return structuredClone(SAMPLE_ANALYSIS);
    },
  });
  const project = await service.create({ title: '初次部分恢复', novel: '一段正文。' });
  await service.analyze(project.id);
  const failed = await waitFor(service, project.id, item => item.jobs[0]?.status === 'failed');
  assert.ok(failed.segments.length, 'the safe checkpoint should remain available');
  await service.retryAnalysis(project.id, failed.jobs[0].id, { confirmDuplicateCost: true });
  const completed = await waitFor(service, project.id, item => item.jobs.at(-1)?.status === 'completed');
  assert.equal(calls, 5);
  assert.equal(completed.segments.length, SAMPLE_ANALYSIS.segments.length);
});

test('failed append analysis can retry only its new block without discarding prior episodes', async t => {
  let calls = 0;
  const { service } = await fixture(t, {
    analyze: async (project, _businessId, options) => {
      calls++;
      if (!options.analysisAppend) return structuredClone(SAMPLE_ANALYSIS);
      if (calls === 2) throw Object.assign(new Error('第 2 块分析未通过校验，原稿已保留。'), { code: 'ANALYSIS_INVALID', definitive: true, analysisRetryable: true, analysisChunk: 1, safe: true });
      return { ...structuredClone(SAMPLE_ANALYSIS), segments: [...project.segments, ...structuredClone(SAMPLE_ANALYSIS.segments)] };
    },
  });
  const project = await service.create({ title: '追加重试', novel: '第一集原稿', duration: 30 });
  await service.analyze(project.id);
  const analyzed = await waitFor(service, project.id, item => item.jobs.at(-1)?.status === 'completed');
  await service.update(project.id, { novel: `${analyzed.novel}\n第二集新增原稿` });
  await service.analyzeAppend(project.id);
  const completed = await waitFor(service, project.id, item => item.jobs.at(-1)?.status === 'completed' && item.segments.length > analyzed.segments.length);
  assert.equal(calls, 3);
  assert.equal(completed.segments.length, analyzed.segments.length + 1);
  assert.equal(completed.segments[0].id, analyzed.segments[0].id);
});

test('analysis publishes only the safe front while later chunks are still running', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, {
    analyze: async (_project, _businessId, options) => {
      const partial = structuredClone(SAMPLE_ANALYSIS);
      partial.segments[0].analysisChunk = 0;
      await options.onProgress({ completedChunks: 4, totalChunks: 8, phase: 'analyzing', model: 'qwen3.7-plus', readyThroughChunk: 1, readySegmentCount: 1, partialAnalysis: partial });
      await gate;
      return structuredClone(SAMPLE_ANALYSIS);
    },
  });
  const project = await service.create({ title: '安全前沿', novel: '一段正文。' });
  await service.analyze(project.id);
  const partial = await waitFor(service, project.id, item => item.analysisReady?.complete === false && item.segments.length === 1);
  assert.equal(partial.analysisReady.readyThroughChunk, 1);
  assert.equal(partial.analysisReady.readySegmentCount, 1);
  release();
  const completed = await waitFor(service, project.id, item => item.jobs[0]?.status === 'completed');
  assert.equal(completed.analysisReady.complete, true);
});

test('analysis can pause and resume from the same job without creating a second task', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { service } = await fixture(t, {
    analyze: async (_project, _businessId) => {
      calls++;
      if (calls === 1) await gate;
      return structuredClone(SAMPLE_ANALYSIS);
    },
  });
  const project = await service.create({ title: '暂停恢复', novel: '一段正文。' });
  await service.analyze(project.id);
  const running = await waitFor(service, project.id, item => item.jobs[0]?.status === 'running');
  await service.pauseAnalysis(project.id, running.jobs[0].id);
  release();
  const paused = await waitFor(service, project.id, item => item.jobs[0]?.status === 'paused');
  assert.match(paused.jobs[0].error, /暂停/);
  await service.resumeJob(project.id, paused.jobs[0].id);
  const completed = await waitFor(service, project.id, item => item.jobs[0]?.status === 'completed');
  assert.equal(calls, 2);
  assert.equal(completed.jobs.length, 1);
});

test('demo remains text only and state survives reopening; structural edits are guarded', async t => {
  const { service, dir, providers } = await fixture(t);
  const p = await service.demo();
  assert.ok(p.characters.length);
  assert.ok(p.characters.every(c => !c.reference && !c.approved));
  assert.ok(p.segments[0].shots.every(s => !s.image && !s.video));
  await assert.rejects(service.update(p.id, { novel: 'overwrite' }), /分析|结构/);
  await assert.rejects(service.update(p.id, { durationMode: 'auto' }), /分析|结构/);
  await service.update(p.id, { title: '新标题' });
  const second = await createService({ dataDir: dir, providers });
  assert.equal((await second.get(p.id)).title, '新标题');
  await second.close();
});

test('scene look creation requires current identity and enforces one look per scene and character',async t=>{
  const {service}=await fixture(t);let p=await service.demo();const cid=p.characters[0].id;
  p=await service.createScene(p.id,{name:'晚宴',description:'换装后'});const scene=p.scenes.at(-1);
  await assert.rejects(service.createLook(p.id,{sceneId:scene.id,characterId:cid,name:'晚礼服',appearance:'红色长裙'}),e=>e.code==='CHARACTER_NOT_APPROVED');
  await service.characterAction(p.id,cid,'upload',{dataUrl:'data:image/png;base64,AA=='});await service.characterAction(p.id,cid,'approve');
  p=await service.createLook(p.id,{sceneId:scene.id,characterId:cid,name:'晚礼服',appearance:'红色长裙'});
  assert.equal(p.looks.at(-1).reference,null);assert.equal(p.looks.at(-1).approved,false);
  await assert.rejects(service.createLook(p.id,{sceneId:scene.id,characterId:cid,name:'重复',appearance:''}),e=>e.code==='LOOK_EXISTS');
  await assert.rejects(service.updateShot(p.id,p.segments[0].shots[0].id,{sceneId:'missing'}),/场景/);
});

test('analysis cannot overwrite manually created scenes or scenes created during its request',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const {service}=await fixture(t,{analyze:async()=>{await pending;return structuredClone(SAMPLE_ANALYSIS);}});
  const manual=await service.create({title:'手工场景',novel:'正文'});await service.createScene(manual.id,{name:'手工设定'});
  await assert.rejects(service.analyze(manual.id),e=>e.code==='ANALYSIS_EXISTS');
  const running=await service.create({title:'分析中',novel:'正文'});await service.analyze(running.id);
  await assert.rejects(service.createScene(running.id,{name:'并发新增'}),e=>e.code==='ACTIVE_JOB');
  release();await waitFor(service,running.id,p=>p.jobs[0]?.status==='completed');
});

test('look and scene edits invalidate only matching scene shots; identity edits invalidate all its looks',async t=>{
  const {service}=await fixture(t);let p=await approved(service);const cid=p.characters[0].id;
  p=await service.createScene(p.id,{name:'晚宴'});const scene=p.scenes.at(-1);
  p=await service.createLook(p.id,{sceneId:scene.id,characterId:cid,name:'晚礼服',appearance:'红裙'});const look=p.looks.at(-1);
  const sid=p.segments[0].shots.find(s=>s.characterIds.length===1&&s.characterIds[0]===cid).id;
  await service.updateShot(p.id,sid,{sceneId:scene.id});
  await service.lookAction(p.id,look.id,'upload',{dataUrl:'data:image/png;base64,AA=='});await service.lookAction(p.id,look.id,'approve');
  const before=await service.get(p.id);const after=await service.updateLook(p.id,look.id,{appearance:'绿色长裙'});
  assert.equal(after.looks.at(-1).referenceVersion,before.looks.at(-1).referenceVersion);assert.equal(after.looks.at(-1).approved,false);
  for(const shot of after.segments[0].shots){const old=before.segments[0].shots.find(s=>s.id===shot.id);if(shot.id===sid)assert.equal(shot.version,old.version+1);else assert.deepEqual(shot,old);}
  const sceneEdit=await service.updateScene(p.id,scene.id,{description:'露台晚宴'});assert.equal(sceneEdit.looks.at(-1).version,after.looks.at(-1).version+1);
  const identityEdit=await service.updateCharacter(p.id,cid,{appearance:'修改身份特征'});
  for(const value of identityEdit.looks){const old=sceneEdit.looks.find(l=>l.id===value.id);if(value.characterId===cid){assert.equal(value.version,old.version+1);assert.equal(value.approved,false);}else assert.deepEqual(value,old);}
});

test('look generation deduplicates and rejects stale completion and stale approvals',async t=>{
  let release,calls=0;const pending=new Promise(resolve=>{release=resolve;});
  const {service}=await fixture(t,{generateLook:async p=>{calls++;await pending;return `/media/${p.id}/new-look.png`;}});
  const p=await approved(service),look=p.looks[0];
  await service.lookAction(p.id,look.id,'generate',{expectedVersion:look.version});
  await waitFor(service,p.id,x=>x.jobs[0]?.status==='running');
  await service.lookAction(p.id,look.id,'generate',{expectedVersion:look.version});assert.equal(calls,1);
  await assert.rejects(service.lookAction(p.id,look.id,'approve',{reviewedVersion:look.version}),e=>e.code==='ACTIVE_JOB');
  await service.updateLook(p.id,look.id,{appearance:'不同场景服装'});release();
  const next=await waitFor(service,p.id,x=>x.jobs[0]?.status==='interrupted');assert.equal(next.looks[0].reference,look.reference);assert.equal(next.looks[0].approved,false);
  await assert.rejects(service.lookAction(p.id,look.id,'approve',{reviewedVersion:look.version}),e=>e.code==='STALE_INPUT');
  await assert.rejects(service.lookAction(p.id,look.id,'approve',{reviewedVersion:next.looks[0].version}),e=>e.code==='STALE_ASSET');
});

test('legacy migration preserves images and tasks but creates unapproved looks and blocks old image approval',async t=>{
  const {service,dir,providers}=await fixture(t);const p=await approved(service);await service.close();
  delete p.workflowVersion;delete p.scenes;delete p.looks;for(const shot of p.segments[0].shots)delete shot.sceneId;
  p.exports=[{id:'old-export',segmentId:p.segments[0].id,number:1,videoUrl:`/media/${p.id}/old.mp4`}];
  p.aspectRatio='16:9';p.jobs.push({id:'old-image',kind:'image',targetId:p.segments[0].shots[0].id,status:'running',submissionStarted:true,inputVersion:p.segments[0].shots[0].version,businessId:'accepted-old-request'});
  await writeFile(path.join(dir,`${p.id}.json`),JSON.stringify(p));const reopened=await createService({dataDir:dir,providers});
  try{
    const next=await reopened.get(p.id);assert.equal(next.workflowVersion,2);assert.equal(next.aspectRatio,'16:9');assert.equal(next.scenes.length,1);
    assert.deepEqual(next.exports,[]);assert.deepEqual(next.legacyExports,p.exports);
    assert.ok(next.looks.every(l=>!l.reference&&!l.approved));assert.equal(next.jobs.at(-1).status,'interrupted');
    for(const [i,shot]of next.segments[0].shots.entries()){assert.equal(shot.image,p.segments[0].shots[i].image);assert.equal(shot.version,p.segments[0].shots[i].version+1);assert.equal(shot.approved,false);assert.equal(shot.videoVersion,null);}
    const sid=next.segments[0].shots.find(s=>s.characterIds.length===0).id;
    await assert.rejects(reopened.shotAction(p.id,sid,'approve'),e=>e.code==='STALE_ASSET');
    await reopened.close();const again=await createService({dataDir:dir,providers});try{assert.equal((await again.get(p.id)).segments[0].shots[0].version,next.segments[0].shots[0].version);}finally{await again.close();}
  }finally{await reopened.close();}
});

test('look unknown results recover from the existing receipt without another paid submission',async t=>{
  let submissions=0,recoveries=0;
  const {service}=await fixture(t,{generateLook:async()=>{submissions++;throw new Error('响应丢失');},recoverImage:async p=>{recoveries++;return `/media/${p.id}/recovered-look.png`;}});
  const p=await approved(service),look=p.looks[0];
  await service.lookAction(p.id,look.id,'generate');let next=await waitFor(service,p.id,x=>x.jobs[0]?.status==='unknown');
  await service.lookAction(p.id,look.id,'generate');assert.equal(submissions,1);assert.equal((await service.get(p.id)).jobs.length,1);
  await service.resumeJob(p.id,next.jobs[0].id);next=await waitFor(service,p.id,x=>x.jobs[0]?.status==='completed');
  const current=next.looks[0];assert.equal(recoveries,1);assert.equal(submissions,1);assert.equal(current.referenceVersion,current.version);assert.equal(current.approved,false);
  await service.lookAction(p.id,current.id,'generate',{reuseExisting:true,expectedVersion:current.version});assert.equal((await service.get(p.id)).jobs.length,1);
  await assert.rejects(service.lookAction(p.id,current.id,'generate',{expectedVersion:look.version}),e=>e.code==='VERSION_CONFLICT');
});

test('new workflow rejects images and approvals until the selected scene look is current and reviewed',async t=>{
  let generated=0;const {service}=await fixture(t,{generateShot:async p=>{generated++;return `/media/${p.id}/shot.png`;}});
  let p=await service.demo();const cid=p.characters[0].id,shot=p.segments[0].shots.find(s=>s.characterIds.length===1&&s.characterIds[0]===cid);
  await service.characterAction(p.id,cid,'upload',{dataUrl:'data:image/png;base64,AA=='});await service.characterAction(p.id,cid,'approve');
  await assert.rejects(service.shotAction(p.id,shot.id,'generate'),e=>e.code==='LOOK_NOT_APPROVED');
  const look=p.looks.find(l=>l.characterId===cid);await service.lookAction(p.id,look.id,'upload',{dataUrl:'data:image/png;base64,AA=='});
  await assert.rejects(service.shotAction(p.id,shot.id,'generate'),e=>e.code==='LOOK_NOT_APPROVED');
  await service.lookAction(p.id,look.id,'approve');await service.shotAction(p.id,shot.id,'generate');
  p=await waitFor(service,p.id,x=>x.jobs[0]?.status==='completed');assert.equal(generated,1);
  await service.shotAction(p.id,shot.id,'approve');await service.updateLook(p.id,look.id,{appearance:'换装'});
  await service.lookAction(p.id,look.id,'upload',{dataUrl:'data:image/png;base64,AA=='});await service.lookAction(p.id,look.id,'approve');
  await assert.rejects(service.shotAction(p.id,shot.id,'approve'),e=>e.code==='STALE_ASSET');
  assert.equal(generated,1);
});

test('duration mode is editable before analysis and persisted as a project setting', async t => {
  const { service } = await fixture(t);
  const p = await service.create({ title: '待分析', novel: '正文' });
  assert.equal(p.durationMode, 'fixed');
  const updated = await service.update(p.id, { durationMode: 'auto' });
  assert.equal(updated.durationMode, 'auto');
  assert.equal((await service.get(p.id)).durationMode, 'auto');
  const landscape = await service.update(p.id, { aspectRatio: '16:9' });
  assert.equal(landscape.aspectRatio, '16:9');
  assert.equal((await service.get(p.id)).aspectRatio, '16:9');
});

test('visual media style is persisted before analysis and locked with other structural settings', async t => {
  const { service } = await fixture(t);
  const p = await service.create({ title: '动画项目', novel: '正文', visualStyle: '2d-animation' });
  assert.equal(p.visualStyle, '2d-animation');
  const updated = await service.update(p.id, { visualStyle: '3d-animation' });
  assert.equal(updated.visualStyle, '3d-animation');
  const analyzed = await service.demo();
  assert.equal(analyzed.visualStyle, 'photorealistic');
  await assert.rejects(service.update(analyzed.id, { visualStyle: '2d-animation' }), error => error.code === 'STRUCTURE_LOCKED');
});

test('reset duration clears the current derived plan while preserving source and media history', async t => {
  const { service } = await fixture(t);
  let project = await service.demo();
  await service.characterAction(project.id, project.characters[0].id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  project = await service.get(project.id);
  assert.ok(project.mediaHistory.length >= 1);
  const reset = await service.resetDuration(project.id, { duration: 15, durationMode: 'fixed' });
  assert.equal(reset.duration, 15);
  assert.equal(reset.durationMode, 'fixed');
  assert.equal(reset.novel, project.novel);
  assert.deepEqual(reset.characters, []);
  assert.deepEqual(reset.scenes, []);
  assert.deepEqual(reset.looks, []);
  assert.deepEqual(reset.segments, []);
  assert.deepEqual(reset.exports, []);
  assert.ok(reset.mediaHistory.length >= 1);
});

test('duration reset archives legacy current export pointers before clearing them', async t => {
  const { service, dir, providers } = await fixture(t);
  const project = await service.demo();
  await service.close();
  const legacyRecord = { id: 'legacy-project-export', projectExport: true, segmentId: '', number: 0, videoUrl: `/media/${project.id}/legacy.mp4`, createdAt: '2026-10-01T00:00:00.000Z' };
  project.projectExports = [legacyRecord];
  project.exports = [];
  delete project.exportHistory;
  await writeFile(path.join(dir, `${project.id}.json`), JSON.stringify(project));
  const reopened = await createService({ dataDir: dir, providers });
  try {
    const reset = await reopened.resetDuration(project.id, { duration: 15 });
    assert.deepEqual(reset.projectExports, []);
    assert.deepEqual((await reopened.history()).map(record => record.id), [legacyRecord.id]);
  } finally { await reopened.close(); }
});

test('reset duration rejects queued analysis tasks before changing the plan', async t => {
  const { service } = await fixture(t);
  const project = await service.create({ title: '活动分析', novel: '第1集：正文', duration: 30 });
  await service.analyze(project.id);
  await assert.rejects(service.resetDuration(project.id, { duration: 15 }), error => error.code === 'ACTIVE_JOB');
  const unchanged = await service.get(project.id);
  assert.equal(unchanged.duration, 30);
  assert.equal(unchanged.jobs.length, 1);
});

test('a segment-board scene can be explicitly promoted to thirty seconds for the 2.5 model', async t => {
  const { service } = await fixture(t, {
    analyze: async () => {
      const result = structuredClone(SAMPLE_ANALYSIS);
      result.segments[0].duration = 15;
      result.segments[0].shots = result.segments[0].shots.map(shot => ({ ...shot, duration: shot.duration / 2 }));
      return result;
    },
  });
  const project = await service.create({ title: '连续场景扩展', novel: '一段足够长的连续剧情。', generationMode: 'segment-board', duration: 15, durationMode: 'auto' });
  await service.analyze(project.id);
  const analyzed = await waitFor(service, project.id, item => item.jobs.at(-1)?.status === 'completed');
  const segment = analyzed.segments[0];
  const extended = await service.updateSegment(project.id, segment.id, { duration: 30 });
  assert.equal(extended.segments[0].duration, 30);
  assert.equal(extended.segments[0].extendedDuration, true);
  assert.equal(Number(extended.segments[0].shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(1)), 30);
  assert.equal(extended.segments[0].shots.every(shot => shot.approved === false), true);
  const restored = await service.updateSegment(project.id, segment.id, { duration: 15 });
  assert.equal(restored.segments[0].duration, 15);
  assert.equal(restored.segments[0].extendedDuration, false);
  assert.equal(Number(restored.segments[0].shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(1)), 15);
});

test('board template preferences survive reload without changing approvals, versions, shots or export history',async t=>{
  const {service,dir,providers}=await fixture(t);const p=await approved(service),segment=p.segments[0];
  assert.equal(segment.boardTemplateId,'classic-nine');
  const next=await service.updateSegment(p.id,segment.id,{boardTemplateId:'eight-one'});
  assert.equal(next.segments[0].boardTemplateId,'eight-one');assert.deepEqual(next.segments[0].shots,segment.shots);
  assert.deepEqual(next.characters,p.characters);assert.deepEqual(next.looks,p.looks);assert.deepEqual(next.jobs,p.jobs);assert.deepEqual(next.exports,p.exports);
  await assert.rejects(service.updateSegment(p.id,segment.id,{boardTemplateId:'unknown'}),e=>e.code==='INVALID_INPUT');
  await assert.rejects(service.updateSegment(p.id,segment.id,{boardTemplateId:'three-three',duration:15}),e=>e.code==='INVALID_INPUT');
  await assert.rejects(service.updateSegment(p.id,segment.id,{}),e=>e.code==='INVALID_INPUT');
  await service.close();const reopened=await createService({dataDir:dir,providers});
  try{assert.equal((await reopened.get(p.id)).segments[0].boardTemplateId,'eight-one');}finally{await reopened.close();}
});

test('history returns completed exports in reverse creation order with project context', async t => {
  const { service, dir, providers } = await fixture(t);
  const project = await service.create({ title: '历史测试', novel: '正文' });
  await service.close();
  project.segments = [{ id: 'segment-history', number: 1, title: '雨夜', shots: [] }];
  project.exports = [
    { id: 'old-export', segmentId: 'segment-history', number: 1, videoUrl: `/media/${project.id}/old.mp4`, gridUrl: `/media/${project.id}/old.jpg`, manifestUrl: `/media/${project.id}/old.json`, csvUrl: `/media/${project.id}/old.csv`, createdAt: '2026-10-02T00:00:00.000Z' },
    { id: 'new-export', segmentId: 'segment-history', number: 1, videoUrl: `/media/${project.id}/new.mp4`, gridUrl: `/media/${project.id}/new.jpg`, manifestUrl: `/media/${project.id}/new.json`, csvUrl: `/media/${project.id}/new.csv`, createdAt: '2026-10-03T00:00:00.000Z' },
  ];
  await writeFile(path.join(dir, `${project.id}.json`), JSON.stringify(project));
  const reopened = await createService({ dataDir: dir, providers });
  try {
    const records = await reopened.history();
    assert.deepEqual(records.map(record => record.id), ['new-export', 'old-export']);
    assert.equal(records[0].projectId, project.id);
    assert.equal(records[0].projectTitle, '历史测试');
    assert.equal(records[0].segmentTitle, '雨夜');
    assert.equal('dataDir' in records[0], false);
  } finally { await reopened.close(); }
});

test('remove deletes a project record and its private media directory', async t => {
  const { service, dir } = await fixture(t);
  const project = await service.create({ title: '待删除作品', novel: '正文' });
  const mediaDir = path.join(dir, 'media', project.id);
  await mkdir(mediaDir, { recursive: true });
  await writeFile(path.join(mediaDir, 'poster.png'), 'private-media');

  const removed = await service.remove(project.id);

  assert.deepEqual(removed, { id: project.id, title: project.title });
  await assert.rejects(service.get(project.id), error => error.code === 'NOT_FOUND');
  await assert.rejects(readFile(path.join(dir, `${project.id}.json`)), error => error.code === 'ENOENT');
  await assert.rejects(readdir(mediaDir), error => error.code === 'ENOENT');
  assert.deepEqual(await service.list(), []);
});

test('remove refuses projects with an active or unknown task', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, { analyze: async () => { await pending; throw new Error('provider timeout'); } });
  const active = await service.create({ title: '执行中作品', novel: '正文' });
  await service.analyze(active.id);
  await assert.rejects(service.remove(active.id), error => error.code === 'ACTIVE_JOB');
  release();
  let uncertain = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await service.get(active.id)).jobs[0]?.status === 'unknown') { uncertain = true; break; }
    await delay(10);
  }
  assert.equal(uncertain, true);
  await assert.rejects(service.remove(active.id), error => error.code === 'ACTIVE_JOB');
});

test('force remove deletes an active project and ignores a late provider result', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { service, dir } = await fixture(t, {
    analyze: async () => { await pending; return { title: '晚到结果', characters: [], scenes: [], segments: [] }; },
  });
  const project = await service.create({ title: '强制删除作品', novel: '正文' });
  await service.analyze(project.id);

  const removed = await service.remove(project.id, { force: true });
  assert.deepEqual(removed, { id: project.id, title: project.title });
  await assert.rejects(service.get(project.id), error => error.code === 'NOT_FOUND');
  await assert.rejects(readFile(path.join(dir, `${project.id}.json`)), error => error.code === 'ENOENT');

  release();
  await delay(30);
  await assert.rejects(service.get(project.id), error => error.code === 'NOT_FOUND');
  await assert.rejects(readdir(path.join(dir, 'media', project.id)), error => error.code === 'ENOENT');
});

test('force remove validates its explicit boolean confirmation', async t => {
  const { service } = await fixture(t);
  const project = await service.create({ title: '删除参数', novel: '正文' });
  await assert.rejects(service.remove(project.id, { force: 'yes' }), error => error.code === 'INVALID_INPUT');
  await service.remove(project.id, { force: false });
});

test('history retains a completed export after later asset edits invalidate the current export list', async t => {
  const { service, dir, providers } = await fixture(t);
  const project = await service.demo();
  await service.close();
  const record = { id: 'kept-export', segmentId: 'missing-segment', number: 1, videoUrl: `/media/${project.id}/kept.mp4`, gridUrl: `/media/${project.id}/kept.jpg`, manifestUrl: `/media/${project.id}/kept.json`, csvUrl: `/media/${project.id}/kept.csv`, createdAt: '2026-10-03T00:00:00.000Z' };
  project.exports = [record]; project.exportHistory = [record];
  await writeFile(path.join(dir, `${project.id}.json`), JSON.stringify(project));
  const reopened = await createService({ dataDir: dir, providers });
  try {
    await reopened.updateCharacter(project.id, project.characters[0].id, { appearance: '新设定' });
    const records = await reopened.history();
    assert.equal(records[0].id, 'kept-export');
  } finally { await reopened.close(); }
});

test('ledger keeps uploaded and generated image/video assets with account-safe media links', async t => {
  const { service } = await fixture(t);
  const project = await approved(service);
  const shot = project.segments[0].shots[0];
  await service.shotAction(project.id, shot.id, 'video');
  const done = await waitFor(service, project.id, value => value.jobs.some(job => job.kind === 'video' && job.status === 'completed'));
  const records = await service.ledger();
  assert.ok(records.some(record => record.recordType === 'character-image' && record.assetUrl.startsWith(`/media/${project.id}/`)));
  assert.ok(records.some(record => record.recordType === 'look-image' && record.assetUrl.startsWith(`/media/${project.id}/`)));
  const shotImage = records.find(record => record.recordType === 'shot-image' && record.shotId === shot.id);
  const shotVideo = records.find(record => record.recordType === 'shot-video' && record.shotId === shot.id);
  assert.ok(shotImage);
  assert.ok(shotVideo);
  assert.equal(shotImage.sceneId, shot.sceneId);
  assert.equal(shotImage.sceneTitle, project.scenes.find(scene => scene.id === shot.sceneId)?.name);
  assert.equal(shotVideo.sceneId, shot.sceneId);
  assert.ok(records.every(record => !('dataDir' in record) && !('physicalPath' in record)));
  assert.equal(done.segments[0].shots[0].videoVersion, done.segments[0].shots[0].version);
});

test('speaker binding rejection is a definitive failed video job, not an unknown paid request', async t => {
  const { service } = await fixture(t, {
    submitVideo: async () => { throw Object.assign(new Error('请选择台词角色'), { code: 'DIALOGUE_SPEAKER_REQUIRED', safe: true }); },
  });
  const project = await approved(service);
  await service.shotAction(project.id, project.segments[0].shots[0].id, 'video');
  const failed = await waitFor(service, project.id, value => value.jobs.some(job => job.kind === 'video' && job.status === 'failed'));
  const job = failed.jobs.find(item => item.kind === 'video');
  assert.equal(job.error, '请选择台词角色');
  assert.equal(job.status, 'failed');
});

test('generated media history records the Chinese prompt while excluding provider parameters', async t => {
  const { service } = await fixture(t, {
    generateCharacter: async (project, _character, _businessId, options) => {
      await options?.onPrompt?.('中文人物提示词：古风宗门厨房，保持角色身份一致。');
      return `/media/${project.id}/character-prompt.png`;
    },
  });
  const project = await service.demo();
  await service.characterAction(project.id, project.characters[0].id, 'generate');
  await waitFor(service, project.id, value => value.jobs.some(job => job.kind === 'character' && job.status === 'completed'));
  const record = (await service.ledger()).find(item => item.recordType === 'character-image' && item.characterId === project.characters[0].id && item.assetUrl.endsWith('character-prompt.png'));
  assert.equal(record?.prompt, '中文人物提示词：古风宗门厨房，保持角色身份一致。');
  assert.equal('videoModel' in (record ?? {}), false);
  assert.equal('apiKey' in (record ?? {}), false);
});

test('ledger supplements a partially migrated project after its first new media record', async t => {
  const { service, dir, providers } = await fixture(t);
  const project = await service.demo();
  const legacyCharacter = project.characters[0];
  const legacyLook = project.looks[0];
  const legacyShot = project.segments[0].shots[0];
  legacyCharacter.reference = `/media/${project.id}/legacy-character.png`;
  legacyCharacter.referenceVersion = legacyCharacter.version;
  legacyCharacter.approved = true;
  legacyLook.reference = `/media/${project.id}/legacy-look.png`;
  legacyLook.referenceVersion = legacyLook.version;
  legacyLook.approved = true;
  legacyShot.image = `/media/${project.id}/legacy-shot.png`;
  legacyShot.imageVersion = legacyShot.version;
  legacyShot.approved = true;
  legacyShot.video = `/media/${project.id}/legacy-video.mp4`;
  legacyShot.videoVersion = legacyShot.version;
  legacyShot.videoDuration = 2;
  project.mediaHistory = [];
  await service.close();
  await writeFile(path.join(dir, `${project.id}.json`), JSON.stringify(project));
  const reopened = await createService({ dataDir: dir, providers });
  try {
    const newcomer = (await reopened.get(project.id)).characters[1];
    await reopened.characterAction(project.id, newcomer.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
    const records = await reopened.ledger();
    assert.ok(records.some(record => record.assetUrl === legacyCharacter.reference));
    assert.ok(records.some(record => record.assetUrl === legacyLook.reference));
    assert.ok(records.some(record => record.assetUrl === legacyShot.image));
    assert.ok(records.some(record => record.assetUrl === legacyShot.video));
  } finally { await reopened.close(); }
});

test('legacy segment template defaults to classic without changing its reviewed assets',async t=>{
  const {service,dir,providers}=await fixture(t);const p=await approved(service);await service.close();
  delete p.segments[0].boardTemplateId;await writeFile(path.join(dir,`${p.id}.json`),JSON.stringify(p));
  const reopened=await createService({dataDir:dir,providers});
  try{const next=await reopened.get(p.id);assert.equal(next.segments[0].boardTemplateId,'classic-nine');assert.deepEqual(next.segments[0].shots,p.segments[0].shots);assert.deepEqual(next.looks,p.looks);}finally{await reopened.close();}
});

test('preview template override is temporary and every returned page stays inside the project',async t=>{
  const calls=[];let unsafe=false;
  const {service}=await fixture(t,{exportStoryboardPreview:async(p,segment,options)=>{
    calls.push(options);const base=`/media/${p.id}/preview`;
    return {templateId:options.templateId,gridUrl:`${base}/001-01.jpg`,manifestUrl:`${base}/manifest.json`,csvUrl:`${base}/shots.csv`,pages:[{number:1,gridUrl:`${base}/001-01.jpg`},{number:2,gridUrl:unsafe?`/media/${p.id}/%2e%2e/other/002.jpg`:`${base}/001-02.jpg`}]};
  }});
  const p=await approved(service),segment=p.segments[0];await service.updateSegment(p.id,segment.id,{boardTemplateId:'eight-one'});
  const before=await service.get(p.id);
  const preview=await service.previewSegment(p.id,segment.id,{templateId:'three-three'});assert.equal(preview.templateId,'three-three');assert.equal(preview.pages.length,2);
  assert.deepEqual(await service.get(p.id),before);assert.deepEqual(calls[0],{templateId:'three-three'});
  await service.previewSegment(p.id,segment.id);assert.deepEqual(calls[1],{templateId:'eight-one'});
  for(const templateId of ['unknown',null,12])await assert.rejects(service.previewSegment(p.id,segment.id,{templateId}),e=>e.code==='INVALID_INPUT');
  assert.equal(calls.length,2);unsafe=true;
  await assert.rejects(service.previewSegment(p.id,segment.id),e=>e.code==='INVALID_MEDIA');
});

test('template changes are blocked during export and completed exports retain each template snapshot',async t=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});let exports=0;
  const {service}=await fixture(t,{exportSegment:async(p,segment)=>{
    if(++exports===1)await pending;
    const base=`/media/${p.id}/export-${exports}`;
    return {templateId:segment.boardTemplateId,videoUrl:`${base}/001.mp4`,gridUrl:`${base}/001.jpg`,manifestUrl:`${base}/manifest.json`,csvUrl:`${base}/shots.csv`,pages:[{number:1,gridUrl:`${base}/001.jpg`}]};
  }});
  const p=await approved(service),segment=p.segments[0];await service.segmentAction(p.id,segment.id,'generate-videos');
  await waitFor(service,p.id,x=>x.jobs.filter(j=>j.kind==='video'&&j.status==='completed').length===9);
  await service.segmentAction(p.id,segment.id,'export');await waitFor(service,p.id,x=>x.jobs.some(j=>j.kind==='export'&&j.status==='running'));
  await assert.rejects(service.updateSegment(p.id,segment.id,{boardTemplateId:'eight-one'}),e=>e.code==='ACTIVE_JOB');
  release();await waitFor(service,p.id,x=>x.exports.length===1);
  const changed=await service.updateSegment(p.id,segment.id,{boardTemplateId:'eight-one'});assert.equal(changed.exports.length,1);
  await service.segmentAction(p.id,segment.id,'export');const ready=await waitFor(service,p.id,x=>x.exports.length===2);
  assert.deepEqual(ready.exports.map(item=>item.templateId),['classic-nine','eight-one']);
});

test('preview requires all nine images but neither approves shots nor creates a paid task', async t => {
  let snapshot;
  const { service } = await fixture(t, { exportStoryboardPreview: async (p, segment) => {
    snapshot={p,segment};
    return {gridUrl:`/media/${p.id}/preview/001.jpg`,manifestUrl:`/media/${p.id}/preview/manifest.json`,csvUrl:`/media/${p.id}/preview/shots.csv`};
  } });
  const p=await service.demo();const segment=p.segments[0];
  await assert.rejects(service.previewSegment(p.id,segment.id),/9|图片/);
  for(const shot of segment.shots)await service.shotAction(p.id,shot.id,'upload',{dataUrl:'data:image/png;base64,AA=='});
  const before=await service.get(p.id);
  const result=await service.previewSegment(p.id,segment.id);
  assert.equal(result.number,1);assert.equal(result.segmentId,segment.id);
  assert.ok(result.gridUrl.endsWith('001.jpg'));assert.equal(snapshot.segment.shots.length,9);
  assert.ok(snapshot.segment.shots.every(s=>s.approved===false&&s.video===null));
  assert.deepEqual(await service.get(p.id),before);
});

test('explicit review versions are verified atomically without weakening existing approval gates',async t=>{
  const {service}=await fixture(t);
  let p=await service.demo();const cid=p.characters[0].id;
  p=await service.characterAction(p.id,cid,'upload',{dataUrl:'data:image/png;base64,AA=='});
  const version=p.characters[0].version;
  await assert.rejects(service.characterAction(p.id,cid,'approve',{reviewedVersion:version-1}),e=>e.code==='STALE_INPUT');
  p=await service.characterAction(p.id,cid,'approve',{reviewedVersion:version});
  assert.equal(p.characters[0].approved,true);
  const shot=p.segments[0].shots.find(s=>s.characterIds.length===0);
  p=await service.shotAction(p.id,shot.id,'upload',{dataUrl:'data:image/png;base64,AA=='});
  const shotVersion=p.segments[0].shots.find(s=>s.id===shot.id).version;
  await assert.rejects(service.shotAction(p.id,shot.id,'approve',{reviewedVersion:shotVersion-1}),e=>e.code==='STALE_INPUT');
  p=await service.shotAction(p.id,shot.id,'approve',{reviewedVersion:shotVersion});
  assert.equal(p.segments[0].shots.find(s=>s.id===shot.id).approved,true);
});

test('asset stamps support safe reuse while stale expected versions cannot create paid tasks',async t=>{
  let characterCalls=0,imageCalls=0;
  const {service}=await fixture(t,{generateCharacter:async p=>{characterCalls++;return `/media/${p.id}/character-new.png`;},generateShot:async p=>{imageCalls++;return `/media/${p.id}/shot-new.png`;}});
  let p=await service.demo();const cid=p.characters[0].id;
  p=await service.characterAction(p.id,cid,'upload',{dataUrl:'data:image/png;base64,AA=='});
  let c=p.characters[0];assert.equal(c.referenceVersion,c.version);
  p=await service.characterAction(p.id,cid,'generate',{reuseExisting:true,expectedVersion:c.version});
  assert.equal(p.jobs.length,0);assert.equal(characterCalls,0);
  p=await service.updateCharacter(p.id,cid,{appearance:'不同外套'});
  assert.notEqual(p.characters[0].referenceVersion,p.characters[0].version);
  await assert.rejects(service.characterAction(p.id,cid,'generate',{reuseExisting:true,expectedVersion:c.version}),e=>e.code==='VERSION_CONFLICT');
  assert.equal((await service.get(p.id)).jobs.length,0);
  await service.characterAction(p.id,cid,'generate',{reuseExisting:true,expectedVersion:p.characters[0].version});
  p=await waitFor(service,p.id,x=>x.jobs[0]?.status==='completed');c=p.characters[0];
  assert.equal(characterCalls,1);assert.equal(c.referenceVersion,c.version);
  const sid=p.segments[0].shots.find(s=>!s.characterIds.length).id;
  p=await service.shotAction(p.id,sid,'upload',{dataUrl:'data:image/png;base64,AA=='});
  let shot=p.segments[0].shots.find(s=>s.id===sid);assert.equal(shot.imageVersion,shot.version);
  await service.shotAction(p.id,sid,'generate',{reuseExisting:true,expectedVersion:shot.version});
  assert.equal(imageCalls,0);
  p=await service.updateShot(p.id,sid,{action:'雨水落下'});
  await assert.rejects(service.shotAction(p.id,sid,'generate',{reuseExisting:true,expectedVersion:shot.version}),e=>e.code==='VERSION_CONFLICT');
  shot=p.segments[0].shots.find(s=>s.id===sid);assert.notEqual(shot.imageVersion,shot.version);
  await service.shotAction(p.id,sid,'generate',{reuseExisting:true,expectedVersion:shot.version});
  p=await waitFor(service,p.id,x=>x.jobs.some(j=>j.kind==='image'&&j.status==='completed'));
  shot=p.segments[0].shots.find(s=>s.id===sid);
  assert.equal(imageCalls,1);assert.equal(shot.imageVersion,shot.version);
});

test('preview uses a snapshot and refuses unresolved current image replacement',async t=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const {service}=await fixture(t,{generateShot:async p=>{await pending;return `/media/${p.id}/replacement.png`;},exportStoryboardPreview:async p=>({gridUrl:`/media/${p.id}/preview/001.jpg`,manifestUrl:`/media/${p.id}/preview/manifest.json`,csvUrl:`/media/${p.id}/preview/shots.csv`})});
  const p=await approved(service);const segment=p.segments[0];
  await service.shotAction(p.id,segment.shots[0].id,'generate');
  await assert.rejects(service.previewSegment(p.id,segment.id),e=>e.code==='ACTIVE_JOB');
  release();
  await waitFor(service,p.id,x=>x.jobs[0]?.status==='completed');
  assert.ok((await service.previewSegment(p.id,segment.id)).gridUrl.endsWith('001.jpg'));
});

test('character edits revoke dependent shot approval, video validity and exports', async t => {
  const { service } = await fixture(t);
  const p = await approved(service);
  await service.shotAction(p.id, p.segments[0].shots[0].id, 'video');
  const before = await waitFor(service, p.id, x => x.jobs.some(j => j.kind === 'video' && j.status === 'completed'));
  const next = await service.updateCharacter(p.id, p.characters[0].id, { appearance: '红色外套' });
  assert.equal(next.characters[0].approved, false);
  assert.equal(next.characters[0].referenceVersion, before.characters[0].referenceVersion);
  assert.notEqual(next.characters[0].referenceVersion, next.characters[0].version);
  for (const s of next.segments[0].shots) {
    const original = before.segments[0].shots.find(shot => shot.id === s.id);
    if (s.characterIds.includes(p.characters[0].id)) {
      assert.equal(s.approved, false); assert.equal(s.videoVersion, null);
      assert.equal(s.imageVersion, original.imageVersion); assert.notEqual(s.imageVersion, s.version);
    } else assert.deepEqual(s, original);
  }
});

test('double click creates one paid job; business ID is on disk before submission', async t => {
  let fixtureData;
  const fx = await fixture(t, { submitVideo: async (project, shot, businessId) => {
    fx.calls.submit++;
    const disk = JSON.parse(await readFile(path.join(fixtureData.dir, `${project.id}.json`), 'utf8'));
    assert.ok(disk.jobs.some(j => j.businessId === businessId && j.submissionStarted));
    return { id: 'paid-task', status: 'queued' };
  } });
  fixtureData = fx;
  const p = await approved(fx.service); const sid = p.segments[0].shots[0].id;
  await Promise.all([fx.service.shotAction(p.id, sid, 'video'), fx.service.shotAction(p.id, sid, 'video')]);
  const done = await waitFor(fx.service, p.id, x => x.jobs.some(j => j.kind === 'video' && j.status === 'completed'));
  assert.equal(fx.calls.submit, 1);
  assert.equal(done.jobs.filter(j => j.kind === 'video').length, 1);
});

test('a result from before a shot edit cannot restore approval or become current video', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, { pollVideo: async () => { await pending; return { status: 'completed', url: 'https://example.com/old.mp4' }; } });
  const p = await approved(service); const sid = p.segments[0].shots[0].id;
  await service.shotAction(p.id, sid, 'video');
  await waitFor(service, p.id, x => x.jobs.some(j => j.providerTaskId));
  await service.updateShot(p.id, sid, { action: '另一种动作' });
  release();
  const done = await waitFor(service, p.id, x => x.jobs.some(j => j.kind === 'video' && j.status === 'interrupted'));
  assert.equal(done.segments[0].shots[0].video, null);
  assert.equal(done.segments[0].shots[0].approved, false);
});

test('ambiguous submit is unknown; resume queries business ID without another POST', async t => {
  const { service, calls } = await fixture(t, { submitVideo: async () => { calls.submit++; throw new Error('connection lost'); } });
  const p = await approved(service); const sid = p.segments[0].shots[0].id;
  await service.shotAction(p.id, sid, 'video');
  let state = await waitFor(service, p.id, x => x.jobs.some(j => j.status === 'unknown'));
  const job = state.jobs.find(j => j.kind === 'video');
  await service.resumeJob(p.id, job.id);
  state = await waitFor(service, p.id, x => x.jobs.find(j => j.id === job.id).status === 'completed');
  assert.equal(calls.submit, 1);
  assert.ok(state.segments[0].shots[0].video);
});

test('restart queries a persisted task and never repeats paid submission', async t => {
  const { service, dir, providers, calls } = await fixture(t);
  const p = await approved(service);
  await service.close();
  p.jobs.push({ id: 'recovered', kind: 'video', targetId: p.segments[0].shots[0].id, status: 'running', progress: 0, businessId: 'business-old', providerTaskId: 'upstream-old', inputVersion: p.segments[0].shots[0].version, submissionStarted: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await writeFile(path.join(dir, `${p.id}.json`), JSON.stringify(p));
  const recovered = await createService({ dataDir: dir, providers, pollIntervalMs: 1 });
  const result = await waitFor(recovered, p.id, x => x.jobs[0].status === 'completed');
  assert.equal(calls.submit, 0);
  assert.ok(result.segments[0].shots[0].video);
  await recovered.close();
});

test('segment video requires all nine approvals and export never skips missing shots', async t => {
  const { service } = await fixture(t);
  const p = await service.demo();
  await assert.rejects(service.segmentAction(p.id, p.segments[0].id, 'generate-videos'), /审核|定妆/);
  await assert.rejects(service.segmentAction(p.id, p.segments[0].id, 'export'), /视频|审核/);
});

test('trim and duration edits reuse a current video only inside its generated length', async t => {
  const { service, calls } = await fixture(t);
  const p = await approved(service); const sid = p.segments[0].shots[0].id;
  await service.shotAction(p.id, sid, 'video');
  await waitFor(service, p.id, x => x.jobs.some(j => j.kind === 'video' && j.status === 'completed'));
  let state = await service.updateShot(p.id, sid, { trimStart: 0.5 });
  let shot = state.segments[0].shots[0];
  assert.equal(shot.videoDuration, 4);
  assert.equal(shot.videoVersion, shot.version);
  assert.equal(shot.imageVersion, shot.version);
  assert.equal(shot.approved, false);
  await service.shotAction(p.id, sid, 'approve');
  assert.equal(calls.submit, 1);
  state = await service.updateShot(p.id, sid, { trimStart: 1.1 });
  shot = state.segments[0].shots[0];
  assert.equal(shot.videoVersion, null);
});

test('video download leaves audio policy to the provider prompt', async t => {
  let downloadOptions;
  const { service } = await fixture(t, {
    getVideoModel: () => 'MiniMax-H3',
    downloadVideo: async (p, _url, _shot, options) => {
      downloadOptions = options;
      return `/media/${p.id}/video.mp4`;
    },
  });
  const p = await approved(service);
  const shotId = p.segments[0].shots[0].id;
  await service.shotAction(p.id, shotId, 'video');
  await waitFor(service, p.id, x => x.jobs.some(j => j.kind === 'video' && j.status === 'completed'));
  assert.equal(Object.hasOwn(downloadOptions, 'muteAudio'), false);
});

test('a full editor draft reuses the video when only timing actually changed', async t => {
  const { service, calls } = await fixture(t);
  const p = await approved(service); const sid = p.segments[0].shots[0].id;
  await service.shotAction(p.id, sid, 'video');
  const ready = await waitFor(service, p.id, x => x.jobs[0]?.status === 'completed');
  const shot = ready.segments[0].shots[0];
  const fullDraft = Object.fromEntries(['scene', 'action', 'camera', 'dialogue', 'characterIds', 'duration', 'trimStart'].map(key => [key, shot[key]]));
  fullDraft.trimStart = 0.5;
  const changed = await service.updateShot(p.id, sid, fullDraft);
  const current = changed.segments[0].shots[0];
  assert.equal(current.videoVersion, current.version);
  assert.equal(current.imageVersion, current.version);
  assert.equal(current.video, shot.video);
  assert.equal(current.approved, false);
  assert.equal(calls.submit, 1);
});

test('timing changes do not upgrade an already stale image to the current version',async t=>{
  const {service}=await fixture(t);
  let p=await service.demo();const shot=p.segments[0].shots[0];
  p=await service.shotAction(p.id,shot.id,'upload',{dataUrl:'data:image/png;base64,AA=='});
  const imageVersion=p.segments[0].shots[0].imageVersion;
  await service.updateShot(p.id,shot.id,{action:'与旧图不同的动作'});
  p=await service.updateShot(p.id,shot.id,{trimStart:0.5});
  const edited=p.segments[0].shots[0];
  assert.equal(edited.imageVersion,imageVersion);
  assert.notEqual(edited.imageVersion,edited.version);
});

test('timing changes do not invent an image stamp for legacy assets',async t=>{
  const {service,dir,providers}=await fixture(t);
  const p=await approved(service),shot=p.segments[0].shots[0];
  await service.close();delete shot.imageVersion;
  await writeFile(path.join(dir,`${p.id}.json`),JSON.stringify(p));
  const reopened=await createService({dataDir:dir,providers});
  try{
    const next=await reopened.updateShot(p.id,shot.id,{trimStart:0.5});
    assert.equal(next.segments[0].shots[0].imageVersion,undefined);
    assert.equal(next.segments[0].shots[0].version,shot.version+1);
  }finally{await reopened.close();}
});

test('explicit single-shot regeneration creates a new task while duplicate clicks create only one', async t => {
  const { service, calls } = await fixture(t);
  const p = await approved(service); const sid = p.segments[0].shots[0].id;
  await service.shotAction(p.id, sid, 'video');
  await waitFor(service, p.id, x => x.jobs[0]?.status === 'completed');
  await Promise.all([service.shotAction(p.id, sid, 'video'), service.shotAction(p.id, sid, 'video')]);
  const regenerated = await waitFor(service, p.id, x => x.jobs.filter(j => j.status === 'completed').length === 2);
  assert.equal(regenerated.jobs.length, 2);
  assert.equal(calls.submit, 2);
});

test('deterministic configuration rejection is retryable and does not permanently block work', async t => {
  let configured = false;
  const { service } = await fixture(t, { generateCharacter: async p => {
    if (!configured) throw Object.assign(new Error('请先配置图片模型密钥'), { code: 'NOT_CONFIGURED', definitive: true });
    return `/media/${p.id}/new.png`;
  } });
  const p = await service.demo(); const cid = p.characters[0].id;
  await service.characterAction(p.id, cid, 'generate');
  await waitFor(service, p.id, x => x.jobs.some(j => j.status === 'failed'));
  configured = true;
  await service.characterAction(p.id, cid, 'generate');
  const state = await waitFor(service, p.id, x => x.jobs.some(j => j.status === 'completed'));
  assert.equal(state.jobs.length, 2);
});

test('finite polling window leaves a recoverable unknown task without another submit', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiframe-timeout-'));
  let completed = false, submits = 0;
  const service = await createService({ dataDir: dir, pollIntervalMs: 1, pollTimeoutMs: 20, providers: {
    importImage: async p => `/media/${p.id}/image.png`,
    submitVideo: async () => { submits++; return { id: 'slow-job', status: 'queued' }; },
    pollVideo: async () => completed ? { status: 'completed', url: 'https://example.com/done.mp4' } : { status: 'in_progress', progress: 10 },
    downloadVideo: async p => `/media/${p.id}/video.mp4`,
  } });
  t.after(async () => { await service.close(); await rm(dir, { recursive: true, force: true }); });
  const p = await approved(service);
  await service.shotAction(p.id, p.segments[0].shots[0].id, 'video');
  const timeout = await waitFor(service, p.id, x => x.jobs.some(j => j.status === 'unknown'));
  assert.match(timeout.jobs[0].error, /查询|等待/);
  completed = true;
  await service.resumeJob(p.id, timeout.jobs[0].id);
  await waitFor(service, p.id, x => x.jobs[0].status === 'completed');
  assert.equal(submits, 1);
});

test('image recovery reads a saved provider receipt without repeating generation', async t => {
  let submissions = 0, recovered = 0;
  const { service } = await fixture(t, {
    generateCharacter: async () => { submissions++; throw new Error('图片下载未完成'); },
    recoverImage: async p => { recovered++; return `/media/${p.id}/recovered.png`; },
  });
  const p = await service.demo(); const cid = p.characters[0].id;
  await service.characterAction(p.id, cid, 'generate');
  const pending = await waitFor(service, p.id, x => x.jobs[0]?.status === 'unknown');
  await service.resumeJob(p.id, pending.jobs[0].id);
  const done = await waitFor(service, p.id, x => x.jobs[0]?.status === 'completed');
  assert.equal(submissions, 1); assert.equal(recovered, 1);
  assert.match(done.characters[0].reference, /recovered/);
  assert.equal(done.characters[0].approved, false);
});

test('manually replacing an unknown old image permits approval of the new version', async t => {
  const { service } = await fixture(t, { generateCharacter: async () => { throw new Error('请求结果不明确'); } });
  const p = await service.demo(); const cid = p.characters[0].id;
  await service.characterAction(p.id, cid, 'generate');
  await waitFor(service, p.id, x => x.jobs[0]?.status === 'unknown');
  await service.characterAction(p.id, cid, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  const done = await service.characterAction(p.id, cid, 'approve');
  assert.equal(done.characters[0].approved, true);
  assert.equal(done.jobs[0].status, 'unknown');
});

test('parallel segment generation exports nine current shots in stable order', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let executing = 0, maxExecuting = 0, exported;
  const { service, calls } = await fixture(t, {
    submitVideo: async () => { calls.submit++; executing++; maxExecuting = Math.max(maxExecuting, executing); return { id: `task-${calls.submit}`, status: 'queued' }; },
    pollVideo: async () => { await gate; executing--; return { status: 'completed', url: 'https://example.com/video.mp4' }; },
    exportSegment: async (p, segment) => { exported = segment.shots.map(s => [s.number, s.videoVersion === s.version]); return { videoUrl: `/media/${p.id}/export/001.mp4`, gridUrl: `/media/${p.id}/export/grid.png`, manifestUrl: `/media/${p.id}/export/manifest.json`, csvUrl: `/media/${p.id}/export/shots.csv` }; },
  });
  const p = await approved(service); const segid = p.segments[0].id;
  await Promise.all([service.segmentAction(p.id, segid, 'generate-videos'), service.segmentAction(p.id, segid, 'generate-videos')]);
  try {
    await waitFor(service, p.id, () => calls.submit === 9);
    assert.equal(maxExecuting, 9);
  } finally { release(); }
  await waitFor(service, p.id, x => x.jobs.filter(j => j.kind === 'video' && j.status === 'completed').length === 9);
  await service.segmentAction(p.id, segid, 'export');
  const done = await waitFor(service, p.id, x => x.exports.length === 1);
  assert.equal(calls.submit, 9); assert.equal(maxExecuting, 9);
  assert.deepEqual(exported, Array.from({ length: 9 }, (_, i) => [i + 1, true]));
  assert.match(done.exports[0].videoUrl, /001\.mp4$/);
});

test('image and video jobs bypass running analyses while different projects analyze concurrently', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const analyzed = [];
  const { service, calls } = await fixture(t, {
    analyze: async project => {
      analyzed.push(project.id);
      await gate;
      return structuredClone(SAMPLE_ANALYSIS);
    },
  });
  const videoProject = await approved(service);
  const imageProject = await service.demo();
  const first = await service.create({ title: '先分析', novel: '雨夜，林晚回到车站。' });
  const second = await service.create({ title: '后分析', novel: '顾川在门口等待。' });
  try {
    await service.analyze(first.id);
    await waitFor(service, first.id, () => analyzed.length === 1);
    await service.analyze(second.id);
    await waitFor(service, first.id, () => analyzed.length === 2);
    await service.characterAction(imageProject.id, imageProject.characters[0].id, 'generate');
    await service.shotAction(videoProject.id, videoProject.segments[0].shots[0].id, 'video');
    await waitFor(service, imageProject.id, p => p.jobs.some(job => job.kind === 'character' && job.status === 'completed'));
    await waitFor(service, videoProject.id, p => p.jobs.some(job => job.kind === 'video' && job.status === 'completed'));
    assert.equal(calls.submit, 1);
    assert.deepEqual(analyzed.slice().sort(), [first.id, second.id].sort());
    assert.equal((await service.get(second.id)).jobs[0].status, 'running');
  } finally { release(); }
  await waitFor(service, second.id, p => p.jobs[0]?.status === 'completed');
  assert.deepEqual(analyzed, [first.id, second.id]);
});

test('a failed query on an accepted provider task stays unknown, preventing a new paid POST', async t => {
  const { service, calls } = await fixture(t, { pollVideo: async () => { throw Object.assign(new Error('查询暂不可用'), { definitive: true }); } });
  const p = await approved(service); const sid = p.segments[0].shots[0].id;
  await service.shotAction(p.id, sid, 'video');
  const state = await waitFor(service, p.id, x => x.jobs[0]?.status === 'unknown');
  await service.shotAction(p.id, sid, 'video');
  assert.equal(calls.submit, 1);
  assert.equal(state.jobs[0].providerTaskId, 'provider-1');
});

test('image provider task id is persisted before the async image wait', async t => {
  let submitted;
  const {service}=await fixture(t,{generateCharacter:async(p,_character,_business,options)=>{
    await options.onSubmitted({id:'image-provider-1',status:'running',progress:12});
    submitted=true;
    return `/media/${p.id}/character.png`;
  }});
  const p=await service.demo();
  await service.characterAction(p.id,p.characters[0].id,'generate');
  const done=await waitFor(service,p.id,x=>x.jobs[0]?.status==='completed');
  assert.equal(submitted,true);
  assert.equal(done.jobs[0].providerTaskId,'image-provider-1');
});

test('definitive image provider rejection is failed instead of an unrecoverable unknown task', async t => {
  const {service}=await fixture(t,{generateCharacter:async()=>{throw Object.assign(new Error('模型服务请求失败（HTTP 400）'),{code:'UPSTREAM_HTTP',definitive:true});}});
  const p=await service.demo();
  await service.characterAction(p.id,p.characters[0].id,'generate');
  const failed=await waitFor(service,p.id,x=>x.jobs[0]?.status==='failed');
  assert.match(failed.jobs[0].error,/HTTP 400/);
});

test('shutdown preserves concurrently started jobs and late responses cannot overwrite reopened state', async t => {
  let release, submissions = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const { service, dir, providers } = await fixture(t, { submitVideo: async () => { submissions++; await pending; return { id: 'accepted-before-close' }; } });
  const p = await approved(service); const [first, second] = p.segments[0].shots;
  await service.shotAction(p.id, first.id, 'video');
  await service.shotAction(p.id, second.id, 'video');
  await waitFor(service, p.id, x => x.jobs.slice(0, 2).every(job => job.submissionStarted));
  const closing = service.close();
  release();
  await closing;
  assert.equal(submissions, 2);
  const disk = JSON.parse(await readFile(path.join(dir, `${p.id}.json`), 'utf8'));
  assert.equal(disk.jobs[0].status, 'running');
  assert.equal(disk.jobs[1].status, 'running');
  const reopened = await createService({ dataDir: dir, providers, pollIntervalMs: 1 });
  await reopened.update(p.id, { title: '关闭后重新打开' });
  const done = await waitFor(reopened, p.id, x => x.jobs.every(j => j.status === 'completed'));
  assert.equal(done.title, '关闭后重新打开');
  assert.equal(submissions, 2);
  await reopened.close();
});

test('a provider response after close has returned cannot overwrite the restarted service', async t => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { service, dir, providers } = await fixture(t, { submitVideo: async () => { await pending; return { id: 'late-old-response' }; } });
  const p = await approved(service);
  await service.shotAction(p.id, p.segments[0].shots[0].id, 'video');
  await waitFor(service, p.id, x => x.jobs[0]?.submissionStarted);
  await service.close();
  const resumed = await createService({ dataDir: dir, providers, pollIntervalMs: 1 });
  await resumed.update(p.id, { title: '新实例已保存' });
  await waitFor(resumed, p.id, x => x.jobs[0]?.status === 'completed');
  release();
  await delay(20);
  const disk = JSON.parse(await readFile(path.join(dir, `${p.id}.json`), 'utf8'));
  assert.equal(disk.title, '新实例已保存');
  assert.equal(disk.jobs[0].status, 'completed');
  assert.notEqual(disk.jobs[0].providerTaskId, 'late-old-response');
  await resumed.close();
});

test('batch actions reuse per-item gates, report skips, and deduplicate active jobs', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, {
    generateCharacter: async p => { await gate; return `/media/${p.id}/character.png`; },
  });
  const project = await service.demo();
  const targets = project.characters.slice(0, 2);
  const request = {
    kind: 'character',
    action: 'generate',
    targetIds: targets.map(character => character.id),
    expectedVersions: Object.fromEntries(targets.map(character => [character.id, character.version])),
  };
  const first = await service.batchAction(project.id, request);
  assert.deepEqual(first.accepted, targets.map(character => character.id));
  assert.equal(first.skipped.length, 0);
  assert.equal(first.createdJobIds.length, 2);

  const duplicate = await service.batchAction(project.id, request);
  assert.equal(duplicate.accepted.length, 0);
  assert.deepEqual(duplicate.skipped.map(item => item.code), ['ACTIVE_JOB', 'ACTIVE_JOB']);
  assert.equal((await service.get(project.id)).jobs.length, 2);

  release();
  const done = await waitFor(service, project.id, value => value.jobs.every(job => job.status === 'completed'));
  const stale = await service.batchAction(project.id, {
    kind: 'character', action: 'approve', targetIds: [targets[0].id], expectedVersions: { [targets[0].id]: targets[0].version },
  });
  assert.equal(stale.accepted.length, 0);
  assert.equal(stale.skipped[0].code, 'STALE_INPUT');

  const currentVersions = Object.fromEntries(done.characters.slice(0, 2).map(character => [character.id, character.version]));
  const approved = await service.batchAction(project.id, {
    kind: 'character', action: 'approve', targetIds: targets.map(character => character.id), expectedVersions: currentVersions,
  });
  assert.deepEqual(approved.accepted, targets.map(character => character.id));
  assert.equal((await service.get(project.id)).characters.slice(0, 2).every(character => character.approved), true);
});

test('image jobs start concurrently without an application queue limit', async t => {
  let release;
  let executing = 0;
  let maxExecuting = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { service } = await fixture(t, {
    generateCharacter: async p => {
      executing++;
      maxExecuting = Math.max(maxExecuting, executing);
      await gate;
      executing--;
      return `/media/${p.id}/character-${maxExecuting}.png`;
    },
  });
  const project = await service.demo();
  const targets = project.characters.slice(0, 2);
  const result = await service.batchAction(project.id, {
    kind: 'character',
    action: 'generate',
    targetIds: targets.map(character => character.id),
    expectedVersions: Object.fromEntries(targets.map(character => [character.id, character.version])),
  });
  assert.equal(result.createdJobIds.length, 2);

  for (let i = 0; i < 100 && maxExecuting < 2; i++) await delay(5);
  assert.equal(maxExecuting, 2);
  release();
  const done = await waitFor(service, project.id, value => value.jobs.filter(job => job.kind === 'character' && job.status === 'completed').length === 2);
  assert.equal(done.jobs.filter(job => job.kind === 'character').length, 2);
});

test('batch shot actions keep scene references and approval gates', async t => {
  const { service } = await fixture(t);
  const project = await service.demo();
  const segment = project.segments[0];
  const shot = segment.shots[1];
  const blocked = await service.batchAction(project.id, {
    kind: 'shot', action: 'generate', targetIds: [shot.id], expectedVersions: { [shot.id]: shot.version },
  });
  assert.equal(blocked.accepted.length, 0);
  assert.equal(blocked.skipped[0].code, 'CHARACTER_NOT_APPROVED');

  for (const character of project.characters) {
    await service.characterAction(project.id, character.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
    await service.characterAction(project.id, character.id, 'approve');
  }
  for (const look of project.looks) {
    await service.lookAction(project.id, look.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
    await service.lookAction(project.id, look.id, 'approve');
  }
  const ready = await service.get(project.id);
  const selected = ready.segments[0].shots.slice(1, 3);
  const generated = await service.batchAction(project.id, {
    kind: 'shot', action: 'generate', targetIds: selected.map(item => item.id),
    expectedVersions: Object.fromEntries(selected.map(item => [item.id, item.version])),
  });
  assert.equal(generated.accepted.length, 2);
  const withImages = await waitFor(service, project.id, value => value.jobs.filter(job => job.kind === 'image' && job.status === 'completed').length === 2);
  for (const item of selected) {
    const current = withImages.segments[0].shots.find(value => value.id === item.id);
    await service.shotAction(project.id, item.id, 'approve', { reviewedVersion: current.version });
  }
  const reviewed = await service.get(project.id);
  const approvedBatch = await service.batchAction(reviewed.id, {
    kind: 'shot', action: 'approve', targetIds: [withImages.segments[0].shots[3].id],
    expectedVersions: { [withImages.segments[0].shots[3].id]: withImages.segments[0].shots[3].version },
  });
  assert.equal(approvedBatch.accepted.length, 0);
  assert.equal(approvedBatch.skipped[0].code, 'MISSING_ASSET');
});

test('batch shot video generation locks the selected model and resolution on every job', async t => {
  const submissions = [];
  const { service } = await fixture(t, {
    getVideoModel: () => 'MiniMax-H3',
    submitVideo: async (_project, _shot, _businessId, model, resolution) => {
      submissions.push({ model, resolution });
      return { id: `video-${submissions.length}`, status: 'queued' };
    },
  });
  const project = await approved(service);
  const selected = project.segments[0].shots.slice(0, 2);
  const result = await service.batchAction(project.id, {
    kind: 'shot',
    action: 'video',
    targetIds: selected.map(shot => shot.id),
    expectedVersions: Object.fromEntries(selected.map(shot => [shot.id, shot.version])),
    videoModel: 'MiniMax-H3-Max',
    videoResolution: '480P',
  });
  assert.equal(result.accepted.length, 2);
  const jobs = result.project.jobs.filter(job => job.kind === 'video');
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every(job => job.videoModel === 'MiniMax-H3-Max' && job.videoResolution === '480P'));
  assert.deepEqual(jobs.map(job => job.estimatedCostCny), selected.map(shot => Math.round(shot.duration * 0.33 * 100) / 100));
  await waitFor(service, project.id, value => value.jobs.filter(job => job.kind === 'video').every(job => job.status === 'completed'));
  assert.deepEqual(submissions, [
    { model: 'MiniMax-H3-Max', resolution: '480P' },
    { model: 'MiniMax-H3-Max', resolution: '480P' },
  ]);
});

test('local archive cleanup requires confirmation, only removes referenced videos, and keeps the ledger marked', async t => {
  const removed = [];
  let committed = 0;
  let rolledBack = 0;
  const { service } = await fixture(t, {
    cleanupVideos: async (_project, urls) => ({
      removed: [...urls],
      commit: async () => { committed++; },
      rollback: async () => { rolledBack++; },
    }),
  });
  const created = await approved(service);
  const shot = created.segments[0].shots[0];
  await service.shotAction(created.id, shot.id, 'video');
  const completed = await waitFor(service, created.id, value => value.jobs.some(job => job.kind === 'video' && job.status === 'completed'));
  const video = completed.segments[0].shots[0].video;
  removed.push(video);
  await assert.rejects(service.cleanupVideos(created.id, { confirm: false, urls: [video] }), error => error.code === 'CLEANUP_CONFIRMATION_REQUIRED');
  await assert.rejects(service.cleanupVideos(created.id, { confirm: true, urls: ['/media/other-project/clip.mp4'] }), error => error.code === 'OUTPUT_CLEANUP_INVALID');
  const cleaned = await service.cleanupVideos(created.id, { confirm: true, urls: [video] });
  assert.equal(committed, 1);
  assert.equal(rolledBack, 0);
  assert.deepEqual(removed, [video]);
  assert.equal(cleaned.segments[0].shots[0].video, null);
  assert.equal(cleaned.segments[0].shots[0].remoteVideoDeleted, true);
  const ledger = await service.ledger();
  assert.equal(ledger.some(record => record.recordType === 'shot-video' && record.remoteDeleted === true && record.assetUrl === ''), true);
});

test('look assets stay scoped to one character and reuse does not create a paid image job', async t => {
  let importCount = 0;
  const { service } = await fixture(t, {
    importImage: async project => `/media/${project.id}/uploaded-${++importCount}.png`,
  });
  let project = await service.demo();
  const [first, second] = project.characters;
  for (const character of project.characters) {
    await service.characterAction(project.id, character.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
    await service.characterAction(project.id, character.id, 'approve');
  }
  const target = project.looks.find(look => look.characterId === first.id);
  assert.ok(target);
  await service.lookAction(project.id, target.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  await service.lookAction(project.id, target.id, 'approve');
  project = await service.get(project.id);

  const firstAssets = await service.lookAssets(project.id, first.id);
  const secondAssets = await service.lookAssets(project.id, second.id);
  assert.ok(firstAssets.some(asset => asset.kind === 'identity'));
  assert.ok(firstAssets.some(asset => asset.kind === 'look'));
  assert.ok(secondAssets.every(asset => asset.characterId === second.id));
  assert.ok(firstAssets.every(asset => asset.characterId === first.id));

  const identity = firstAssets.find(asset => asset.kind === 'identity');
  const before = project.looks.find(look => look.id === target.id);
  const beforeJobCount = project.jobs.length;
  const reused = await service.reuseLook(project.id, target.id, {
    sourceAssetId: identity.id,
    expectedVersion: before.version,
  });
  const next = reused.looks.find(look => look.id === target.id);
  assert.equal(next.reference, identity.reference);
  assert.equal(next.approved, false);
  assert.equal(next.version, before.version + 1);
  assert.equal(next.appearance, identity.appearance);
  assert.equal(reused.jobs.length, beforeJobCount);

  const otherIdentity = secondAssets.find(asset => asset.kind === 'identity');
  await assert.rejects(
    service.reuseLook(project.id, target.id, { sourceAssetId: otherIdentity.id, expectedVersion: next.version }),
    error => error.code === 'LOOK_ASSET_CHARACTER_MISMATCH',
  );
});

test('look asset classification falls back when the model classifier fails', async t => {
  const { service } = await fixture(t, {
    classifyLookAsset: async () => { throw new Error('classifier unavailable'); },
  });
  const project = await service.demo();
  const character = project.characters[0];
  await service.characterAction(project.id, character.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  await service.characterAction(project.id, character.id, 'approve');
  const look = project.looks.find(item => item.characterId === character.id);
  await service.updateLook(project.id, look.id, { name: '杂役服', appearance: '杂役工作服，深色布鞋。' });
  await service.lookAction(project.id, look.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  const assets = await service.lookAssets(project.id, character.id);
  const classified = assets.find(asset => asset.kind === 'look');
  assert.equal(classified.classification.source, 'fallback');
  assert.equal(classified.classification.category, '杂役/工作服');
});

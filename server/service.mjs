import { lstat, mkdir, readdir, readFile, open, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createProject, fail, now, projectInput, onlyFields, validateAnalysis, updateCharacterFields, updateShotFields, invalidateShot, findCharacter, findShot, findSegment, requireCharacters, requireApproved, requireExport, validateSegment, mediaUrl, sceneFields, lookFields, findScene, findLook, requireIdentity, requireCurrentImage, migrateSceneWorkflow } from './domain.mjs';
import { normalizeCharacterAppearance } from './analysis-results.mjs';
import { SAMPLE_INPUT, SAMPLE_ANALYSIS } from './sample.mjs';
import {DEFAULT_BOARD_TEMPLATE_ID,getBoardTemplate} from './board-templates.mjs';
import { estimateVideoCostCny, estimateVideoCostRangeCny, resolveVideoOption } from './video-options.mjs';

const copy = value => structuredClone(value);
const sourceHash = value => createHash('sha256').update(String(value ?? '')).digest('hex');
const active = job => ['queued', 'running'].includes(job.status);
const blocking = job => active(job) || (job.status === 'unknown' && !(job.kind === 'analyze' && job.analysisRetryJobId));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const videoMinimumDuration = model => typeof model === 'string' && /^xiongmao-seedance-2-0-special(?:-|$)/i.test(model) ? 15 : typeof model === 'string' && /^doubao-seedance-1-0-/.test(model) ? 2 : model === 'MiniMax-H3-Max' ? 5 : 4;
// Audio intent is expressed in the provider prompt. The service keeps the
// returned track intact so it does not guess which voices or crowd sounds are
// meaningful after generation.
// Image and video providers accept independent asynchronous submissions. Keep
// them uncapped at the application layer; the provider remains responsible for
// its own quotas and rate limits. Analysis and export stay ordered below.
const parallelKinds = new Set(['character', 'look', 'image', 'storyboard', 'video', 'segment-video']);
function normalizeBoardTemplates(project){
  for(const segment of project.segments){
    if(segment.boardTemplateId===undefined)segment.boardTemplateId=DEFAULT_BOARD_TEMPLATE_ID;
    segment.generationMode ??= project.generationMode ?? 'legacy-shot';
    if(segment.generationMode==='segment-board'){
      segment.shotCount ??= segment.shots.length;
      segment.storyboardImage ??= null;
      segment.storyboardImageVersion ??= null;
      segment.storyboardApproved ??= false;
      segment.video ??= null;
      segment.videoVersion ??= null;
      segment.videoDuration ??= null;
    }
    getBoardTemplate(segment.boardTemplateId);
  }
}
function validateArtifactUrls(artifact,project,withVideo=false){
  const validate=value=>{
    let decoded;try{decoded=decodeURIComponent(value);}catch{fail('媒体提供商返回了无效文件地址','INVALID_MEDIA',502);}
    mediaUrl(value,project);mediaUrl(decoded,project);
  };
  for(const field of [...(withVideo?['videoUrl']:[]),'gridUrl','manifestUrl','csvUrl'])validate(artifact[field]);
  if(artifact.pages!==undefined){
    if(!Array.isArray(artifact.pages)||!artifact.pages.length)fail('媒体提供商返回了无效分页清单','INVALID_MEDIA',502);
    for(const page of artifact.pages)validate(page?.gridUrl);
  }
}

export async function createService({ dataDir, providers, pollIntervalMs = 5000, pollTimeoutMs = 30 * 60 * 1000 }) {
  await mkdir(dataDir, { recursive: true });
  const projects = new Map();
  let lock = Promise.resolve(), closed = false, pumping = false, worker = Promise.resolve();
  const queue = [], queuedKeys = new Set();
  const inFlight = new Set();
  const deletedProjects = new Set();
  function exclusive(fn) { const result = lock.then(fn); lock = result.catch(() => {}); return result; }
  function project(id) {
    const value=projects.get(id) ?? fail('找不到该作品', 'NOT_FOUND', 404);
    for(const character of value.characters??[])character.appearance=normalizeCharacterAppearance(character.appearance??'',character.evidence??'');
    return value;
  }
  async function existingPath(target, { directory = false } = {}) {
    let stat;
    try { stat = await lstat(target); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(target) !== target) fail('项目数据包含不安全路径，无法删除', 'UNSAFE_DATA_PATH', 409);
    return true;
  }
  async function removeFiles(id) {
    const projectFile = path.join(dataDir, `${id}.json`);
    const mediaRoot = path.resolve(dataDir, 'media');
    const mediaDirectory = path.resolve(mediaRoot, id);
    if (!mediaDirectory.startsWith(`${mediaRoot}${path.sep}`)) fail('项目路径无效', 'UNSAFE_DATA_PATH', 409);
    const hasProjectFile = await existingPath(projectFile);
    if (!hasProjectFile) fail('项目文件不存在，无法删除', 'CORRUPT_DATA', 500);
    const hasMedia = await existingPath(mediaDirectory, { directory: true });
    const tombstone = path.join(dataDir, `.deleting-${id}-${randomUUID()}`);
    const tombstoneFile = `${tombstone}.json`;
    const tombstoneMedia = `${tombstone}.media`;
    let movedFile = false;
    let movedMedia = false;
    try {
      await rename(projectFile, tombstoneFile); movedFile = true;
      if (hasMedia) { await rename(mediaDirectory, tombstoneMedia); movedMedia = true; }
      await rm(tombstoneFile, { force: true });
      if (movedMedia) await rm(tombstoneMedia, { recursive: true, force: true });
    } catch (error) {
      if (movedMedia && !(await existingPath(mediaDirectory, { directory: true }).catch(() => false))) await rename(tombstoneMedia, mediaDirectory).catch(() => {});
      if (movedFile && !(await existingPath(projectFile).catch(() => false))) await rename(tombstoneFile, projectFile).catch(() => {});
      throw error;
    }
  }
  async function removeMediaDirectory(id) {
    const mediaRoot = path.resolve(dataDir, 'media');
    const mediaDirectory = path.resolve(mediaRoot, id);
    if (!mediaDirectory.startsWith(`${mediaRoot}${path.sep}`)) fail('项目路径无效', 'UNSAFE_DATA_PATH', 409);
    if (await existingPath(mediaDirectory, { directory: true })) await rm(mediaDirectory, { recursive: true, force: true });
  }
  async function save(p) {
    if(p.exportHistory!==undefined&&!Array.isArray(p.exportHistory))fail('本地作品历史导出结构无效','CORRUPT_DATA',500);
    p.exportHistory ??= [];
    p.projectExports ??= [];
    p.mediaHistory ??= [];
    if(!Array.isArray(p.mediaHistory))fail('本地作品媒体台账结构无效','CORRUPT_DATA',500);
    for(const character of p.characters??[])character.appearance=normalizeCharacterAppearance(character.appearance??'',character.evidence??'');
    normalizeBoardTemplates(p);
    p.updatedAt = now();
    const target = path.join(dataDir, `${p.id}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(p, null, 2), 'utf8'); await handle.sync(); await handle.close(); handle = null; await rename(temporary, target); }
    catch (error) { if (handle) await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
  }
  for (const name of await readdir(dataDir)) {
    if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
    let p;
    try { p = JSON.parse(await readFile(path.join(dataDir, name), 'utf8')); }
    catch { fail('本地作品文件损坏，请保留数据目录并从备份恢复', 'CORRUPT_DATA', 500); }
    if (!p.id || name !== `${p.id}.json` || !Array.isArray(p.jobs) || !Array.isArray(p.segments) || !Array.isArray(p.characters) || !Array.isArray(p.exports) || (p.projectExports!==undefined&&!Array.isArray(p.projectExports)) || (p.exportHistory!==undefined&&!Array.isArray(p.exportHistory)) || (p.mediaHistory!==undefined&&!Array.isArray(p.mediaHistory))) fail('本地作品结构无效', 'CORRUPT_DATA', 500);
    p.exportHistory ??= [];
    p.projectExports ??= [];
    p.mediaHistory ??= [];
    p.durationMode ??= 'fixed';
    p.generationMode ??= 'legacy-shot';
    p.sourceType ??= 'auto';
    p.narrativeMode ??= 'auto';
    if (!['photorealistic', '2d-animation', '3d-animation'].includes(p.visualStyle)) p.visualStyle = 'photorealistic';
    const migratedSourceLength = Number.isInteger(p.analysisSourceLength) && p.analysisSourceLength >= 0 && p.analysisSourceLength <= p.novel.length
      ? p.analysisSourceLength
      : (p.segments.length ? p.novel.length : 0);
    const migratedSourceHash = typeof p.analysisSourceHash === 'string' && /^[a-f0-9]{64}$/.test(p.analysisSourceHash)
      ? p.analysisSourceHash
      : (p.segments.length ? sourceHash(p.novel.slice(0, migratedSourceLength)) : null);
    const analysisSourceChanged = p.analysisSourceLength !== migratedSourceLength || p.analysisSourceHash !== migratedSourceHash;
    p.analysisSourceLength = migratedSourceLength;
    p.analysisSourceHash = migratedSourceHash;
    normalizeBoardTemplates(p);
    const appearanceChanged=(p.characters??[]).some(character=>{
      const normalized=normalizeCharacterAppearance(character.appearance??'',character.evidence??'');
      if(normalized===character.appearance)return false;
      character.appearance=normalized;return true;
    });
    if(migrateSceneWorkflow(p)||appearanceChanged||analysisSourceChanged)await save(p);
    projects.set(p.id, p);
  }
  function version(p, kind, targetId) {
    if (kind === 'character') return findCharacter(p, targetId).version;
    if (kind === 'look') return findLook(p,targetId).version;
    if (kind === 'image' || kind === 'video') return findShot(p, targetId).shot.version;
    if (kind === 'segment-video') {
      const segment = findSegment(p, targetId);
      return JSON.stringify({
        generationMode: segment.generationMode ?? p.generationMode,
        templateId: segment.boardTemplateId ?? DEFAULT_BOARD_TEMPLATE_ID,
        storyboardImageVersion: segment.storyboardImageVersion ?? null,
        duration: segment.duration,
        aspectRatio: p.aspectRatio,
        shots: segment.shots.map(shot => [shot.id, shot.version, shot.imageVersion, shot.approved, shot.duration, shot.trimStart])
      });
    }
    if (kind === 'storyboard') { const segment=findSegment(p,targetId); return JSON.stringify({templateId:segment.boardTemplateId??DEFAULT_BOARD_TEMPLATE_ID,shots:segment.shots.map(s=>[s.id,s.version,s.duration,s.trimStart])}); }
    if (kind === 'export') {
      if (targetId === p.id) return JSON.stringify({project:true,segments:p.segments.map(segment=>[segment.id,segment.boardTemplateId??DEFAULT_BOARD_TEMPLATE_ID,segment.shots.map(s=>[s.id,s.version,s.videoVersion,s.trimStart,s.duration])])});
      const segment=findSegment(p,targetId);return JSON.stringify({templateId:segment.boardTemplateId??DEFAULT_BOARD_TEMPLATE_ID,shots:segment.shots.map(s=>[s.id,s.version,s.videoVersion,s.trimStart,s.duration])});
    }
    const analysisInputs = [p.novel, p.style, p.visualStyle ?? 'photorealistic', p.sourceType ?? 'auto', p.narrativeMode ?? 'auto', p.aspectRatio, p.duration];
    if (p.durationMode === 'auto') analysisInputs.push('auto');
    return createHash('sha256').update(JSON.stringify(analysisInputs)).digest('hex');
  }
  function current(p, job) {
    try { return job.inputVersion === version(p, job.kind, job.targetId); }
    catch (error) { if (error?.code === 'NOT_FOUND') return false; throw error; }
  }
  function blocksCurrent(p, job) { return blocking(job) && current(p, job); }
  function requireCurrentExport(p, segment) {
    requireExport(p, segment);
    if (p.generationMode === 'segment-board' && segment.videoVersion !== version(p, 'segment-video', segment.id)) fail(`片段 ${segment.number} 的完整视频不是当前版本，不能导出`, 'VIDEO_NOT_READY', 409);
  }
  function invalidateExports(p, segmentId) { p.exports = p.exports.filter(e => e.segmentId !== segmentId); }
  function invalidateCharacter(p, c) {
    c.version++; c.approved = false;
    for(const look of p.looks??[])if(look.characterId===c.id){look.version++;look.approved=false;}
    for (const segment of p.segments) for (const shot of segment.shots) if (shot.characterIds.includes(c.id)) { invalidateShot(shot); if(segment.generationMode==='segment-board'){segment.storyboardImageVersion=null;segment.storyboardApproved=false;} invalidateExports(p, segment.id); }
  }
  function invalidateLook(p,look){
    look.version++;look.approved=false;
    for(const segment of p.segments)for(const shot of segment.shots)if(shot.sceneId===look.sceneId&&shot.characterIds.includes(look.characterId)){invalidateShot(shot);if(segment.generationMode==='segment-board'){segment.storyboardImageVersion=null;segment.storyboardApproved=false;}invalidateExports(p,segment.id);}
  }
  function recordMedia(p,record){
    if(!record||typeof record!=='object'||typeof record.assetUrl!=='string')return;
    p.mediaHistory ??=[];
    p.mediaHistory.push({id:randomUUID(),projectId:p.id,projectTitle:p.title,createdAt:now(),...copy(record)});
  }
  function projectVideoReferences(p) {
    const references = new Set();
    for (const segment of p.segments ?? []) {
      if (typeof segment.video === 'string') references.add(segment.video);
      for (const shot of segment.shots ?? []) if (typeof shot.video === 'string') references.add(shot.video);
    }
    for (const record of [...(p.exports ?? []), ...(p.projectExports ?? []), ...(p.exportHistory ?? [])]) {
      if (typeof record?.videoUrl === 'string') references.add(record.videoUrl);
    }
    for (const record of p.mediaHistory ?? []) {
      if (typeof record?.assetUrl === 'string' && String(record.recordType ?? '').includes('video')) references.add(record.assetUrl);
    }
    return references;
  }
  function markVideoReferencesDeleted(p, removed) {
    const matches = value => typeof value === 'string' && removed.has(value);
    for (const segment of p.segments ?? []) {
      if (matches(segment.video)) {
        segment.video = null;
        segment.videoVersion = null;
        segment.videoDuration = null;
        segment.remoteVideoDeleted = true;
      }
      for (const shot of segment.shots ?? []) if (matches(shot.video)) {
        shot.video = null;
        shot.videoVersion = null;
        shot.videoDuration = null;
        shot.remoteVideoDeleted = true;
      }
    }
    for (const record of [...(p.exports ?? []), ...(p.projectExports ?? []), ...(p.exportHistory ?? [])]) {
      if (matches(record?.videoUrl)) {
        record.videoUrl = '';
        record.remoteDeleted = true;
      }
    }
    for (const record of p.mediaHistory ?? []) if (matches(record?.assetUrl)) {
      record.assetUrl = '';
      record.remoteDeleted = true;
    }
  }
  function identityReady(p,characterId){
    requireIdentity(p,characterId);
    if(p.jobs.some(j=>j.kind==='character'&&j.targetId===characterId&&blocksCurrent(p,j)))fail('基础身份参考任务仍在执行或待核实','ACTIVE_JOB',409);
  }
  function shotAssetsReady(p,shot){
    if(p.generationMode==='segment-board')return;
    requireCharacters(p,shot);
    const lookIds=(p.looks??[]).filter(look=>look.sceneId===shot.sceneId&&shot.characterIds.includes(look.characterId)).map(look=>look.id);
    if(p.jobs.some(j=>((j.kind==='character'&&shot.characterIds.includes(j.targetId))||(j.kind==='look'&&lookIds.includes(j.targetId)))&&blocksCurrent(p,j)))fail('当前场景的身份或造型任务仍在执行或待核实','ACTIVE_JOB',409);
  }
  function schedule(id, jid) {
    if (closed) return;
    const key = `${id}/${jid}`;
    const kind = projects.get(id)?.jobs.find(job => job.id === jid)?.kind;
    if (queuedKeys.has(key)) return;
    queuedKeys.add(key);
    const item = { id, jid, key, kind };
    // Media submissions are independent provider requests. Start them right
    // away so an ordered analysis/export job cannot hold back a batch.
    if (parallelKinds.has(kind)) { startQueued(item); return; }
    queue.push(item);
    if (!pumping) { pumping = true; worker = Promise.resolve().then(pump); }
  }
  function addJob(p, kind, targetId, { ignoreJobId, videoModel, videoResolution, analysisAppend = false, analysisBaseLength, analysisBaseHash, analysisBaseSegments } = {}) {
    const existing = p.jobs.find(j => j.id !== ignoreJobId && j.kind === kind && j.targetId === targetId && blocksCurrent(p, j));
    if (existing) return existing;
    let videoSelection = {};
    const configuredVideoModel = videoModel ?? (typeof providers.getVideoModel === 'function' ? providers.getVideoModel() : undefined);
    if (['video', 'segment-video'].includes(kind) && typeof configuredVideoModel === 'string' && configuredVideoModel.trim()) {
      const selected = resolveVideoOption(configuredVideoModel, videoResolution);
      const duration = kind === 'segment-video' ? findSegment(p, targetId).duration : findShot(p, targetId).shot.duration;
      const fixedDuration = selected.minDurationSeconds === selected.maxDurationSeconds;
      if (duration > selected.maxDurationSeconds || (fixedDuration && duration !== selected.minDurationSeconds)) fail(`${selected.label} 单次支持 ${selected.minDurationSeconds} 到 ${selected.maxDurationSeconds} 秒，当前片段为 ${duration} 秒。请切换模型或调整片段时长。`, 'VIDEO_DURATION_UNSUPPORTED', 400);
      videoSelection = {
        videoModel: selected.videoModel,
        videoResolution: selected.videoResolution,
        estimatedCostCny: estimateVideoCostCny(selected.videoModel, selected.videoResolution, duration),
        estimatedCostCnyRange: estimateVideoCostRangeCny(selected.videoModel, selected.videoResolution, duration),
      };
    }
    const job = { id: randomUUID(), kind, targetId, status: 'queued', progress: 0, businessId: randomUUID(), ...videoSelection, ...(analysisAppend ? { analysisAppend: true, analysisBaseLength, analysisBaseHash, analysisBaseSegments } : {}), inputVersion: version(p, kind, targetId), submissionStarted: false, createdAt: now(), updatedAt: now() };
    p.jobs.push(job);
    return job;
  }
  async function jobChange(id, jid, fn) {
    if (closed || deletedProjects.has(id)) return null;
    return exclusive(async () => {
      if (closed || deletedProjects.has(id)) return null;
      const p = project(id), job = p.jobs.find(j => j.id === jid);
      if (!job) return null;
      const result = fn(p, job); job.updatedAt = now(); await save(p); return result;
    });
  }
  function startQueued(item) {
    const task = (async () => {
      try { await run(item.id, item.jid); }
      catch (error) {
        if (!closed && !deletedProjects.has(item.id)) await jobChange(item.id, item.jid, (_p, j) => {
          j.status = j.submissionStarted ? 'unknown' : 'failed';
          j.error = error?.safe && typeof error.message === 'string' && error.message.trim()
            ? error.message.trim().slice(0, 1000)
            : '任务处理失败，状态已保留；请检查配置或恢复查询';
        }).catch(() => {});
      }
      finally {
        queuedKeys.delete(item.key);
        inFlight.delete(task);
        if (deletedProjects.has(item.id)) await removeMediaDirectory(item.id).catch(() => {});
      }
    })();
    inFlight.add(task);
    return task;
  }
  async function pump() {
    try {
      while (!closed && queue.length) {
        const item = queue.shift();
        // Analysis and export jobs retain their existing serial ordering.
        await startQueued(item);
      }
    } finally { pumping = false; }
  }
  async function run(id, jid) {
    const start = await jobChange(id, jid, (p, job) => {
      if (!active(job)) return null;
      if (!current(p, job)) { job.status = 'interrupted'; job.error = '输入已修改，该任务的结果不能用于当前版本'; return null; }
      job.status = 'running'; job.error = undefined;
      return { p: copy(p), job: copy(job) };
    });
    if (!start || closed) return;
    const { p, job } = start;
    try {
      if (job.kind === 'video') { await runVideo(p, job); return; }
      if (job.kind === 'segment-video') { await runSegmentVideo(p, job); return; }
      const recoveringImage = job.submissionStarted && ['character', 'look', 'image', 'storyboard'].includes(job.kind);
      if (job.submissionStarted && job.kind !== 'export' && !recoveringImage) { await jobChange(id, jid, (_p, j) => { j.status = 'unknown'; j.error = '上次请求结果不明确，禁止自动重复提交'; }); return; }
      await jobChange(id, jid, (_p, j) => { j.submissionStarted = true; });
      if (closed) return;
      let result;
      if (recoveringImage) {
        if (typeof providers.recoverImage !== 'function') throw new Error('没有可查询的图片回执，任务保持待核实；不会重新付费提交');
        result = mediaUrl(await providers.recoverImage(p, job.businessId), p);
      }
      else if (job.kind === 'analyze') {
        const analysis = await providers.analyze(p, job.businessId, {
          analysisAppend: Boolean(job.analysisAppend),
          appendFrom: job.analysisBaseLength,
          analysisBaseSegments: job.analysisBaseSegments,
          retryUncertain: Boolean(job.analysisRetryOf && p.jobs.some(previous => previous.id === job.analysisRetryOf && previous.analysisRetryJobId === job.id && previous.analysisRetryAcceptedAt)),
          onProgress: async progress => {
            if (closed) fail('服务正在关闭，已保存分析进度', 'SERVICE_CLOSED', 503);
            return jobChange(id, jid, (_live, liveJob) => {
            if (liveJob.status === 'running') {
              liveJob.progress = progress.totalChunks ? Math.round((progress.completedChunks / progress.totalChunks) * 100) : 0;
              liveJob.analysisProgress = { completedChunks: progress.completedChunks, totalChunks: progress.totalChunks, phase: progress.phase, model: progress.model, ...(Number.isInteger(progress.currentChunk) ? { currentChunk: progress.currentChunk } : {}), ...(Array.isArray(progress.currentEpisodes) ? { currentEpisodes: progress.currentEpisodes } : {}) };
            }
            });
          }
        });
        if (job.analysisAppend) {
          const baseSegments = Number.isInteger(job.analysisBaseSegments) ? job.analysisBaseSegments : 0;
          if (!Array.isArray(analysis?.segments) || analysis.segments.length <= baseSegments) fail('追加分析没有返回新增片段。', 'ANALYSIS_INVALID');
          const appended = validateAnalysis({
            characters: analysis.characters,
            scenes: analysis.scenes,
            looks: analysis.looks,
            segments: analysis.segments.slice(baseSegments),
          }, p);
          const oldCharacterIds = new Set(p.characters.map(character => character.id));
          const oldSceneIds = new Set((p.scenes ?? []).map(scene => scene.id));
          const oldLookIds = new Set((p.looks ?? []).map(look => look.id));
          result = {
            workflowVersion: 2,
            characters: [...p.characters, ...appended.characters.filter(character => !oldCharacterIds.has(character.id))],
            scenes: [...(p.scenes ?? []), ...appended.scenes.filter(scene => !oldSceneIds.has(scene.id))],
            looks: [...(p.looks ?? []), ...appended.looks.filter(look => !oldLookIds.has(look.id))],
            segments: [...p.segments, ...appended.segments.map((segment, index) => ({ ...segment, number: p.segments.length + index + 1 }))],
          };
        } else result = validateAnalysis(analysis, p);
      }
      else if (job.kind === 'character') {
        const imageOptions={async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}};
        result = mediaUrl(await providers.generateCharacter(p, findCharacter(p, job.targetId), job.businessId, imageOptions), p);
      }
      else if(job.kind==='look'){
        const look=findLook(p,job.targetId);identityReady(p,look.characterId);
        const imageOptions={async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}};
        result=mediaUrl(await providers.generateLook(p,look,job.businessId,imageOptions),p);
      }
      else if (job.kind === 'image') {
        const { shot } = findShot(p, job.targetId); shotAssetsReady(p, shot);
        const imageOptions={async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}};
        result = mediaUrl(await providers.generateShot(p, shot, job.businessId, imageOptions), p);
      }
      else if (job.kind === 'storyboard') {
        const segment=findSegment(p,job.targetId);
        if(p.generationMode!=='segment-board') fail('当前作品不是片段级整板模式。','INVALID_INPUT');
        const imageOptions={async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}};
        const generate=job.submissionStarted&&typeof providers.recoverSegmentBoard==='function' ? providers.recoverSegmentBoard : providers.generateSegmentBoard;
        result=await generate(p,segment,job.businessId,imageOptions);
      }
      else if (job.kind === 'export') {
        const projectExport = job.targetId === p.id;
        const segment = projectExport ? null : findSegment(p, job.targetId);
        if (projectExport) {
          for (const item of p.segments) requireCurrentExport(p, item);
          if (typeof providers.exportProject !== 'function') fail('当前服务不支持项目级合成。','PROJECT_EXPORT_UNSUPPORTED',409);
          result = await providers.exportProject(p, p.segments);
        } else {
          requireCurrentExport(p, segment);
          result = await providers.exportSegment(p, segment);
        }
        validateArtifactUrls(result,p,true);
        // The server media tree is the source of truth. Desktop instances may
        // additionally mirror the completed export into their local `output`
        // directory. Keep the server artifact in history when that mirror
        // fails, but mark the export job failed so the missing local copy is
        // visible and recoverable.
        if(typeof providers.copyExport==='function'){
          try{
            const localOutput=await providers.copyExport(p,result);
            if(localOutput)result={...result,localOutput};
          }catch{
            result={...result,localOutput:{status:'failed',error:'本地 output 保存失败；服务器文件仍已保留'}};
          }
        }
      }
      if (closed) return;
      await jobChange(id, jid, (live, j) => {
        if (!current(live, j)) { j.status = 'interrupted'; j.error = '输入已修改，已返回结果不会替换当前素材'; return; }
        if (j.kind === 'analyze') {
          Object.assign(live, result);
          live.analysisSourceLength = live.novel.length;
          live.analysisSourceHash = sourceHash(live.novel);
        }
        else if (j.kind === 'character') { const c = findCharacter(live, j.targetId); invalidateCharacter(live, c); c.reference = result; c.referenceVersion = c.version; recordMedia(live, { recordType: 'character-image', assetUrl: result, assetTitle: `人物身份 · ${c.name}`, segmentTitle: '人物资料', characterId: c.id, characterName: c.name, version: c.version }); }
        else if(j.kind==='look'){const look=findLook(live,j.targetId);invalidateLook(live,look);look.reference=result;look.referenceVersion=look.version;const scene=live.scenes?.find(item=>item.id===look.sceneId);const character=live.characters?.find(item=>item.id===look.characterId);recordMedia(live,{recordType:'look-image',assetUrl:result,assetTitle:`场景造型 · ${look.name}`,segmentTitle:scene?.name||'场景造型',sceneId:look.sceneId,sceneTitle:scene?.name,characterId:look.characterId,characterName:character?.name,version:look.version});}
        else if (j.kind === 'image') { const { shot, segment } = findShot(live, j.targetId); invalidateShot(shot); shot.image = result; shot.imageVersion = shot.version; invalidateExports(live, segment.id); recordMedia(live, { recordType: 'shot-image', assetUrl: result, assetTitle: `镜头 ${String(shot.number).padStart(2,'0')} · 分镜图片`, segmentId: segment.id, segmentTitle: segment.title, sceneId: shot.sceneId, sceneTitle: live.scenes?.find(item => item.id === shot.sceneId)?.name, shotId: shot.id, number: shot.number, version: shot.version }); }
        else if (j.kind === 'storyboard') {
          const segment=findSegment(live,j.targetId);
          if(!result?.storyboardImage||!result?.shotImages||typeof result.shotImages!=='object')throw new Error('整板结果缺少镜头裁切图');
          segment.storyboardImage=result.storyboardImage;
          segment.storyboardImageVersion=j.inputVersion;
          segment.storyboardApproved=false;
          segment.storyboardLayout=result.storyboardLayout;
          segment.shotCount=segment.shots.length;
          for(const shot of segment.shots){
            const cropped=result.shotImages[shot.id];
            if(typeof cropped!=='string')throw new Error('整板结果缺少镜头裁切图');
            invalidateShot(shot);shot.image=cropped;shot.imageVersion=shot.version;shot.approved=false;
            recordMedia(live,{recordType:'shot-image',assetUrl:cropped,assetTitle:`镜头 ${String(shot.number).padStart(2,'0')} · 整板裁切图`,segmentId:segment.id,segmentTitle:segment.title,sceneId:shot.sceneId,sceneTitle:live.scenes?.find(item=>item.id===shot.sceneId)?.name,shotId:shot.id,number:shot.number,version:shot.version});
          }
          segment.storyboardImageVersion=version(live,'storyboard',segment.id);
          recordMedia(live,{recordType:'storyboard-image',assetUrl:result.storyboardImage,assetTitle:`整段分镜板 · ${segment.title}`,segmentId:segment.id,segmentTitle:segment.title,version:segment.storyboardImageVersion});
          invalidateExports(live,segment.id);
        }
        else {
          const projectExport = j.targetId === live.id;
          const segment = projectExport ? null : findSegment(live, j.targetId);
          const record={ id: randomUUID(), segmentId: segment?.id || '', number: projectExport ? 0 : segment.number, projectExport, ...result, createdAt: now() };
          if (projectExport) { live.projectExports ??= []; live.projectExports.push(record); }
          else live.exports.push(record);
          live.exportHistory ??=[];
          live.exportHistory.push(copy(record));
          if(result.localOutput?.status==='failed'){
            j.status='failed';
            j.error=result.localOutput.error||'本地 output 保存失败；服务器文件仍已保留';
          }else{
            j.status='completed';
            j.progress=100;
          }
          return;
        }
        j.status = 'completed'; j.progress = 100;
      });
    } catch (error) {
      if (closed) return;
      await jobChange(id, jid, (_p, j) => {
        const definitive = error.definitive === true || error.safeToRetry === true || ['NOT_CONFIGURED', 'INVALID_INPUT', 'CHARACTER_NOT_APPROVED', 'LOOK_NOT_APPROVED', 'STALE_ASSET', 'ACTIVE_JOB', 'INVALID_MEDIA', 'PROVIDER_REJECTED'].includes(error.code);
        const unresolvedImageRecovery = job.submissionStarted && ['image', 'character', 'look', 'storyboard'].includes(job.kind) && !j.providerTaskId && !definitive;
        const unresolvedVideoQuery = ['video', 'segment-video'].includes(j.kind) && (j.providerTaskId || job.submissionStarted);
        j.status = !unresolvedImageRecovery && !unresolvedVideoQuery && (!j.submissionStarted || j.kind === 'export' || definitive) ? 'failed' : 'unknown';
        if (j.kind === 'analyze' && error.analysisRetryable === true) {
          j.analysisRetryable = true;
          j.analysisChunk = Number.isInteger(error.analysisChunk) ? error.analysisChunk : undefined;
        } else delete j.analysisRetryable;
        j.error = safeError(error, j.status);
      });
    }
  }
  function safeError(error, status) {
    const value = typeof error.message === 'string' ? error.message : '';
    if (value && !/sk-[a-z0-9]|bearer |data:|https?:\/\/|api.?key|token[=:]/i.test(value)) return value.slice(0, 350);
    return status === 'unknown' ? '请求结果不明确，请恢复查询；不会自动重复付费提交' : '任务失败，请检查输入与模型配置';
  }
  async function runVideo(p, job) {
    const { segment, shot } = findShot(p, job.targetId);
    requireApproved(p, segment);
    let taskId = job.providerTaskId;
    if (!job.submissionStarted) {
      await jobChange(p.id, job.id, (_p, j) => { j.submissionStarted = true; });
      if (closed) return;
      const submitted = await providers.submitVideo(p, shot, job.businessId, job.videoModel, job.videoResolution);
      if (closed) return;
      if (!submitted?.id) throw new Error('视频提交响应缺少任务 ID，请恢复查询业务 ID');
      taskId = submitted.id;
      await jobChange(p.id, job.id, (_p, j) => { j.providerTaskId = taskId; j.progress = Math.min(99, Number(submitted.progress) || 0); });
    }
    taskId ||= job.businessId;
    if (!taskId) throw new Error('缺少已持久化任务 ID，禁止重新创建视频');
    let transientFailures = 0;
    const deadline = Date.now() + pollTimeoutMs;
    while (!closed) {
      if (Date.now() >= deadline) throw new Error('本轮查询等待时间已到，任务已保留，请稍后恢复查询');
      let result;
      try { result = await providers.pollVideo(taskId, job.videoModel); transientFailures = 0; }
      catch (error) { if (++transientFailures >= 3 || error.definitive) throw error; await pause(pollIntervalMs); continue; }
      if (closed) return;
      if (result.status === 'completed') {
        if (!result.url) throw new Error('视频完成响应未包含下载地址，请恢复查询');
        const minimumDuration = videoMinimumDuration(job.videoModel);
        const url = mediaUrl(await providers.downloadVideo(p, result.url, shot, { minDuration: minimumDuration }), p);
        if (closed) return;
        await jobChange(p.id, job.id, (live, j) => {
          if (!current(live, j)) { j.status = 'interrupted'; j.error = '分镜已修改，旧视频不可用于当前导出'; return; }
          const { shot: currentShot, segment: currentSegment } = findShot(live, j.targetId);
          requireApproved(live, currentSegment);
          currentShot.video = url; currentShot.videoVersion = currentShot.version;
          currentShot.videoDuration = Math.max(minimumDuration, Math.ceil(shot.duration + shot.trimStart));
          invalidateExports(live, currentSegment.id);
           recordMedia(live,{recordType:'shot-video',assetUrl:url,assetTitle:`镜头 ${String(currentShot.number).padStart(2,'0')} · 镜头视频`,segmentId:currentSegment.id,segmentTitle:currentSegment.title,sceneId:currentShot.sceneId,sceneTitle:live.scenes?.find(item=>item.id===currentShot.sceneId)?.name,shotId:currentShot.id,number:currentShot.number,version:currentShot.version,duration:currentShot.videoDuration});
          j.status = 'completed'; j.progress = 100;
        });
        return;
      }
      if (result.status === 'failed') { await jobChange(p.id, job.id, (_p, j) => { j.status = 'failed'; j.error = safeError(new Error(result.error ?? '视频生成失败'), 'failed'); }); return; }
      if (!['queued', 'in_progress', 'running'].includes(result.status)) throw new Error('无法确认上游任务状态，请稍后恢复查询');
      await jobChange(p.id, job.id, (_p, j) => { j.progress = Math.min(99, Math.max(0, Number(result.progress) || 0)); });
      await pause(pollIntervalMs);
    }
  }
  async function runSegmentVideo(p, job) {
    const segment = findSegment(p, job.targetId);
    if (p.generationMode !== 'segment-board') fail('当前作品不是片段级整板模式。', 'INVALID_INPUT');
    requireApproved(p, segment);
    if (typeof providers.submitSegmentVideo !== 'function') fail('当前服务不支持片段级完整视频生成。', 'VIDEO_PROVIDER_UNSUPPORTED', 409);
    let taskId = job.providerTaskId;
    if (!job.submissionStarted) {
      await jobChange(p.id, job.id, (_p, j) => { j.submissionStarted = true; });
      if (closed) return;
      const submitted = await providers.submitSegmentVideo(p, segment, job.businessId, job.videoModel, job.videoResolution);
      if (closed) return;
      if (!submitted?.id) throw new Error('视频提交响应缺少任务 ID，请恢复查询业务 ID');
      taskId = submitted.id;
      await jobChange(p.id, job.id, (_p, j) => { j.providerTaskId = taskId; j.progress = Math.min(99, Number(submitted.progress) || 0); });
    }
    taskId ||= job.businessId;
    if (!taskId) throw new Error('缺少已持久化任务 ID，禁止重新创建视频');
    let transientFailures = 0;
    const deadline = Date.now() + pollTimeoutMs;
    while (!closed) {
      if (Date.now() >= deadline) throw new Error('本轮查询等待时间已到，任务已保留，请稍后恢复查询');
      let result;
      try { result = await providers.pollVideo(taskId, job.videoModel); transientFailures = 0; }
      catch (error) { if (++transientFailures >= 3 || error.definitive) throw error; await pause(pollIntervalMs); continue; }
      if (closed) return;
      if (result.status === 'completed') {
        if (!result.url) throw new Error('视频完成响应未包含下载地址，请恢复查询');
        const minimumDuration = videoMinimumDuration(job.videoModel);
        const url = mediaUrl(await providers.downloadVideo(p, result.url, { duration: segment.duration, trimStart: 0 }, { minDuration: Math.max(minimumDuration, segment.duration) }), p);
        if (closed) return;
        await jobChange(p.id, job.id, (live, j) => {
          if (!current(live, j)) { j.status = 'interrupted'; j.error = '片段内容已修改，旧视频不可用于当前导出'; return; }
          const currentSegment = findSegment(live, j.targetId);
          requireApproved(live, currentSegment);
          currentSegment.video = url;
          currentSegment.videoVersion = j.inputVersion;
          currentSegment.videoDuration = Math.max(minimumDuration, Number(result.duration) || currentSegment.duration);
          invalidateExports(live, currentSegment.id);
          recordMedia(live, { recordType: 'segment-video', assetUrl: url, assetTitle: `片段 ${String(currentSegment.number).padStart(3, '0')} · 完整视频`, segmentId: currentSegment.id, segmentTitle: currentSegment.title, number: currentSegment.number, version: currentSegment.videoVersion, duration: currentSegment.videoDuration });
          j.status = 'completed'; j.progress = 100;
        });
        return;
      }
      if (result.status === 'failed') { await jobChange(p.id, job.id, (_p, j) => { j.status = 'failed'; j.error = safeError(new Error(result.error ?? '视频生成失败'), 'failed'); }); return; }
      if (!['queued', 'in_progress', 'running'].includes(result.status)) throw new Error('无法确认上游任务状态，请稍后恢复查询');
      await jobChange(p.id, job.id, (_p, j) => { j.progress = Math.min(99, Math.max(0, Number(result.progress) || 0)); });
      await pause(pollIntervalMs);
    }
  }
  async function pause(ms) { const end = Date.now() + ms; while (!closed && Date.now() < end) await sleep(Math.min(100, end - Date.now())); }
  async function mutate(id, fn) {
    if (closed) fail('工作台正在关闭', 'CLOSED', 503);
    return exclusive(async () => { const p = project(id); const backup = copy(p); try { const jobs = await fn(p); await save(p); for (const job of jobs ?? []) schedule(p.id, job.id); return copy(p); } catch (error) { projects.set(id, backup); throw error; } });
  }
  function batchJob(p, kind, targetId, options = {}) {
    const existing = p.jobs.find(job => job.kind === kind && job.targetId === targetId && blocksCurrent(p, job));
    if (existing) fail('该任务正在执行或待核实，未重复提交', 'ACTIVE_JOB', 409);
    return addJob(p, kind, targetId, options);
  }
  function batchFailure(error) {
    return { code: typeof error?.code === 'string' ? error.code : 'INVALID_INPUT', message: error instanceof Error ? error.message : '操作未完成' };
  }
  function expectedVersion(target,body){
    if(body.expectedVersion!==undefined&&body.expectedVersion!==target.version)fail('内容版本已变化，请重新读取当前内容后再操作', 'VERSION_CONFLICT', 409);
  }
  function reviewedVersion(target,body){
    if(body.reviewedVersion!==undefined&&body.reviewedVersion!==target.version)fail('审核内容已变化，请检查当前版本后重新审核', 'STALE_INPUT', 409);
  }
  const service = {
    async list() { return exclusive(() => [...projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => ({
      id: p.id,
      title: p.title,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      segmentCount: p.segments.length,
      characterCount: p.characters.length,
      shotCount: p.segments.reduce((total, segment) => total + segment.shots.length, 0),
      activeJobCount: p.jobs.filter(job => blocksCurrent(p, job)).length,
    }))); },
    async history() {
      return exclusive(() => [...projects.values()].flatMap(p => {
        const records=[];const seen=new Set();
        for(const record of [...(Array.isArray(p.exportHistory)?p.exportHistory:[]),...(Array.isArray(p.exports)?p.exports:[]),...(Array.isArray(p.projectExports)?p.projectExports:[])]){
          if(!record?.id||seen.has(record.id))continue;seen.add(record.id);
          const segment=p.segments.find(item=>item.id===record.segmentId);
          records.push({...copy(record),projectId:p.id,projectTitle:p.title,segmentTitle:record.projectExport?'整个项目':segment?.title||`片段 ${String(record.number).padStart(3,'0')}`});
        }
        return records;
      }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
    },
    async ledger() {
      const records = await this.history();
      return exclusive(() => [...projects.values()].flatMap(p => {
        const assets=Array.isArray(p.mediaHistory)?copy(p.mediaHistory):[];
        const recorded=new Set(assets.map(asset=>`${asset.recordType}\0${asset.assetUrl}`));
        const addCurrent=(asset)=>{
          if(!asset.assetUrl)return;
          const key=`${asset.recordType}\0${asset.assetUrl}`;
          if(recorded.has(key))return;
          recorded.add(key);assets.push(asset);
        };
        // Older projects may have only some media events recorded. Fill those
        // gaps from the current state without suppressing newer history.
         for(const character of p.characters||[])addCurrent({id:`character:${p.id}:${character.id}:${character.version}`,projectId:p.id,projectTitle:p.title,recordType:'character-image',assetUrl:character.reference,assetTitle:`人物身份 · ${character.name}`,segmentTitle:'人物资料',characterId:character.id,characterName:character.name,createdAt:p.updatedAt,version:character.version});
         for(const look of p.looks||[])addCurrent({id:`look:${p.id}:${look.id}:${look.version}`,projectId:p.id,projectTitle:p.title,recordType:'look-image',assetUrl:look.reference,assetTitle:`场景造型 · ${look.name}`,segmentTitle:p.scenes?.find(scene=>scene.id===look.sceneId)?.name||'场景造型',sceneId:look.sceneId,sceneTitle:p.scenes?.find(scene=>scene.id===look.sceneId)?.name,characterId:look.characterId,characterName:p.characters?.find(character=>character.id===look.characterId)?.name,createdAt:p.updatedAt,version:look.version});
        for(const segment of p.segments||[]) {
          addCurrent({id:`storyboard:${p.id}:${segment.id}:${segment.storyboardImageVersion||'unknown'}`,projectId:p.id,projectTitle:p.title,recordType:'storyboard-image',assetUrl:segment.storyboardImage,assetTitle:`整段分镜板 · ${segment.title}`,segmentId:segment.id,segmentTitle:segment.title,createdAt:p.updatedAt,version:segment.storyboardImageVersion});
          addCurrent({id:`segment-video:${p.id}:${segment.id}:${segment.videoVersion||'unknown'}`,projectId:p.id,projectTitle:p.title,recordType:'segment-video',assetUrl:segment.video,assetTitle:`片段 ${String(segment.number).padStart(3,'0')} · 完整视频`,segmentId:segment.id,segmentTitle:segment.title,number:segment.number,createdAt:p.updatedAt,version:segment.videoVersion,duration:segment.videoDuration});
          for(const shot of segment.shots||[]) {
             addCurrent({id:`shot-image:${p.id}:${shot.id}:${shot.imageVersion||shot.version}`,projectId:p.id,projectTitle:p.title,recordType:'shot-image',assetUrl:shot.image,assetTitle:`镜头 ${String(shot.number).padStart(2,'0')} · 分镜图片`,segmentId:segment.id,segmentTitle:segment.title,sceneId:shot.sceneId,sceneTitle:p.scenes?.find(scene=>scene.id===shot.sceneId)?.name,shotId:shot.id,number:shot.number,createdAt:p.updatedAt,version:shot.imageVersion||shot.version});
             addCurrent({id:`shot-video:${p.id}:${shot.id}:${shot.videoVersion||shot.version}`,projectId:p.id,projectTitle:p.title,recordType:'shot-video',assetUrl:shot.video,assetTitle:`镜头 ${String(shot.number).padStart(2,'0')} · 镜头视频`,segmentId:segment.id,segmentTitle:segment.title,sceneId:shot.sceneId,sceneTitle:p.scenes?.find(scene=>scene.id===shot.sceneId)?.name,shotId:shot.id,number:shot.number,createdAt:p.updatedAt,version:shot.videoVersion||shot.version});
          }
        }
        return assets.map(asset=>({...asset,projectId:asset.projectId||p.id,projectTitle:asset.projectTitle||p.title}));
      }).concat(records).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))));
    },
    async exportProject(id) { return mutate(id, p => {
      for (const segment of p.segments) requireCurrentExport(p, segment);
      const existing = p.jobs.find(job => job.kind === 'export' && job.targetId === p.id && blocksCurrent(p, job));
      if (existing) return [existing];
      return [addJob(p, 'export', p.id)];
    }); },
    async get(id) { return exclusive(() => copy(project(id))); },
    async cleanupVideos(id, body = {}) {
      if (closed) fail('工作台正在关闭', 'CLOSED', 503);
      onlyFields(body, ['confirm', 'urls']);
      if (body.confirm !== true) fail('清理服务器视频前必须明确确认。', 'CLEANUP_CONFIRMATION_REQUIRED', 409);
      if (!Array.isArray(body.urls) || body.urls.length < 1 || body.urls.length > 1200 || body.urls.some(value => typeof value !== 'string' || !value.trim())) fail('待清理视频清单无效。', 'OUTPUT_CLEANUP_INVALID', 400);
      return exclusive(async () => {
        const p = project(id);
        if (p.jobs.some(job => blocking(job))) fail('项目仍有进行中或待核实任务，暂不能清理服务器视频。', 'ACTIVE_JOB', 409);
        const requested = [...new Set(body.urls.map(value => value.trim()))];
        const valid = new Set();
        for (const value of requested) {
          if (!value.startsWith(`/media/${p.id}/`) || value.includes('..') || value.includes('\\') || /[?#\x00]/.test(value) || !/\.mp4$/i.test(value)) fail('待清理视频必须属于当前项目的 MP4 媒体。', 'OUTPUT_CLEANUP_INVALID', 400);
          valid.add(value);
        }
        const references = projectVideoReferences(p);
        const unreferenced = requested.filter(value => !references.has(value));
        if (unreferenced.length) fail('清理清单包含当前项目未引用的视频，请重新同步项目后再试。', 'OUTPUT_CLEANUP_INVALID', 409);
        if (typeof providers.cleanupVideos !== 'function') fail('当前服务不支持服务器视频清理。', 'OUTPUT_CLEANUP_UNSUPPORTED', 409);
        const backup = copy(p);
        const cleanup = await providers.cleanupVideos(p, requested);
        try {
          markVideoReferencesDeleted(p, valid);
          p.remoteVideoCleanupAt = now();
          await save(p);
          await cleanup.commit();
          return copy(p);
        } catch (error) {
          projects.set(id, backup);
          await cleanup.rollback().catch(() => {});
          throw error;
        }
      });
    },
    async previewSegment(id,segmentId,options={}){
      if(closed)fail('工作台正在关闭','CLOSED',503);
      onlyFields(options,['templateId']);
      const snapshot=await exclusive(()=>{
        const p=project(id),segment=findSegment(p,segmentId);
        const templateId=options.templateId===undefined?segment.boardTemplateId:options.templateId;
        getBoardTemplate(templateId);
         validateSegment(segment,{generationMode:p.generationMode,durationMode:p.durationMode,projectDuration:p.duration});
         if(segment.shots.some(s=>!s.image))fail(`预览需要完整的 ${segment.shots.length} 张分镜图片`,'EXPORT_INCOMPLETE',409);
        if(p.jobs.some(j=>j.kind==='image'&&segment.shots.some(s=>s.id===j.targetId)&&blocksCurrent(p,j)))fail('分镜图片任务仍在执行或待核实，请完成后导出预览','ACTIVE_JOB',409);
        return {p:copy(p),segment:copy(segment),templateId};
      });
      const result=await providers.exportStoryboardPreview(snapshot.p,snapshot.segment,{templateId:snapshot.templateId});
      validateArtifactUrls(result,snapshot.p);
      return {...result,projectId:id,segmentId,number:snapshot.segment.number};
    },
    async updateSegment(id,segmentId,patch){return mutate(id,p=>{
      onlyFields(patch,['boardTemplateId']);
      if(patch.boardTemplateId===undefined)fail('请指定分镜设定板模板');
      getBoardTemplate(patch.boardTemplateId);const segment=findSegment(p,segmentId);
      if(segment.boardTemplateId===patch.boardTemplateId)return;
      if(p.jobs.some(job=>job.kind==='export'&&job.targetId===segmentId&&active(job)))fail('片段正在导出，请完成后再切换模板','ACTIVE_JOB',409);
       segment.boardTemplateId=patch.boardTemplateId;
       if(segment.generationMode==='segment-board'){segment.storyboardImageVersion=null;segment.storyboardApproved=false;}
    });},
    async create(input) { if (closed) fail('工作台正在关闭', 'CLOSED', 503); return exclusive(async () => { const p = createProject(input); await save(p); projects.set(p.id, p); return copy(p); }); },
    async demo() { if (closed) fail('工作台正在关闭', 'CLOSED', 503); return exclusive(async () => { const p = createProject(SAMPLE_INPUT); Object.assign(p, validateAnalysis(copy(SAMPLE_ANALYSIS), p)); await save(p); projects.set(p.id, p); return copy(p); }); },
    async remove(id, options = {}) {
      if (closed) fail('工作台正在关闭', 'CLOSED', 503);
      if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'force') || ('force' in options && typeof options.force !== 'boolean')) fail('删除确认参数无效', 'INVALID_INPUT', 400);
      const force = options.force === true;
      return exclusive(async () => {
        const p = project(id);
        if (!force && p.jobs.some(job => blocksCurrent(p, job))) fail('项目还有进行中或待核实任务，请先处理任务后再删除', 'ACTIVE_JOB', 409);
        const removedQueued = [];
        if (force) {
          deletedProjects.add(id);
          for (let index = queue.length - 1; index >= 0; index -= 1) {
            if (queue[index].id !== id) continue;
            removedQueued.push(queue[index]);
            queuedKeys.delete(queue[index].key);
            queue.splice(index, 1);
          }
        }
        try {
          await removeFiles(id);
          projects.delete(id);
          return { id: p.id, title: p.title };
        } catch (error) {
          if (force) {
            deletedProjects.delete(id);
            for (const item of removedQueued) { queue.push(item); queuedKeys.add(item.key); }
            if (removedQueued.length && !pumping) { pumping = true; worker = Promise.resolve().then(pump); }
          }
          throw error;
        }
      });
    },
    async update(id, patch) { return mutate(id, p => {
      onlyFields(patch, ['title', 'novel', 'style', 'visualStyle', 'sourceType', 'narrativeMode', 'aspectRatio', 'duration', 'durationMode']);
      const structuralChanges = Object.keys(patch).filter(key => key !== 'title' && patch[key] !== p[key]);
      const novelChanged = typeof patch.novel === 'string' && patch.novel !== p.novel;
      const analyzed = p.segments.length || p.characters.length || p.scenes.length || p.looks.length;
      if (analyzed && novelChanged) {
        const baseLength = Number.isInteger(p.analysisSourceLength) ? p.analysisSourceLength : p.novel.length;
        const baseHash = typeof p.analysisSourceHash === 'string' ? p.analysisSourceHash : sourceHash(p.novel.slice(0, baseLength));
        const prefixIsStable = patch.novel.startsWith(p.novel) && sourceHash(patch.novel.slice(0, baseLength)) === baseHash;
        if (structuralChanges.some(key => key !== 'novel') || !prefixIsStable) fail('已分析作品只允许在原稿末尾追加内容；请保留已分析正文和结构设置。', 'STRUCTURE_LOCKED', 409);
        if (p.jobs.some(job => ['queued', 'running', 'unknown'].includes(job.status))) fail('当前仍有分析或模型任务，请完成后再追加原稿。', 'ACTIVE_JOB', 409);
        p.novel = projectInput({ ...p, novel: patch.novel }).novel;
        return;
      }
      if ((analyzed || p.jobs.some(j => blocksCurrent(p, j))) && structuralChanges.length) fail('已分析作品不能修改小说、视觉媒介、风格、画幅或片段时长等结构设置，请新建作品', 'STRUCTURE_LOCKED', 409);
      Object.assign(p, projectInput({ ...p, ...patch }));
    }); },
    async resetDuration(id, body = {}) { return mutate(id, p => {
      onlyFields(body, ['duration', 'durationMode']);
      if (![15, 30].includes(body.duration)) fail('重新规划时长只能选择 15 或 30 秒');
      if (body.durationMode !== undefined && !['auto', 'fixed'].includes(body.durationMode)) fail('时长模式必须为 auto 或 fixed');
      if (p.jobs.some(job => ['queued', 'running', 'unknown'].includes(job.status))) fail('当前仍有进行中或待核实任务，请先完成或核实后再重新规划时长', 'ACTIVE_JOB', 409);
      // Older projects may only have current export pointers and no separate
      // exportHistory yet. Archive those records before clearing the pointers
      // so a duration reset cannot make an existing download disappear.
      const archived = new Map((p.exportHistory ?? []).filter(record => record?.id).map(record => [record.id, record]));
      for (const record of [...(p.exports ?? []), ...(p.projectExports ?? [])]) {
        if (record?.id && !archived.has(record.id)) archived.set(record.id, copy(record));
      }
      p.exportHistory = [...archived.values()];
      const next = projectInput({ ...p, duration: body.duration, durationMode: body.durationMode ?? 'fixed' });
      Object.assign(p, next);
      // Keep the original text, project identity and history ledger. Only the
      // current derived plan and current export pointers are invalidated.
      p.characters = [];
      p.scenes = [];
      p.looks = [];
      p.segments = [];
      p.exports = [];
      p.projectExports = [];
    }); },
    async analyze(id) { return mutate(id, p => { if (!p.novel.trim()) fail('请先导入原始内容'); if (p.segments.length || p.characters.length || p.scenes.length || p.looks.length) fail('作品已有分析结果或人工场景，请使用“分析新增内容”', 'ANALYSIS_EXISTS', 409); const failed = p.jobs.find(job => job.kind === 'analyze' && job.status === 'failed' && job.analysisRetryable); if (failed) fail('当前分析块校验失败，请使用“重试当前分析块”继续，不会重复请求已保存内容。', 'ANALYSIS_RETRY_REQUIRED', 409); return [addJob(p, 'analyze', p.id)]; }); },
    async analyzeAppend(id) { return mutate(id, p => {
      if (!p.segments.length && !p.characters.length && !p.scenes.length && !p.looks.length) fail('作品还没有可续接的分析结果，请先进行首次分析。', 'ANALYSIS_EXISTS', 409);
      const baseLength = Number.isInteger(p.analysisSourceLength) ? p.analysisSourceLength : p.novel.length;
      const baseHash = typeof p.analysisSourceHash === 'string' ? p.analysisSourceHash : sourceHash(p.novel.slice(0, baseLength));
      if (p.novel.length <= baseLength || sourceHash(p.novel.slice(0, baseLength)) !== baseHash) fail('没有检测到可靠的新增原稿，请从已分析正文末尾继续追加。', 'NO_APPEND_CONTENT', 409);
      if (p.jobs.some(job => job.kind === 'analyze' && ['queued', 'running', 'unknown'].includes(job.status))) fail('请先处理当前分析任务，再分析新增内容。', 'ACTIVE_JOB', 409);
      return [addJob(p, 'analyze', p.id, { analysisAppend: true, analysisBaseLength: baseLength, analysisBaseHash: baseHash, analysisBaseSegments: p.segments.length })];
    }); },
    async retryAnalysis(id, jid, body = {}) { return mutate(id, p => {
      onlyFields(body, ['confirmDuplicateCost']);
      if (body.confirmDuplicateCost !== true) fail('继续前请确认上次请求可能已计费，本次会再次请求未完成部分', 'RETRY_CONFIRMATION_REQUIRED', 409);
      const previous = p.jobs.find(job => job.id === jid);
      if (!previous) fail('找不到该任务', 'NOT_FOUND', 404);
      const retryableFailedBlock = previous.kind === 'analyze' && previous.status === 'failed' && previous.analysisRetryable === true;
      if (previous.kind !== 'analyze' || (previous.status !== 'unknown' && !retryableFailedBlock)) fail('只有结果待核实或当前块校验失败的小说分析可在确认后继续', 'CANNOT_RESUME', 409);
      // Idempotency is tied to the original attempt, even after the follow-up
      // finishes or also times out. A later unknown attempt needs new consent.
      if (previous.analysisRetryJobId) return [];
      if (!current(p, previous)) fail('任务对应旧版原稿，请先核对当前输入', 'STALE_INPUT', 409);
      if (!previous.analysisAppend && (p.segments.length || p.characters.length || p.scenes.length || p.looks.length)) fail('作品已有分析结果或人工场景，不能覆盖', 'ANALYSIS_EXISTS', 409);
      if (p.jobs.some(job => job.id !== jid && blocksCurrent(p, job))) fail('请先处理当前仍在执行或待核实的任务', 'ACTIVE_JOB', 409);
      const acceptedAt = now();
      // Save the acknowledgment and the new job atomically before scheduling.
      // The original status/error remains a truthful record of the lost result.
      const next = addJob(p, 'analyze', p.id, {
        ignoreJobId: previous.id,
        ...(previous.analysisAppend ? {
          analysisAppend: true,
          analysisBaseLength: previous.analysisBaseLength,
          analysisBaseHash: previous.analysisBaseHash,
          analysisBaseSegments: previous.analysisBaseSegments,
        } : {}),
      });
      previous.analysisRetryJobId = next.id;
      previous.analysisRetryAcceptedAt = acceptedAt;
      previous.updatedAt = acceptedAt;
      next.analysisRetryOf = previous.id;
      return [next];
    }); },
    async createScene(id,input){return mutate(id,p=>{
      onlyFields(input,['name','description']);
      if(p.jobs.some(j=>j.kind==='analyze'&&blocksCurrent(p,j)))fail('请等待小说分析完成后再创建场景','ACTIVE_JOB',409);
      if(p.scenes.length>=300)fail('场景数量超过上限');p.scenes.push({id:randomUUID(),...sceneFields(input)});
    });},
    async updateScene(id,sceneId,patch){return mutate(id,p=>{
      onlyFields(patch,['name','description']);const scene=findScene(p,sceneId),before=JSON.stringify(scene);
      Object.assign(scene,sceneFields({...scene,...patch}));
      if(JSON.stringify(scene)===before)return;
      for(const look of p.looks)if(look.sceneId===sceneId){look.version++;look.approved=false;}
      for(const segment of p.segments)for(const shot of segment.shots)if(shot.sceneId===sceneId){invalidateShot(shot);invalidateExports(p,segment.id);}
    });},
    async createLook(id,input){return mutate(id,p=>{
      onlyFields(input,['sceneId','characterId','name','appearance']);findScene(p,input.sceneId);identityReady(p,input.characterId);
      if(p.looks.some(look=>look.sceneId===input.sceneId&&look.characterId===input.characterId))fail('同一场景和角色已存在造型，请编辑原造型','LOOK_EXISTS',409);
      if(p.looks.length>=900)fail('造型数量超过上限');
      p.looks.push({id:randomUUID(),sceneId:input.sceneId,characterId:input.characterId,...lookFields(input),reference:null,approved:false,version:1});
    });},
    async updateLook(id,lookId,patch){return mutate(id,p=>{onlyFields(patch,['name','appearance']);const look=findLook(p,lookId),before=JSON.stringify(look);Object.assign(look,lookFields({...look,...patch}));if(JSON.stringify(look)!==before)invalidateLook(p,look);});},
    async lookAction(id,lookId,action,body={}){
      if(action==='upload'){
        const p=await service.get(id),look=findLook(p,lookId);expectedVersion(look,body);identityReady(p,look.characterId);const before=look.version;
        const url=mediaUrl(await providers.importImage(p,body.dataUrl),p);
        return mutate(id,live=>{const currentLook=findLook(live,lookId);expectedVersion(currentLook,body);identityReady(live,currentLook.characterId);if(currentLook.version!==before)fail('造型已修改，请重新上传','STALE_INPUT',409);invalidateLook(live,currentLook);currentLook.reference=url;currentLook.referenceVersion=currentLook.version;const scene=live.scenes?.find(item=>item.id===currentLook.sceneId);const character=live.characters?.find(item=>item.id===currentLook.characterId);recordMedia(live,{recordType:'look-image',assetUrl:url,assetTitle:`场景造型 · ${currentLook.name}`,segmentTitle:scene?.name||'场景造型',version:currentLook.version,sceneId:currentLook.sceneId,characterId:currentLook.characterId,characterName:character?.name,source:'upload'});});
      }
      return mutate(id,p=>{
        const look=findLook(p,lookId);expectedVersion(look,body);identityReady(p,look.characterId);
        if(action==='generate'){if(body.reuseExisting===true&&look.reference&&look.referenceVersion===look.version)return;return [addJob(p,'look',lookId)];}
        if(action!=='approve')fail('未知造型操作');reviewedVersion(look,body);
        if(p.jobs.some(j=>j.kind==='look'&&j.targetId===lookId&&blocksCurrent(p,j)))fail('造型任务仍在执行或待核实，不能审核','ACTIVE_JOB',409);
        if(!look.reference)fail('请先生成或上传该场景的角色三视图');
        if(look.referenceVersion!==look.version)fail('造型三视图为旧版或未验证版本，请重新生成或上传','STALE_ASSET',409);
        look.approved=true;
      });
    },
    async updateCharacter(id, cid, patch) { return mutate(id, p => { const c = findCharacter(p, cid); const previous = JSON.stringify(c); updateCharacterFields(c, patch); if (JSON.stringify(c) !== previous) invalidateCharacter(p, c); }); },
    async characterAction(id, cid, action, body = {}) {
      if (action === 'upload') {
        const p = await service.get(id); const character=findCharacter(p,cid);expectedVersion(character,body);const before = character.version; const url = mediaUrl(await providers.importImage(p, body.dataUrl), p);
        return mutate(id, live => { const c = findCharacter(live, cid);expectedVersion(c,body); if (c.version !== before) fail('角色已被修改，请重新上传', 'STALE_INPUT', 409); invalidateCharacter(live, c); c.reference = url;c.referenceVersion=c.version;recordMedia(live,{recordType:'character-image',assetUrl:url,assetTitle:`人物身份 · ${c.name}`,segmentTitle:'人物资料',version:c.version,source:'upload'}); });
      }
      return mutate(id, p => { const c = findCharacter(p, cid);expectedVersion(c,body); if (action === 'generate') {if(body.reuseExisting===true&&c.reference&&c.referenceVersion===c.version)return;return [addJob(p, 'character', cid)];} if (action !== 'approve') fail('未知角色操作');reviewedVersion(c,body); if (p.jobs.some(j => j.kind === 'character' && j.targetId === cid && blocksCurrent(p, j))) fail('角色任务仍在执行或待核实，不能确认定妆', 'ACTIVE_JOB', 409); if (!c.reference) fail('请先生成或上传角色参考图');if(p.workflowVersion===2&&c.referenceVersion!==c.version)fail('身份参考为旧版或未验证版本，请重新生成或上传','STALE_ASSET',409); c.approved = true; });
    },
    async updateShot(id, sid, patch) { return mutate(id, p => {
      const { segment, shot } = findShot(p, sid);
      const previous = copy(shot);
      const wasCurrent = !!shot.video && shot.videoVersion === shot.version;
      updateShotFields(shot, patch, p.characters,p.scenes);
      const changed = Object.keys(patch).filter(key => JSON.stringify(shot[key]) !== JSON.stringify(previous[key]));
      if (changed.length) {
        const onlyTiming = changed.every(key => ['duration', 'trimStart'].includes(key));
        const canReuse = onlyTiming && wasCurrent && Number.isFinite(shot.videoDuration) && shot.trimStart + shot.duration <= shot.videoDuration + 1e-8;
        const canReuseImage = onlyTiming && previous.image && previous.imageVersion === previous.version;
        invalidateShot(shot);
        if (canReuseImage) shot.imageVersion = shot.version;
        if (canReuse) shot.videoVersion = shot.version;
        if (segment.generationMode === 'segment-board') { segment.storyboardImageVersion = null; segment.storyboardApproved = false; }
        invalidateExports(p, segment.id);
      }
    }); },
    async shotAction(id, sid, action, body = {}) {
      if (action === 'upload') {
        const p = await service.get(id);const beforeShot=findShot(p,sid).shot;expectedVersion(beforeShot,body);const before = beforeShot.version; const url = mediaUrl(await providers.importImage(p, body.dataUrl), p);
         return mutate(id, live => { const { shot, segment } = findShot(live, sid);expectedVersion(shot,body); if (shot.version !== before) fail('分镜已被修改，请重新上传', 'STALE_INPUT', 409); invalidateShot(shot); shot.image = url;shot.imageVersion=shot.version; invalidateExports(live, segment.id);recordMedia(live,{recordType:'shot-image',assetUrl:url,assetTitle:`镜头 ${String(shot.number).padStart(2,'0')} · 分镜图片`,segmentId:segment.id,segmentTitle:segment.title,sceneId:shot.sceneId,sceneTitle:live.scenes?.find(item=>item.id===shot.sceneId)?.name,shotId:shot.id,number:shot.number,version:shot.version,source:'upload'}); });
      }
      return mutate(id, p => {
        const { segment, shot } = findShot(p, sid);
        expectedVersion(shot,body);
        if (action === 'generate') { if (p.generationMode === 'segment-board') fail('片段级模式请在分镜总览中一次生成整段分镜板', 'SEGMENT_BOARD_REQUIRED', 409); shotAssetsReady(p, shot);if(body.reuseExisting===true&&shot.image&&shot.imageVersion===shot.version)return; return [addJob(p, 'image', sid)]; }
        if (action === 'approve') {reviewedVersion(shot,body); shotAssetsReady(p, shot); validateSegment(segment,{generationMode:p.generationMode,durationMode:p.durationMode,projectDuration:p.duration}); if (!shot.image) fail('请先生成或上传分镜图片');requireCurrentImage(p,shot); if (p.jobs.some(j => j.kind === 'image' && j.targetId === sid && blocksCurrent(p, j))) fail('分镜图片任务仍在执行或待核实', 'ACTIVE_JOB', 409); shot.approved = true; return; }
        if (action === 'video') { if (p.generationMode === 'segment-board') fail('片段级模式请在片段视频区生成一条完整视频', 'SEGMENT_VIDEO_REQUIRED', 409); requireApproved(p, segment); if (p.jobs.some(j => ['character', 'look', 'image', 'analyze', 'export'].includes(j.kind) && blocksCurrent(p, j))) fail('请等待当前素材任务完成并重新审核', 'ACTIVE_JOB', 409);if(body.reuseExisting===true&&shot.video&&shot.videoVersion===shot.version)return; return [addJob(p, 'video', sid)]; }
        fail('未知分镜操作');
      });
    },
    async segmentAction(id, segmentId, action, body = {}) { return mutate(id, p => {
      onlyFields(body, ['reviewedVersion', 'reuseExisting', 'videoModel', 'videoResolution']);
      const segment = findSegment(p, segmentId);
      if (action === 'approve') { validateSegment(segment,{generationMode:p.generationMode,durationMode:p.durationMode,projectDuration:p.duration}); if(p.generationMode==='segment-board'){const boardVersion=version(p,'storyboard',segmentId);if(body.reviewedVersion!==undefined&&body.reviewedVersion!==boardVersion)fail('审核内容已变化，请检查当前整板版本后重新审核','STALE_INPUT',409);if(!segment.storyboardImage||segment.storyboardImageVersion!==boardVersion)fail('请先生成当前模板的整段分镜板','STALE_ASSET',409);if(p.jobs.some(j=>j.kind==='storyboard'&&j.targetId===segmentId&&blocksCurrent(p,j)))fail('整段分镜板任务仍在执行或待核实','ACTIVE_JOB',409);segment.storyboardApproved=true;} for (const shot of segment.shots) { shotAssetsReady(p, shot); if (!shot.image) fail(`全部 ${segment.shots.length} 个分镜都需要图片才能审核`);requireCurrentImage(p,shot); if (p.jobs.some(j => j.targetId === shot.id && blocksCurrent(p, j))) fail('分镜任务仍在执行或待核实', 'ACTIVE_JOB', 409); } for (const shot of segment.shots) shot.approved = true; return; }
      if (action === 'generate-images' || action === 'generate-storyboard') { if(p.generationMode==='segment-board'){const boardVersion=version(p,'storyboard',segmentId);const current=Boolean(segment.storyboardImage&&segment.storyboardImageVersion===boardVersion&&segment.shots.length&&segment.shots.every(shot=>shot.image&&shot.imageVersion===shot.version));if(body.reuseExisting===true&&current)return;return [addJob(p,'storyboard',segmentId)];} const targets = segment.shots.filter(s => !s.image); for (const shot of targets) shotAssetsReady(p, shot); return targets.map(s => addJob(p, 'image', s.id)); }
      if (action === 'generate-videos') {
        requireApproved(p, segment);
        if (p.jobs.some(j => !['video', 'segment-video'].includes(j.kind) && blocksCurrent(p, j))) fail('请等待当前素材任务完成并重新审核', 'ACTIVE_JOB', 409);
        if (p.generationMode === 'segment-board') {
          const current = segment.video && segment.videoVersion === version(p, 'segment-video', segment.id);
          if (body.reuseExisting === true && current) return;
          if (typeof providers.getVideoModel === 'function') resolveVideoOption(body.videoModel ?? providers.getVideoModel(), body.videoResolution);
          return [addJob(p, 'segment-video', segment.id, { videoModel: body.videoModel, videoResolution: body.videoResolution })];
        }
        if (typeof providers.getVideoModel === 'function') resolveVideoOption(body.videoModel ?? providers.getVideoModel(), body.videoResolution);
        return segment.shots.filter(s => !s.video || s.videoVersion !== s.version).map(s => addJob(p, 'video', s.id, { videoModel: body.videoModel, videoResolution: body.videoResolution }));
      }
      if (action === 'export') { requireCurrentExport(p, segment); if (p.jobs.some(j => blocksCurrent(p, j) && (j.targetId === segmentId || segment.shots.some(s => s.id === j.targetId)))) { const existing = p.jobs.find(j => j.kind === 'export' && j.targetId === segmentId && blocksCurrent(p, j)); if (existing) return [existing]; fail('片段任务仍在执行或待核实，请等待后导出', 'ACTIVE_JOB', 409); } return [addJob(p, 'export', segmentId)]; }
      fail('未知片段操作');
    }); },
    async batchAction(id, body = {}) {
      if (closed) fail('工作台正在关闭', 'CLOSED', 503);
      return exclusive(async () => {
        const p = project(id); const backup = copy(p);
        try {
          onlyFields(body, ['kind', 'action', 'targetIds', 'expectedVersions', 'videoModel', 'videoResolution']);
          if (!['character', 'look', 'shot'].includes(body.kind)) fail('批量目标类型无效');
          if (!['generate', 'approve', 'video'].includes(body.action)) fail('批量操作无效');
          if (body.kind !== 'shot' && body.action === 'video') fail('人物和造型不支持批量生成视频');
          if (body.kind === 'shot' && body.action === 'video' && p.generationMode === 'segment-board') fail('片段级模式请在片段视频区生成一条完整视频', 'SEGMENT_VIDEO_REQUIRED', 409);
          if (!Array.isArray(body.targetIds) || body.targetIds.length < 1 || body.targetIds.length > 200 || body.targetIds.some(value => typeof value !== 'string' || !value.trim())) fail('批量目标不能为空且最多支持 200 项');
          if (!body.expectedVersions || typeof body.expectedVersions !== 'object' || Array.isArray(body.expectedVersions)) fail('每个批量目标都必须携带当前版本号');
          const targetIds = [...new Set(body.targetIds)];
          const expectedVersions = body.expectedVersions || {};
          if (Object.keys(expectedVersions).some(targetId => !targetIds.includes(targetId))) fail('批量版本映射包含未选择的目标');
          const accepted = [], skipped = [], createdJobIds = [], jobs = [];
          const skip = (targetId, error) => skipped.push({ targetId, ...batchFailure(error) });
          for (const targetId of targetIds) {
            try {
              const expected = expectedVersions[targetId];
              if (expected === undefined) fail('缺少此目标的当前版本号', 'VERSION_REQUIRED', 409);
              if (!Number.isInteger(expected) || expected < 1) fail('批量版本映射格式无效');
              let target;
              if (body.kind === 'character') target = findCharacter(p, targetId);
              else if (body.kind === 'look') target = findLook(p, targetId);
              else target = findShot(p, targetId).shot;
              if (expected !== undefined) {
                if (body.action === 'approve') reviewedVersion(target, { reviewedVersion: expected });
                else expectedVersion(target, { expectedVersion: expected });
              }
              if (body.kind === 'character') {
                if (body.action === 'generate') {
                  if (target.reference && target.referenceVersion === target.version) fail('当前版本已有身份参考，未重复生成', 'ALREADY_CURRENT', 409);
                  const job = batchJob(p, 'character', targetId); jobs.push(job); accepted.push(targetId); createdJobIds.push(job.id);
                } else {
                  if (target.approved && target.reference && (p.workflowVersion !== 2 || target.referenceVersion === target.version)) fail('当前人物身份已审核', 'ALREADY_APPROVED', 409);
                  if (p.jobs.some(job => job.kind === 'character' && job.targetId === targetId && blocksCurrent(p, job))) fail('人物身份任务仍在执行或待核实，不能确认定妆', 'ACTIVE_JOB', 409);
                  if (!target.reference) fail('请先生成或上传角色参考图', 'MISSING_ASSET', 409);
                  if (p.workflowVersion === 2 && target.referenceVersion !== target.version) fail('身份参考为旧版或未验证版本，请重新生成或上传', 'STALE_ASSET', 409);
                  target.approved = true; accepted.push(targetId);
                }
              } else if (body.kind === 'look') {
                identityReady(p, target.characterId);
                if (body.action === 'generate') {
                  if (target.reference && target.referenceVersion === target.version) fail('当前版本已有场景三视图，未重复生成', 'ALREADY_CURRENT', 409);
                  const job = batchJob(p, 'look', targetId); jobs.push(job); accepted.push(targetId); createdJobIds.push(job.id);
                } else {
                  if (target.approved && target.reference && target.referenceVersion === target.version) fail('当前场景造型已审核', 'ALREADY_APPROVED', 409);
                  if (p.jobs.some(job => job.kind === 'look' && job.targetId === targetId && blocksCurrent(p, job))) fail('造型任务仍在执行或待核实，不能审核', 'ACTIVE_JOB', 409);
                  if (!target.reference) fail('请先生成或上传该场景的角色三视图', 'MISSING_ASSET', 409);
                  if (target.referenceVersion !== target.version) fail('造型三视图为旧版或未验证版本，请重新生成或上传', 'STALE_ASSET', 409);
                  target.approved = true; accepted.push(targetId);
                }
              } else {
                const { segment, shot } = findShot(p, targetId);
                if (body.action === 'generate') {
                  shotAssetsReady(p, shot);
                  if (shot.image && shot.imageVersion === shot.version) fail('当前版本已有分镜图片，未重复生成', 'ALREADY_CURRENT', 409);
                  const job = batchJob(p, 'image', targetId); jobs.push(job); accepted.push(targetId); createdJobIds.push(job.id);
                } else if (body.action === 'approve') {
                  shotAssetsReady(p, shot); validateSegment(segment,{generationMode:p.generationMode,durationMode:p.durationMode,projectDuration:p.duration});
                  if (shot.approved && shot.image && shot.imageVersion === shot.version) fail('当前分镜已审核', 'ALREADY_APPROVED', 409);
                  if (!shot.image) fail('请先生成或上传分镜图片', 'MISSING_ASSET', 409);
                  requireCurrentImage(p, shot);
                  if (p.jobs.some(job => job.kind === 'image' && job.targetId === targetId && blocksCurrent(p, job))) fail('分镜图片任务仍在执行或待核实', 'ACTIVE_JOB', 409);
                  shot.approved = true; accepted.push(targetId);
                } else {
                  requireApproved(p, segment);
                  if (shot.video && shot.videoVersion === shot.version) fail('当前版本已有视频，未重复生成', 'ALREADY_CURRENT', 409);
                  if (p.jobs.some(job => ['character', 'look', 'image', 'analyze', 'export'].includes(job.kind) && blocksCurrent(p, job))) fail('请等待当前素材任务完成并重新审核', 'ACTIVE_JOB', 409);
                  const job = batchJob(p, 'video', targetId, { videoModel: body.videoModel, videoResolution: body.videoResolution }); jobs.push(job); accepted.push(targetId); createdJobIds.push(job.id);
                }
              }
            } catch (error) { skip(targetId, error); }
          }
          await save(p);
          for (const job of jobs) schedule(p.id, job.id);
          return { project: copy(p), accepted, skipped, createdJobIds };
        } catch (error) { projects.set(id, backup); throw error; }
      });
    },
    async resumeJob(id, jid) { return mutate(id, p => {
      const j = p.jobs.find(x => x.id === jid);
      if (!j) fail('找不到该任务', 'NOT_FOUND', 404);
      if (active(j) || j.status === 'completed') return [];
      if (!['video', 'segment-video', 'character', 'look', 'image', 'storyboard'].includes(j.kind) || (!j.providerTaskId && !j.businessId)) fail('该任务没有可恢复查询的供应商 ID；禁止自动重发不明确请求', 'CANNOT_RESUME', 409);
      if (!current(p, j)) fail('任务对应旧版素材，不能恢复为当前素材', 'STALE_INPUT', 409);
      if (j.kind === 'video') requireApproved(p, findShot(p, j.targetId).segment);
      if (j.kind === 'segment-video') requireApproved(p, findSegment(p, j.targetId));
      j.submissionStarted = true; j.status = 'queued'; j.error = undefined;
      return [j];
    }); },
    async close() {
      closed = true;
      await lock;
      const waitForRuns = async () => {
        await worker;
        while (inFlight.size) await Promise.allSettled([...inFlight]);
      };
      let timeout;
      try { await Promise.race([waitForRuns(), new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(timeout); }
      await lock;
    },
  };
  const recoveryQueue = [];
  for (const p of projects.values()) {
    let changed = false;
    for (const j of p.jobs) if (active(j)) {
      if (['video', 'segment-video'].includes(j.kind) && j.submissionStarted && (j.providerTaskId || j.businessId)) { j.status = 'queued'; recoveryQueue.push([p.id, j.id]); }
      else if (['image','character','look','storyboard'].includes(j.kind) && j.submissionStarted && j.providerTaskId) { j.status = 'queued'; recoveryQueue.push([p.id, j.id]); }
      else if (!j.submissionStarted || j.kind === 'export') { j.status = 'queued'; recoveryQueue.push([p.id, j.id]); }
      else { j.status = 'unknown'; j.error = '应用退出前请求结果不明确，未自动重复提交'; }
      changed = true;
    }
    if (changed) await save(p);
  }
  for (const [id, jid] of recoveryQueue) schedule(id, jid);
  return service;
}

import { lstat, mkdir, readdir, readFile, open, realpath, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createProject, fail, now, projectInput, onlyFields, validateAnalysis, updateCharacterFields, updateShotFields, invalidateShot, findCharacter, findShot, findSegment, requireCharacters, requireApproved, requireExport, validateSegment, mediaUrl, sceneFields, lookFields, assetFields, findScene, findLook, findAsset, requireIdentity, requireCurrentImage, migrateSceneWorkflow } from './domain.mjs';
import { normalizeCharacterAppearance } from './analysis-results.mjs';
import { SAMPLE_INPUT, SAMPLE_ANALYSIS } from './sample.mjs';
import {DEFAULT_BOARD_TEMPLATE_ID,getBoardTemplate} from './board-templates.mjs';
import { estimateVideoCostCny, estimateVideoCostRangeCny, resolveVideoOption } from './video-options.mjs';
import { DEFAULT_LLM_MODEL, LLM_MODELS } from './llm-models.mjs';

const copy = value => structuredClone(value);
const sourceHash = value => createHash('sha256').update(String(value ?? '')).digest('hex');
const active = job => ['queued', 'running'].includes(job.status);
const blocking = job => active(job) || (job.status === 'unknown' && !(job.kind === 'analyze' && job.analysisRetryJobId));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const LOOK_CATEGORIES = ['身份基准', '杂役/工作服', '宗门/制服', '日常便装', '战斗服', '礼服', '特殊造型', '其他'];
const videoMinimumDuration = model => typeof model === 'string' && /^xiongmao-seedance-2-5-special$/i.test(model) ? 30 : typeof model === 'string' && /^xiongmao-seedance-2-0-special(?:-|$)/i.test(model) ? 15 : model === 'MiniMax-H3-Max' ? 5 : 4;
// Audio intent is expressed in the provider prompt. The service keeps the
// returned track intact so it does not guess which voices or crowd sounds are
// meaningful after generation.
// Image and video providers accept independent asynchronous submissions. Keep
// them uncapped at the application layer; the provider remains responsible for
// its own quotas and rate limits. Analysis and export stay ordered below.
const parallelKinds = new Set(['analyze', 'character', 'asset', 'scene', 'look', 'image', 'storyboard', 'video', 'segment-video']);
// Deterministic validation failures are safe to replay from the durable
// checkpoint. Give the model one extra automatic correction before asking the
// user to intervene, while transport-ambiguous requests remain untouched.
const ANALYSIS_AUTO_RETRIES = 3;
const isLegacyBudgetValidationFailure = value => typeof value === 'string'
  && /第\s*\d+\s*集规划了[\s\S]*?秒，不能超过约[\s\S]*?秒/.test(value);

function normalizeSegmentBoardAnalysisBudget(project, { allowExisting = false } = {}) {
  if (project?.generationMode !== 'segment-board' || Number(project.duration) <= 15) return;
  const legacySegments = (project.segments ?? []).filter(segment => Number(segment?.duration) > 15);
  if (legacySegments.length && allowExisting) {
    fail('作品仍有旧的 30 秒片段；请先在“重新规划片段时长”中重置为 15 秒，再追加分析。', 'LEGACY_DURATION_RESET_REQUIRED', 409);
  }
  // A pre-15-second story-board project has no derived work yet, so changing
  // its planning budget is lossless and prevents a 30-second candidate from
  // reaching any provider or video-model selector.
  project.duration = 15;
  project.durationMode = 'auto';
}

function materializeAnalysisState(raw, project, { readyThroughChunk = null, readySegmentCount = null } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const segments = (Array.isArray(source.segments) ? source.segments : []).map((segment, index) => {
    const shots = (Array.isArray(segment?.shots) ? segment.shots : []).map((shot, shotIndex) => ({
      ...copy(shot),
      id: shot.id || randomUUID(),
      number: shotIndex + 1,
      image: shot.image ?? null,
      approved: shot.approved === true,
      version: Number.isInteger(shot.version) && shot.version > 0 ? shot.version : 1,
      video: shot.video ?? null,
      videoVersion: shot.videoVersion ?? null,
      videoDuration: shot.videoDuration ?? null,
    }));
    return {
      ...copy(segment),
      id: segment.id || randomUUID(),
      number: index + 1,
      analysisChunk: Number.isInteger(segment.analysisChunk) ? segment.analysisChunk : undefined,
      analysisReady: segment.analysisReady !== false,
      shots,
      ...(project.generationMode === 'segment-board' ? {
        generationMode: 'segment-board', shotCount: shots.length, storyboardImage: segment.storyboardImage ?? null,
        storyboardImageVersion: segment.storyboardImageVersion ?? null, storyboardApproved: segment.storyboardApproved === true,
        video: segment.video ?? null, videoVersion: segment.videoVersion ?? null, videoDuration: segment.videoDuration ?? null,
      } : {}),
    };
  });
  return {
    workflowVersion: 2,
    characters: (Array.isArray(source.characters) ? source.characters : []).map(character => ({
      ...copy(character), reference: character.reference ?? null, approved: character.approved === true,
      version: Number.isInteger(character.version) && character.version > 0 ? character.version : 1,
    })),
    assets: (Array.isArray(source.assets) ? source.assets : []).map(asset => ({
      ...copy(asset), reference: asset?.reference ?? null, referenceVersion: asset?.referenceVersion ?? null,
      approved: asset?.approved === true, version: Number.isInteger(asset?.version) && asset.version > 0 ? asset.version : 1,
    })),
    scenes: (Array.isArray(source.scenes) ? source.scenes : []).map(scene => ({
      ...copy(scene),
      reference: scene?.reference ?? null,
      referenceVersion: scene?.referenceVersion ?? null,
      approved: scene?.approved === true,
      version: Number.isInteger(scene?.version) && scene.version > 0 ? scene.version : 1,
    })),
    looks: (Array.isArray(source.looks) ? source.looks : []).map(look => ({
      ...copy(look), reference: look.reference ?? null, approved: look.approved === true,
      version: Number.isInteger(look.version) && look.version > 0 ? look.version : 1,
    })),
    segments,
    analysisWarnings: Array.isArray(source.analysisWarnings) ? copy(source.analysisWarnings) : [],
    analysisReady: {
      complete: readyThroughChunk === null,
      readyThroughChunk: Number.isInteger(readyThroughChunk) ? readyThroughChunk : undefined,
      readySegmentCount: Number.isInteger(readySegmentCount) ? readySegmentCount : segments.length,
    },
  };
}
function normalizeBoardTemplates(project){
  for(const segment of project.segments){
    if(segment.boardTemplateId===undefined)segment.boardTemplateId=DEFAULT_BOARD_TEMPLATE_ID;
    segment.generationMode ??= project.generationMode ?? 'legacy-shot';
    if(segment.generationMode==='segment-board'){
      segment.shotCount ??= segment.shots.length;
      segment.extendedDuration ??= Number(segment.duration) > 15;
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
    ensureLookAssets(p);
    p.lookAssets ??= [];
    p.assets ??= [];
    if (!Array.isArray(p.assets)) fail('本地作品关键物品结构无效', 'CORRUPT_DATA', 500);
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
    if (!p.id || name !== `${p.id}.json` || !Array.isArray(p.jobs) || !Array.isArray(p.segments) || !Array.isArray(p.characters) || !Array.isArray(p.exports) || (p.projectExports!==undefined&&!Array.isArray(p.projectExports)) || (p.exportHistory!==undefined&&!Array.isArray(p.exportHistory)) || (p.mediaHistory!==undefined&&!Array.isArray(p.mediaHistory)) || (p.lookAssets!==undefined&&!Array.isArray(p.lookAssets))) fail('本地作品结构无效', 'CORRUPT_DATA', 500);
    p.exportHistory ??= [];
    p.projectExports ??= [];
    p.mediaHistory ??= [];
    p.lookAssets ??= [];
    p.analysisWarnings ??= [];
    p.durationMode ??= 'fixed';
    const previousLlmModel = p.llmModel;
    if (!LLM_MODELS.some(model => model.id === p.llmModel)) p.llmModel = DEFAULT_LLM_MODEL;
    const llmModelChanged = p.llmModel !== previousLlmModel;
    p.generationMode ??= 'legacy-shot';
    p.videoMode = p.videoMode === 'traditional' ? 'traditional' : 'storyboard';
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
    let legacyBudgetJobChanged = false;
    for (const job of p.jobs) {
      if (job.kind === 'analyze' && job.status === 'failed' && !job.analysisRetryable && isLegacyBudgetValidationFailure(job.error)) {
        job.analysisRetryable = true;
        job.analysisRetryDeterministic = true;
        legacyBudgetJobChanged = true;
      }
    }
    for (const scene of p.scenes ?? []) {
      scene.reference ??= null;
      scene.referenceVersion ??= null;
      scene.approved = scene.approved === true;
      scene.version = Number.isInteger(scene.version) && scene.version > 0 ? scene.version : 1;
    }
    p.analysisSourceLength = migratedSourceLength;
    p.analysisSourceHash = migratedSourceHash;
    normalizeBoardTemplates(p);
    const appearanceChanged=(p.characters??[]).some(character=>{
      const normalized=normalizeCharacterAppearance(character.appearance??'',character.evidence??'');
      if(normalized===character.appearance)return false;
      character.appearance=normalized;return true;
    });
    if(migrateSceneWorkflow(p)||appearanceChanged||analysisSourceChanged||llmModelChanged||legacyBudgetJobChanged||ensureLookAssets(p))await save(p);
    projects.set(p.id, p);
  }
  function version(p, kind, targetId) {
    if (kind === 'character') return findCharacter(p, targetId).version;
    if (kind === 'asset') return findAsset(p, targetId).version;
    if (kind === 'scene') return findScene(p, targetId).version;
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
    const analysisInputs = [p.novel, p.style, p.llmModel ?? DEFAULT_LLM_MODEL, p.visualStyle ?? 'photorealistic', p.sourceType ?? 'auto', p.narrativeMode ?? 'auto', p.aspectRatio, p.duration];
    if (p.durationMode === 'auto') analysisInputs.push('auto');
    return createHash('sha256').update(JSON.stringify(analysisInputs)).digest('hex');
  }
  function current(p, job) {
    try { return job.inputVersion === version(p, job.kind, job.targetId); }
    catch (error) { if (error?.code === 'NOT_FOUND') return false; throw error; }
  }
  function blocksCurrent(p, job) { return blocking(job) && current(p, job); }
  function mergeAnalysisAssets(next, previous) {
    // Analysis can discover continuity objects in the source. Merge them with
    // manually created objects while preserving approved references.
    const previousAssets = (previous.assets ?? []).map(item => ({ ...item }));
    const assetIdMap = new Map();
    for (const item of next.assets ?? []) {
      const old = previousAssets.find(candidate => candidate.id === item.id || candidate.name === item.name);
      if (old) {
        assetIdMap.set(item.id, old.id);
        Object.assign(old, {
          ...item,
          id: old.id,
          reference: old.reference ?? null,
          referenceVersion: old.referenceVersion ?? null,
          approved: old.approved === true,
          version: old.version ?? item.version ?? 1,
        });
      } else {
        previousAssets.push({ ...item, reference: item.reference ?? null, referenceVersion: item.referenceVersion ?? null, approved: item.approved === true, version: item.version ?? 1 });
      }
    }
    next.assets = previousAssets;
    for (const segment of next.segments ?? []) for (const shot of segment.shots ?? []) {
      shot.assetIds = [...new Set((shot.assetIds ?? []).map(id => assetIdMap.get(id) ?? id))];
    }
    const previousCharacters = new Map((previous.characters ?? []).map(item => [item.id, item]));
    next.characters = next.characters.map(item => {
      const old = previousCharacters.get(item.id);
      return old ? { ...item, reference: old.reference ?? null, referenceVersion: old.referenceVersion ?? null, approved: old.approved === true, version: old.version ?? item.version } : item;
    });
    const previousLooks = new Map((previous.looks ?? []).map(item => [item.id, item]));
    next.looks = next.looks.map(item => {
      const old = previousLooks.get(item.id);
      return old ? { ...item, reference: old.reference ?? null, referenceVersion: old.referenceVersion ?? null, approved: old.approved === true, version: old.version ?? item.version } : item;
    });
    const previousScenes = new Map((previous.scenes ?? []).map(item => [item.id, item]));
    next.scenes = next.scenes.map(item => {
      const old = previousScenes.get(item.id);
      return old ? { ...item, reference: old.reference ?? null, referenceVersion: old.referenceVersion ?? null, approved: old.approved === true, version: old.version ?? item.version } : item;
    });
    const previousSegments = new Map((previous.segments ?? []).map(item => [item.id, item]));
    next.segments = next.segments.map(item => {
      const oldSegment = previousSegments.get(item.id);
      if (!oldSegment) return item;
      const previousShots = new Map((oldSegment.shots ?? []).map(shot => [shot.id, shot]));
      return {
        ...item,
        storyboardImage: oldSegment.storyboardImage ?? item.storyboardImage ?? null,
        storyboardImageVersion: oldSegment.storyboardImageVersion ?? item.storyboardImageVersion ?? null,
        storyboardApproved: oldSegment.storyboardApproved === true,
        video: oldSegment.video ?? item.video ?? null,
        videoVersion: oldSegment.videoVersion ?? item.videoVersion ?? null,
        videoDuration: oldSegment.videoDuration ?? item.videoDuration ?? null,
        shots: item.shots.map(shot => {
          const oldShot = previousShots.get(shot.id);
          return oldShot ? { ...shot, image: oldShot.image ?? null, imageVersion: oldShot.imageVersion ?? null, approved: oldShot.approved === true, version: oldShot.version ?? shot.version, video: oldShot.video ?? null, videoVersion: oldShot.videoVersion ?? null, videoDuration: oldShot.videoDuration ?? null } : shot;
        }),
      };
    });
    return next;
  }
  function publishAnalysisProgress(project, progress) {
    if (!progress?.partialAnalysis || !Number.isInteger(progress.readyThroughChunk) || progress.readyThroughChunk < 1) return;
    const materialized = materializeAnalysisState(progress.partialAnalysis, project, { readyThroughChunk: progress.readyThroughChunk, readySegmentCount: progress.readySegmentCount });
    const readySegments = materialized.segments.filter(segment => !Number.isInteger(segment.analysisChunk) || segment.analysisChunk < progress.readyThroughChunk);
    if (!readySegments.length) return;
    materialized.segments = readySegments;
    materialized.analysisReady = { complete: false, readyThroughChunk: progress.readyThroughChunk, readySegmentCount: readySegments.length };
    mergeAnalysisAssets(materialized, project);
    Object.assign(project, materialized);
  }
  function segmentAnalysisReady(project, segment) {
    return project.analysisReady?.complete !== false || segment.analysisReady === true;
  }
  function requireCurrentExport(p, segment) {
    requireExport(p, segment);
    if (p.generationMode === 'segment-board' && segment.videoVersion !== version(p, 'segment-video', segment.id)) fail(`片段 ${segment.number} 的完整视频不是当前版本，不能导出`, 'VIDEO_NOT_READY', 409);
  }
  function invalidateExports(p, segmentId) { p.exports = p.exports.filter(e => e.segmentId !== segmentId); }
  function retimeSegmentShots(segment, targetDuration) {
    const shots = Array.isArray(segment?.shots) ? segment.shots : [];
    if (!shots.length) fail('片段没有可调整时长的镜头', 'INVALID_INPUT');
    const currentTicks = shots.map(shot => Math.max(1, Math.round(Number(shot.duration) * 10)));
    const currentTotal = currentTicks.reduce((total, value) => total + value, 0);
    if (!currentTotal) fail('片段镜头时长无效', 'INVALID_INPUT');
    const targetTicks = Math.round(Number(targetDuration) * 10);
    const ticks = currentTicks.map(value => Math.min(150, Math.max(1, Math.round(value * targetTicks / currentTotal))));
    let delta = targetTicks - ticks.reduce((total, value) => total + value, 0);
    while (delta !== 0) {
      let changed = false;
      for (let index = 0; index < ticks.length && delta !== 0; index += 1) {
        if (delta > 0 && ticks[index] < 150) { const step = Math.min(delta, 150 - ticks[index]); ticks[index] += step; delta -= step; changed = true; }
        else if (delta < 0 && ticks[index] > 1) { const step = Math.min(-delta, ticks[index] - 1); ticks[index] -= step; delta += step; changed = true; }
      }
      if (!changed) fail('当前镜头数量无法在 0.1 到 15 秒范围内调整到目标时长', 'INVALID_INPUT');
    }
    shots.forEach((shot, index) => { shot.duration = ticks[index] / 10; invalidateShot(shot); });
  }
  function invalidateSegmentTiming(p, segment) {
    segment.storyboardImageVersion = null;
    segment.storyboardApproved = false;
    segment.video = null;
    segment.videoVersion = null;
    segment.videoDuration = null;
    for (const shot of segment.shots ?? []) {
      shot.approved = false;
      shot.video = null;
      shot.videoVersion = null;
      shot.videoDuration = null;
    }
    invalidateExports(p, segment.id);
  }
  function invalidateCharacter(p, c) {
    c.version++; c.approved = false;
    for(const look of p.looks??[])if(look.characterId===c.id){look.version++;look.approved=false;}
    for (const segment of p.segments) for (const shot of segment.shots) if (shot.characterIds.includes(c.id)) { invalidateShot(shot); if(segment.generationMode==='segment-board'){segment.storyboardImageVersion=null;segment.storyboardApproved=false;} invalidateExports(p, segment.id); }
  }
  function invalidateLook(p,look){
    look.version++;look.approved=false;
    for(const segment of p.segments)for(const shot of segment.shots)if(shot.sceneId===look.sceneId&&shot.characterIds.includes(look.characterId)){invalidateShot(shot);if(segment.generationMode==='segment-board'){segment.storyboardImageVersion=null;segment.storyboardApproved=false;}invalidateExports(p,segment.id);}
  }
  function invalidateAsset(p, asset) {
    asset.version++; asset.approved = false; asset.referenceVersion = null;
    for (const segment of p.segments) for (const shot of segment.shots ?? []) {
      if (!(shot.assetIds ?? []).includes(asset.id)) continue;
      invalidateShot(shot);
      if (segment.generationMode === 'segment-board') { segment.storyboardImageVersion = null; segment.storyboardApproved = false; }
      invalidateExports(p, segment.id);
    }
  }
  function invalidateScene(p, scene) {
    scene.version = (Number.isInteger(scene.version) ? scene.version : 1) + 1;
    scene.referenceVersion = null;
    scene.approved = false;
    for (const segment of p.segments ?? []) for (const shot of segment.shots ?? []) {
      if (shot.sceneId !== scene.id) continue;
      invalidateShot(shot);
      if (segment.generationMode === 'segment-board' && p.videoMode !== 'traditional') { segment.storyboardImageVersion = null; segment.storyboardApproved = false; }
      invalidateExports(p, segment.id);
    }
  }
  function fallbackLookClassification(kind, name = '', appearance = '') {
    if (kind === 'identity') return { category: '身份基准', key: 'identity-baseline', source: 'fallback' };
    const text = `${name} ${appearance}`;
    const rules = [
      ['杂役/工作服', 'worker-uniform', /杂役|仆役|工装|制服|劳作|弟子服/],
      ['宗门/制服', 'sect-uniform', /宗门|门派|校服|道袍|弟子|长老服/],
      ['战斗服', 'combat', /战斗|作战|铠甲|盔甲|护甲|战袍|武服/],
      ['礼服', 'formal', /礼服|婚服|宫装|华服|长裙|晚礼/],
      ['日常便装', 'casual', /便装|常服|日常|外套|衬衫|长裤|裙子/],
    ];
    const match = rules.find(([, , pattern]) => pattern.test(text));
    return match ? { category: match[0], key: match[1], source: 'fallback' } : { category: '其他', key: 'other', source: 'fallback' };
  }
  function normalizeLookClassification(value, fallback) {
    const source = value && typeof value === 'object' ? value : {};
    const category = typeof source.category === 'string' && LOOK_CATEGORIES.includes(source.category) ? source.category : fallback.category;
    const key = typeof source.key === 'string' && /^[a-z0-9][a-z0-9-]{1,50}$/.test(source.key.trim()) ? source.key.trim() : fallback.key;
    const modelSource = source.source === 'model' ? 'model' : fallback.source;
    const confidence = Number(source.confidence);
    return { category, key, source: modelSource, ...(Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? { confidence } : {}) };
  }
  function legacyLookAssetId(record, kind, characterId, reference) {
    return `legacy-${sourceHash([record?.id, record?.recordType, kind, characterId, record?.lookId, record?.sceneId, record?.version, reference].join('\\0')).slice(0, 28)}`;
  }
  function ensureLookAssets(p) {
    p.lookAssets ??= [];
    if (!Array.isArray(p.lookAssets)) fail('本地作品造型资产库结构无效', 'CORRUPT_DATA', 500);
    let changed = false;
    const existing = new Map(p.lookAssets.filter(item => item && typeof item.reference === 'string').map(item => [item.id, item]));
    const upsert = (input, legacyRecord = null) => {
      if (!input || typeof input.reference !== 'string' || !input.reference.startsWith(`/media/${p.id}/`) || !input.characterId) return;
      const kind = input.kind === 'identity' ? 'identity' : 'look';
      const matching = [...existing.values()].find(item => item.reference === input.reference && item.characterId === input.characterId && item.kind === kind && (item.lookId ?? null) === (input.lookId ?? null));
      const id = input.id || matching?.id || legacyLookAssetId(legacyRecord, kind, input.characterId, input.reference);
      const fallback = fallbackLookClassification(kind, input.name, input.appearance);
      let asset = existing.get(id);
      if (!asset) {
        asset = { id, characterId: input.characterId, kind, lookId: input.lookId ?? null, sceneId: input.sceneId ?? null, name: String(input.name || (kind === 'identity' ? '基础身份参考' : '历史造型')).slice(0, 200), appearance: String(input.appearance || '').slice(0, 4000), reference: input.reference, sourceVersion: Number.isInteger(input.sourceVersion) && input.sourceVersion > 0 ? input.sourceVersion : 1, approved: input.approved === true, createdAt: input.createdAt || now(), ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}), classification: normalizeLookClassification(input.classification, fallback) };
        p.lookAssets.push(asset); existing.set(id, asset); changed = true;
      } else {
        const patch = { ...input, kind, id, reference: input.reference, classification: normalizeLookClassification(asset.classification || input.classification, fallback) };
        for (const key of ['characterId', 'kind', 'lookId', 'sceneId', 'name', 'appearance', 'reference', 'sourceVersion', 'approved', 'createdAt', 'sourceAssetId', 'classification']) {
          if (patch[key] !== undefined && JSON.stringify(asset[key]) !== JSON.stringify(patch[key])) { asset[key] = patch[key]; changed = true; }
        }
      }
      return asset;
    };
    for (const record of p.mediaHistory ?? []) {
      if (!record?.assetUrl || !['character-image', 'look-image'].includes(record.recordType)) continue;
      const kind = record.recordType === 'character-image' ? 'identity' : 'look';
      const look = kind === 'look' ? p.looks?.find(item => item.id === record.lookId) : null;
      const character = p.characters?.find(item => item.id === record.characterId) || (look ? p.characters?.find(item => item.id === look.characterId) : null);
      if (!character) continue;
      upsert({ id: record.lookAssetId, characterId: character.id, kind, lookId: record.lookId ?? look?.id ?? null, sceneId: record.sceneId ?? look?.sceneId ?? null, name: record.lookName ?? look?.name ?? (kind === 'identity' ? `人物身份 · ${character.name}` : '历史造型'), appearance: record.lookAppearance ?? look?.appearance ?? (kind === 'identity' ? character.appearance : ''), reference: record.assetUrl, sourceVersion: record.version, approved: record.approved === true, createdAt: record.createdAt }, record);
    }
    for (const character of p.characters ?? []) if (character.reference) upsert({ characterId: character.id, kind: 'identity', name: `人物身份 · ${character.name}`, appearance: character.appearance, reference: character.reference, sourceVersion: character.referenceVersion ?? character.version, approved: character.approved === true, createdAt: p.updatedAt });
    for (const look of p.looks ?? []) if (look.reference) upsert({ characterId: look.characterId, kind: 'look', lookId: look.id, sceneId: look.sceneId, name: look.name, appearance: look.appearance, reference: look.reference, sourceVersion: look.referenceVersion ?? look.version, approved: look.approved === true, createdAt: p.updatedAt });
    return changed;
  }
  async function classifyLookAsset(project, input) {
    const fallback = fallbackLookClassification(input.kind, input.name, input.appearance);
    if (typeof providers.classifyLookAsset !== 'function') return fallback;
    try {
      return normalizeLookClassification(await providers.classifyLookAsset(project, input), fallback);
    } catch {
      return fallback;
    }
  }
  function registerLookAsset(p, input) {
    ensureLookAssets(p);
    const fallback = fallbackLookClassification(input.kind, input.name, input.appearance);
    const existing = p.lookAssets.find(item => item.reference === input.reference && item.characterId === input.characterId && item.kind === input.kind && (item.lookId ?? null) === (input.lookId ?? null));
    if (existing) {
      if (input.classification) existing.classification = normalizeLookClassification(input.classification, fallback);
      return existing;
    }
    const asset = { id: randomUUID(), characterId: input.characterId, kind: input.kind === 'identity' ? 'identity' : 'look', lookId: input.lookId ?? null, sceneId: input.sceneId ?? null, name: String(input.name || (input.kind === 'identity' ? '基础身份参考' : '场景造型')).slice(0, 200), appearance: String(input.appearance || '').slice(0, 4000), reference: input.reference, sourceVersion: Number.isInteger(input.sourceVersion) && input.sourceVersion > 0 ? input.sourceVersion : 1, approved: input.approved === true, createdAt: now(), ...(input.sourceAssetId ? { sourceAssetId: input.sourceAssetId } : {}), classification: normalizeLookClassification(input.classification, fallback) };
    p.lookAssets.push(asset);
    return asset;
  }
  function recordMedia(p,record){
    if(!record||typeof record!=='object'||typeof record.assetUrl!=='string')return;
    p.mediaHistory ??=[];
    const prompt = typeof record.prompt === 'string' && record.prompt.trim()
      && !/data:image|bearer\s|api.?key|sk-[a-z0-9]/i.test(record.prompt)
      ? record.prompt.trim().slice(0, 12000)
      : undefined;
    const { prompt: _ignoredPrompt, ...safeRecord } = record;
    p.mediaHistory.push({
      id: randomUUID(), projectId: p.id, projectTitle: p.title, createdAt: now(),
      ...copy(safeRecord),
      ...(prompt ? { prompt } : {}),
    });
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
    for (const assetId of shot.assetIds ?? []) {
      const asset=findAsset(p,assetId);
      if(!asset.approved||!asset.reference||asset.referenceVersion!==asset.version)fail(`请先确认关键物品「${asset.name}」的当前参考图`,'ASSET_NOT_APPROVED',409);
    }
    if(p.generationMode==='segment-board' && p.videoMode !== 'traditional')return;
    if (p.videoMode === 'traditional') {
      const scene = findScene(p, shot.sceneId);
      if (!scene.approved || !scene.reference || scene.referenceVersion !== scene.version) fail(`请先确认场景「${scene.name}」的当前参考图`, 'SCENE_NOT_APPROVED', 409);
    }
    requireCharacters(p,shot);
    const lookIds=(p.looks??[]).filter(look=>look.sceneId===shot.sceneId&&shot.characterIds.includes(look.characterId)).map(look=>look.id);
    if(p.jobs.some(j=>((j.kind==='character'&&shot.characterIds.includes(j.targetId))||(j.kind==='look'&&lookIds.includes(j.targetId)))&&blocksCurrent(p,j)))fail('当前场景的身份或造型任务仍在执行或待核实','ACTIVE_JOB',409);
  }
  function schedule(id, jid) {
    if (closed) return;
    const key = `${id}/${jid}`;
    const kind = projects.get(id)?.jobs.find(job => job.id === jid)?.kind;
    if (queuedKeys.has(key)) {
      // A paused analysis can still have an in-flight provider call. Preserve
      // a resume request so the old run's finally block can enqueue the same
      // durable job after it releases the task key.
      const pending = projects.get(id)?.jobs.find(job => job.id === jid);
      if (pending?.kind === 'analyze' && pending.status === 'queued') pending.analysisSchedulePending = true;
      return;
    }
    queuedKeys.add(key);
    const item = { id, jid, key, kind };
    // Media submissions are independent provider requests. Start them right
    // away so an ordered analysis/export job cannot hold back a batch.
    if (parallelKinds.has(kind)) {
      // Let the current mutation finish and allow sibling project mutations to
      // enqueue before a parallel job takes the state lock for its first step.
      // This preserves durable job creation while preventing cross-project
      // analysis from being serialized by the bookkeeping lock.
      setTimeout(() => { if (!closed) startQueued(item); }, 0);
      return;
    }
    queue.push(item);
    if (!pumping) { pumping = true; worker = Promise.resolve().then(pump); }
  }
  function addJob(p, kind, targetId, { ignoreJobId, videoModel, videoResolution, analysisModel, analysisAppend = false, analysisBaseLength, analysisBaseHash, analysisBaseSegments, batchId, batchLabel } = {}) {
    const existing = p.jobs.find(j => j.id !== ignoreJobId && j.kind === kind && j.targetId === targetId && blocksCurrent(p, j));
    if (existing) return existing;
    let videoSelection = {};
    const configuredVideoModel = videoModel ?? (typeof providers.getVideoModel === 'function' ? providers.getVideoModel() : undefined);
    if (['video', 'segment-video'].includes(kind) && typeof configuredVideoModel === 'string' && configuredVideoModel.trim()) {
      const selected = resolveVideoOption(configuredVideoModel, videoResolution);
      const duration = kind === 'segment-video' ? findSegment(p, targetId).duration : findShot(p, targetId).shot.duration;
      const fixedDuration = selected.minDurationSeconds === selected.maxDurationSeconds;
      const storyboardMaxDuration = p.generationMode === 'segment-board' && configuredVideoModel.toLowerCase() !== 'xiongmao-seedance-2-5-special' ? 15 : selected.maxDurationSeconds;
      const maxDuration = Math.min(selected.maxDurationSeconds, storyboardMaxDuration);
      const minDuration = selected.minDurationSeconds ?? 4;
      const minViolation = kind === 'segment-video' && duration < minDuration;
      if (minViolation || duration > maxDuration || (fixedDuration && duration !== minDuration)) fail(`${selected.label} 单次支持 ${minDuration} 到 ${maxDuration} 秒，当前片段为 ${duration} 秒。请切换模型或调整片段时长。`, 'VIDEO_DURATION_UNSUPPORTED', 400);
      videoSelection = {
        videoModel: selected.videoModel,
        videoResolution: selected.videoResolution,
        estimatedCostCny: estimateVideoCostCny(selected.videoModel, selected.videoResolution, duration),
        estimatedCostCnyRange: estimateVideoCostRangeCny(selected.videoModel, selected.videoResolution, duration),
      };
    }
    const job = { id: randomUUID(), kind, targetId, status: 'queued', progress: 0, businessId: randomUUID(), ...(batchId ? { batchId } : {}), ...(batchLabel ? { batchLabel } : {}), ...videoSelection, ...(kind === 'analyze' ? { analysisModel: analysisModel || p.llmModel || DEFAULT_LLM_MODEL } : {}), ...(analysisAppend ? { analysisAppend: true, analysisBaseLength, analysisBaseHash, analysisBaseSegments } : {}), inputVersion: version(p, kind, targetId), submissionStarted: false, createdAt: now(), updatedAt: now() };
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
  function generationPromptOptions(id, jid, options = {}) {
    return {
      ...options,
      onPrompt: async prompt => {
        if (typeof prompt !== 'string' || !prompt.trim()) return;
        await jobChange(id, jid, (_p, job) => {
          job.generationPrompt = prompt.trim().slice(0, 12000);
        });
      },
    };
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
        const retryJob = projects.get(item.id)?.jobs.find(job => job.id === item.jid);
        if (retryJob?.status === 'queued' && (retryJob.analysisAutoRetryPending || retryJob.analysisSchedulePending) && !closed && !deletedProjects.has(item.id)) {
          retryJob.analysisAutoRetryPending = false;
          retryJob.analysisSchedulePending = false;
          await save(projects.get(item.id)).catch(() => {});
          schedule(item.id, item.jid);
        }
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
      const recoveringImage = job.submissionStarted && ['character', 'asset', 'scene', 'look', 'image', 'storyboard'].includes(job.kind);
      const recoveringAnalysis = job.submissionStarted && job.kind === 'analyze' && (job.analysisRetryDeterministic === true || Boolean(job.analysisRetryOf));
      if (job.submissionStarted && job.kind !== 'export' && !recoveringImage && !recoveringAnalysis) { await jobChange(id, jid, (_p, j) => { j.status = 'unknown'; j.error = '上次请求结果不明确，禁止自动重复提交'; }); return; }
      await jobChange(id, jid, (_p, j) => { j.submissionStarted = true; });
      if (closed) return;
      let result;
      if (recoveringImage) {
        if (typeof providers.recoverImage !== 'function') throw new Error('没有可查询的图片回执，任务保持待核实；不会重新付费提交');
        result = mediaUrl(await providers.recoverImage(p, job.businessId), p);
      }
      else if (job.kind === 'analyze') {
        const analysis = await providers.analyze(p, job.businessId, {
          analysisModel: job.analysisModel,
          analysisAppend: Boolean(job.analysisAppend),
          appendFrom: job.analysisBaseLength,
          analysisBaseSegments: job.analysisBaseSegments,
          retryUncertain: Boolean(job.analysisRetryOf && p.jobs.some(previous => previous.id === job.analysisRetryOf && previous.analysisRetryJobId === job.id && previous.analysisRetryAcceptedAt)),
          retryDeterministic: Boolean(job.analysisRetryDeterministic || (job.analysisAutoRetryCount ?? 0) > 0),
          onProgress: async progress => {
            if (closed) fail('服务正在关闭，已保存分析进度', 'SERVICE_CLOSED', 503);
            return jobChange(id, jid, (_live, liveJob) => {
            if (liveJob.analysisPauseRequested || liveJob.status === 'paused') {
              const paused = new Error('分析已暂停，已保存完成分块；点击继续即可从检查点恢复。');
              paused.code = 'ANALYSIS_PAUSED'; paused.definitive = true; paused.safe = true;
              throw paused;
            }
            if (liveJob.status === 'running') {
              liveJob.progress = progress.totalChunks ? Math.round((progress.completedChunks / progress.totalChunks) * 100) : 0;
              liveJob.analysisProgress = { completedChunks: progress.completedChunks, totalChunks: progress.totalChunks, phase: progress.phase, model: progress.model, ...(Number.isInteger(progress.currentChunk) ? { currentChunk: progress.currentChunk } : {}), ...(Array.isArray(progress.currentEpisodes) ? { currentEpisodes: progress.currentEpisodes } : {}), ...(Number.isInteger(progress.readyThroughChunk) ? { readyThroughChunk: progress.readyThroughChunk } : {}), ...(Number.isInteger(progress.readySegmentCount) ? { readySegmentCount: progress.readySegmentCount } : {}) };
              publishAnalysisProgress(_live, progress);
            }
            });
          }
        });
        if (job.analysisAppend) {
          const baseSegments = Number.isInteger(job.analysisBaseSegments) ? job.analysisBaseSegments : 0;
          if (!Array.isArray(analysis?.segments) || analysis.segments.length <= baseSegments) fail('追加分析没有返回新增片段。', 'ANALYSIS_INVALID');
          const appended = validateAnalysis({
            characters: analysis.characters,
            assets: [...(p.assets ?? []), ...(analysis.assets ?? [])],
            scenes: analysis.scenes,
            looks: analysis.looks,
            segments: analysis.segments.slice(baseSegments),
          }, p);
          const oldCharacterIds = new Set(p.characters.map(character => character.id));
          const oldAssetIds = new Set((p.assets ?? []).map(asset => asset.id));
          const oldSceneIds = new Set((p.scenes ?? []).map(scene => scene.id));
          const oldLookIds = new Set((p.looks ?? []).map(look => look.id));
          result = {
            workflowVersion: 2,
            characters: [...p.characters, ...appended.characters.filter(character => !oldCharacterIds.has(character.id))],
            assets: [...(p.assets ?? []), ...(appended.assets ?? []).filter(asset => !oldAssetIds.has(asset.id))],
            scenes: [...(p.scenes ?? []), ...appended.scenes.filter(scene => !oldSceneIds.has(scene.id))],
            looks: [...(p.looks ?? []), ...appended.looks.filter(look => !oldLookIds.has(look.id))],
            segments: [...p.segments, ...appended.segments.map((segment, index) => ({ ...segment, number: p.segments.length + index + 1 }))],
            analysisWarnings: [...(p.analysisWarnings ?? []), ...(Array.isArray(analysis?.analysisWarnings) ? copy(analysis.analysisWarnings) : [])],
          };
        } else {
          const validated = validateAnalysis(analysis, p);
          result = {
            ...validated,
            analysisWarnings: Array.isArray(analysis?.analysisWarnings) ? copy(analysis.analysisWarnings) : [],
          };
        }
      }
      else if (job.kind === 'character') {
        const imageOptions=generationPromptOptions(id,jid,{async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}});
        result = mediaUrl(await providers.generateCharacter(p, findCharacter(p, job.targetId), job.businessId, imageOptions), p);
      }
      else if (job.kind === 'asset') {
        const imageOptions=generationPromptOptions(id,jid,{async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}});
        result = mediaUrl(await providers.generateAsset(p, findAsset(p, job.targetId), job.businessId, imageOptions), p);
      }
      else if (job.kind === 'scene') {
        const imageOptions=generationPromptOptions(id,jid,{async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}});
        if (typeof providers.generateScene !== 'function') fail('当前服务不支持场景参考图生成。', 'IMAGE_PROVIDER_UNSUPPORTED', 409);
        result = mediaUrl(await providers.generateScene(p, findScene(p, job.targetId), job.businessId, imageOptions), p);
      }
      else if(job.kind==='look'){
        const look=findLook(p,job.targetId);identityReady(p,look.characterId);
        const imageOptions=generationPromptOptions(id,jid,{async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}});
        result=mediaUrl(await providers.generateLook(p,look,job.businessId,imageOptions),p);
      }
      else if (job.kind === 'image') {
        const { shot } = findShot(p, job.targetId); shotAssetsReady(p, shot);
        const imageOptions=generationPromptOptions(id,jid,{async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}});
        result = mediaUrl(await providers.generateShot(p, shot, job.businessId, imageOptions), p);
      }
      else if (job.kind === 'storyboard') {
        const segment=findSegment(p,job.targetId);
        if(p.generationMode!=='segment-board') fail('当前作品不是片段级整板模式。','INVALID_INPUT');
        const imageOptions=generationPromptOptions(id,jid,{async:true,onSubmitted:async submitted=>{if(!submitted?.id)return;await jobChange(id,jid,(_p,j)=>{j.providerTaskId=submitted.id;j.progress=Math.min(99,Number(submitted.progress)||0);});}});
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
      let continuityInput = null;
      if (job.kind === 'character') {
        const character = findCharacter(p, job.targetId);
        continuityInput = { kind: 'identity', characterId: character.id, name: `人物身份 · ${character.name}`, appearance: character.appearance, reference: result, sourceVersion: character.version, approved: false };
      } else if (job.kind === 'look') {
        const look = findLook(p, job.targetId);
        continuityInput = { kind: 'look', characterId: look.characterId, lookId: look.id, sceneId: look.sceneId, name: look.name, appearance: look.appearance, reference: result, sourceVersion: look.version, approved: false };
      }
      const continuityClassification = continuityInput ? await classifyLookAsset(p, continuityInput) : null;
      await jobChange(id, jid, (live, j) => {
        if (j.kind === 'analyze' && (j.status === 'paused' || j.analysisPauseRequested)) {
          const paused = new Error('分析已暂停，已保存完成分块；点击继续即可从检查点恢复。');
          paused.code = 'ANALYSIS_PAUSED'; paused.definitive = true; paused.safe = true;
          throw paused;
        }
        if (!current(live, j)) { j.status = 'interrupted'; j.error = '输入已修改，已返回结果不会替换当前素材'; return; }
        if (j.kind === 'analyze') {
          const materialized = materializeAnalysisState(result, live);
          mergeAnalysisAssets(materialized, live);
          materialized.analysisReady = { complete: true, readyThroughChunk: j.analysisProgress?.totalChunks ?? undefined, readySegmentCount: materialized.segments.length };
          Object.assign(live, materialized);
          live.analysisSourceLength = live.novel.length;
          live.analysisSourceHash = sourceHash(live.novel);
          j.analysisRetryable = undefined;
          j.analysisPauseRequested = false;
        }
        else if (j.kind === 'character') { const c = findCharacter(live, j.targetId); invalidateCharacter(live, c); c.reference = result; c.referenceVersion = c.version; const asset = registerLookAsset(live, { ...continuityInput, characterId: c.id, sourceVersion: c.version, approved: false, classification: continuityClassification }); recordMedia(live, { recordType: 'character-image', assetUrl: result, assetTitle: `人物身份 · ${c.name}`, segmentTitle: '人物资料', characterId: c.id, characterName: c.name, version: c.version, lookAssetId: asset.id, lookName: asset.name, lookAppearance: asset.appearance, approved: false, prompt: j.generationPrompt }); }
        else if (j.kind === 'asset') { const asset = findAsset(live, j.targetId); invalidateAsset(live, asset); asset.reference = result; asset.referenceVersion = asset.version; recordMedia(live, { recordType: 'asset-image', assetUrl: result, assetTitle: `关键物品 · ${asset.name}`, segmentTitle: '关键物品', assetId: asset.id, assetName: asset.name, version: asset.version, prompt: j.generationPrompt }); }
        else if (j.kind === 'scene') { const scene = findScene(live, j.targetId); invalidateScene(live, scene); scene.reference = result; scene.referenceVersion = scene.version; recordMedia(live, { recordType: 'scene-image', assetUrl: result, assetTitle: `场景参考 · ${scene.name}`, segmentTitle: '场景资料', sceneId: scene.id, sceneTitle: scene.name, version: scene.version, prompt: j.generationPrompt }); }
        else if(j.kind==='look'){const look=findLook(live,j.targetId);invalidateLook(live,look);look.reference=result;look.referenceVersion=look.version;const scene=live.scenes?.find(item=>item.id===look.sceneId);const character=live.characters?.find(item=>item.id===look.characterId);const asset=registerLookAsset(live,{...continuityInput,characterId:look.characterId,lookId:look.id,sceneId:look.sceneId,name:look.name,appearance:look.appearance,sourceVersion:look.version,approved:false,classification:continuityClassification});recordMedia(live,{recordType:'look-image',assetUrl:result,assetTitle:`场景造型 · ${look.name}`,segmentTitle:scene?.name||'场景造型',sceneId:look.sceneId,sceneTitle:scene?.name,characterId:look.characterId,characterName:character?.name,lookId:look.id,lookName:look.name,lookAppearance:look.appearance,version:look.version,lookAssetId:asset.id,approved:false,prompt:j.generationPrompt});}
        else if (j.kind === 'image') { const { shot, segment } = findShot(live, j.targetId); invalidateShot(shot); shot.image = result; shot.imageVersion = shot.version; invalidateExports(live, segment.id); recordMedia(live, { recordType: 'shot-image', assetUrl: result, assetTitle: `镜头 ${String(shot.number).padStart(2,'0')} · 分镜图片`, segmentId: segment.id, segmentTitle: segment.title, sceneId: shot.sceneId, sceneTitle: live.scenes?.find(item => item.id === shot.sceneId)?.name, shotId: shot.id, number: shot.number, version: shot.version, prompt: j.generationPrompt }); }
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
            recordMedia(live,{recordType:'shot-image',assetUrl:cropped,assetTitle:`镜头 ${String(shot.number).padStart(2,'0')} · 整板裁切图`,segmentId:segment.id,segmentTitle:segment.title,sceneId:shot.sceneId,sceneTitle:live.scenes?.find(item=>item.id===shot.sceneId)?.name,shotId:shot.id,number:shot.number,version:shot.version,prompt:j.generationPrompt});
          }
          segment.storyboardImageVersion=version(live,'storyboard',segment.id);
          recordMedia(live,{recordType:'storyboard-image',assetUrl:result.storyboardImage,assetTitle:`整段分镜板 · ${segment.title}`,segmentId:segment.id,segmentTitle:segment.title,version:segment.storyboardImageVersion,prompt:j.generationPrompt});
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
        if (error.code === 'ANALYSIS_PAUSED') {
          // The user may resume while the provider call is unwinding. In
          // that case the resumed queued state belongs to the new run and
          // this stale pause result must not overwrite it.
          if (j.status !== 'queued' || j.analysisPauseRequested) {
            j.status = 'paused';
            j.analysisPauseRequested = false;
            j.analysisRetryDeterministic = true;
            j.error = safeError(error, 'paused');
          }
          return;
        }
        const canAutoRetry = j.kind === 'analyze' && error.analysisRetryable === true && j.submissionStarted && !j.analysisPauseRequested && (j.analysisAutoRetryCount ?? 0) < ANALYSIS_AUTO_RETRIES;
        if (canAutoRetry) {
          j.status = 'queued';
          j.analysisAutoRetryCount = (j.analysisAutoRetryCount ?? 0) + 1;
          j.analysisRetryDeterministic = true;
          j.analysisAutoRetryPending = true;
          j.error = `第 ${(Number.isInteger(error.analysisChunk) ? error.analysisChunk : 0) + 1} 个分析块校验失败，正在自动重试（${j.analysisAutoRetryCount}/${ANALYSIS_AUTO_RETRIES}）。`;
          return;
        }
        const legacyBudgetFailure = j.kind === 'analyze' && isLegacyBudgetValidationFailure(error?.message);
        const definitive = error.definitive === true || error.safeToRetry === true || legacyBudgetFailure || ['NOT_CONFIGURED', 'INVALID_INPUT', 'CHARACTER_NOT_APPROVED', 'LOOK_NOT_APPROVED', 'STALE_ASSET', 'ACTIVE_JOB', 'INVALID_MEDIA', 'PROVIDER_REJECTED', 'DIALOGUE_SPEAKER_REQUIRED'].includes(error.code);
        const unresolvedImageRecovery = job.submissionStarted && ['image', 'character', 'look', 'storyboard'].includes(job.kind) && !j.providerTaskId && !definitive;
        const unresolvedVideoQuery = ['video', 'segment-video'].includes(j.kind) && (j.providerTaskId || job.submissionStarted);
        j.status = !unresolvedImageRecovery && !unresolvedVideoQuery && (!j.submissionStarted || j.kind === 'export' || definitive) ? 'failed' : 'unknown';
        if (j.kind === 'analyze' && (error.analysisRetryable === true || legacyBudgetFailure)) {
          j.analysisRetryable = true;
          j.analysisChunk = Number.isInteger(error.analysisChunk) ? error.analysisChunk : undefined;
          if (legacyBudgetFailure) j.analysisRetryDeterministic = true;
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
      const submitted = await providers.submitVideo(p, shot, job.businessId, job.videoModel, job.videoResolution, {
        onPrompt: prompt => jobChange(p.id, job.id, (_p, liveJob) => { liveJob.generationPrompt = String(prompt).trim().slice(0, 12000); }),
      });
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
           recordMedia(live,{recordType:'shot-video',assetUrl:url,assetTitle:`镜头 ${String(currentShot.number).padStart(2,'0')} · 镜头视频`,segmentId:currentSegment.id,segmentTitle:currentSegment.title,sceneId:currentShot.sceneId,sceneTitle:live.scenes?.find(item=>item.id===currentShot.sceneId)?.name,shotId:currentShot.id,number:currentShot.number,version:currentShot.version,duration:currentShot.videoDuration,prompt:j.generationPrompt});
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
      const submitted = await providers.submitSegmentVideo(p, segment, job.businessId, job.videoModel, job.videoResolution, {
        onPrompt: prompt => jobChange(p.id, job.id, (_p, liveJob) => { liveJob.generationPrompt = String(prompt).trim().slice(0, 12000); }),
      });
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
          recordMedia(live, { recordType: 'segment-video', assetUrl: url, assetTitle: `片段 ${String(currentSegment.number).padStart(3, '0')} · 完整视频`, segmentId: currentSegment.id, segmentTitle: currentSegment.title, number: currentSegment.number, version: currentSegment.videoVersion, duration: currentSegment.videoDuration, prompt: j.generationPrompt });
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
         for(const asset of p.assets||[])addCurrent({id:`asset:${p.id}:${asset.id}:${asset.version}`,projectId:p.id,projectTitle:p.title,recordType:'asset-image',assetUrl:asset.reference,assetTitle:`关键物品 · ${asset.name}`,segmentTitle:'关键物品',assetId:asset.id,assetName:asset.name,createdAt:p.updatedAt,version:asset.version});
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
      onlyFields(patch,['boardTemplateId','duration']);
      if(patch.boardTemplateId===undefined&&patch.duration===undefined)fail('请指定分镜设定板模板或片段时长');
      const segment=findSegment(p,segmentId);
      const durationChanged=patch.duration!==undefined&&Number(patch.duration)!==Number(segment.duration);
      const templateChanged=patch.boardTemplateId!==undefined&&patch.boardTemplateId!==segment.boardTemplateId;
      if(patch.boardTemplateId!==undefined)getBoardTemplate(patch.boardTemplateId);
      if(!durationChanged&&!templateChanged)return;
      const targetIds=new Set([segmentId,...(segment.shots??[]).map(shot=>shot.id)]);
      if(p.jobs.some(job=>targetIds.has(job.targetId)&&blocksCurrent(p,job)))fail('片段任务仍在执行或待核实，请完成后再调整','ACTIVE_JOB',409);
      if(durationChanged){
        if(![15,30].includes(patch.duration))fail('片段时长只能选择 15 或 30 秒');
        if(p.generationMode!=='segment-board')fail('只有九宫格或传统片段模式可以调整片段总时长');
        if(p.durationMode==='fixed'&&patch.duration!==p.duration)fail(`固定时长作品的片段必须保持 ${p.duration} 秒`,'INVALID_INPUT');
        retimeSegmentShots(segment,patch.duration);
        segment.duration=patch.duration;
        segment.extendedDuration=patch.duration===30;
        invalidateSegmentTiming(p,segment);
      }
      if(templateChanged){
        segment.boardTemplateId=patch.boardTemplateId;
        if(segment.generationMode==='segment-board'){segment.storyboardImageVersion=null;segment.storyboardApproved=false;}
      }
    });},
    async create(input) { if (closed) fail('工作台正在关闭', 'CLOSED', 503); return exclusive(async () => { const selectedModel = input?.llmModel ?? (typeof providers.getLlmModel === 'function' ? providers.getLlmModel() : DEFAULT_LLM_MODEL); const p = createProject({ ...input, llmModel: selectedModel }); await save(p); projects.set(p.id, p); return copy(p); }); },
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
      onlyFields(patch, ['title', 'novel', 'style', 'llmModel', 'visualStyle', 'sourceType', 'narrativeMode', 'aspectRatio', 'duration', 'durationMode', 'videoMode']);
      const structuralChanges = Object.keys(patch).filter(key => key !== 'title' && patch[key] !== p[key]);
      const novelChanged = typeof patch.novel === 'string' && patch.novel !== p.novel;
      const analyzed = p.segments.length || p.characters.length || p.scenes.length || p.looks.length;
      if (analyzed && novelChanged) {
        const baseLength = Number.isInteger(p.analysisSourceLength) ? p.analysisSourceLength : p.novel.length;
        const baseHash = typeof p.analysisSourceHash === 'string' ? p.analysisSourceHash : sourceHash(p.novel.slice(0, baseLength));
        const prefixIsStable = patch.novel.startsWith(p.novel) && sourceHash(patch.novel.slice(0, baseLength)) === baseHash;
        if (structuralChanges.some(key => key !== 'novel') || !prefixIsStable) fail('已分析作品只允许在原稿末尾追加内容；请保留已分析正文、模型和结构设置。', 'STRUCTURE_LOCKED', 409);
        if (p.jobs.some(job => ['queued', 'running', 'paused', 'unknown'].includes(job.status))) fail('当前仍有分析或模型任务，请完成后再追加原稿。', 'ACTIVE_JOB', 409);
        p.novel = projectInput({ ...p, novel: patch.novel }).novel;
        return;
      }
      if ((analyzed || p.jobs.some(j => blocksCurrent(p, j))) && structuralChanges.length) fail('已分析作品不能修改小说、文字模型、视觉媒介、风格、画幅或片段时长等结构设置，请新建作品', 'STRUCTURE_LOCKED', 409);
      Object.assign(p, projectInput({ ...p, ...patch }));
    }); },
    async resetDuration(id, body = {}) { return mutate(id, p => {
      onlyFields(body, ['duration', 'durationMode']);
      if (![15, 30].includes(body.duration)) fail('重新规划时长只能选择 15 或 30 秒');
      if (p.generationMode === 'segment-board' && p.duration === 15 && body.duration !== 15) fail('新项目只能使用不超过 15 秒的片段');
      if (body.durationMode !== undefined && !['auto', 'fixed'].includes(body.durationMode)) fail('时长模式必须为 auto 或 fixed');
      if (p.jobs.some(job => ['queued', 'running', 'paused', 'unknown'].includes(job.status))) fail('当前仍有进行中或待核实任务，请先完成或核实后再重新规划时长', 'ACTIVE_JOB', 409);
      // Older projects may only have current export pointers and no separate
      // exportHistory yet. Archive those records before clearing the pointers
      // so a duration reset cannot make an existing download disappear.
      const archived = new Map((p.exportHistory ?? []).filter(record => record?.id).map(record => [record.id, record]));
      for (const record of [...(p.exports ?? []), ...(p.projectExports ?? [])]) {
        if (record?.id && !archived.has(record.id)) archived.set(record.id, copy(record));
      }
      p.exportHistory = [...archived.values()];
      const next = projectInput({ ...p, duration: body.duration, durationMode: p.generationMode === 'segment-board' ? 'auto' : (body.durationMode ?? 'fixed') });
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
    async analyze(id) { return mutate(id, p => { if (!p.novel.trim()) fail('请先导入原始内容'); if (p.segments.length || p.characters.length || p.scenes.length || p.looks.length) fail('作品已有分析结果或人工场景，请使用“分析新增内容”', 'ANALYSIS_EXISTS', 409); const failed = p.jobs.find(job => job.kind === 'analyze' && job.status === 'failed' && job.analysisRetryable); if (failed) fail('当前分析块校验失败，请使用“重试当前分析块”继续，不会重复请求已保存内容。', 'ANALYSIS_RETRY_REQUIRED', 409); normalizeSegmentBoardAnalysisBudget(p); return [addJob(p, 'analyze', p.id, { analysisModel: p.llmModel })]; }); },
    async analyzeAppend(id) { return mutate(id, p => {
      if (!p.segments.length && !p.characters.length && !p.scenes.length && !p.looks.length) fail('作品还没有可续接的分析结果，请先进行首次分析。', 'ANALYSIS_EXISTS', 409);
      const baseLength = Number.isInteger(p.analysisSourceLength) ? p.analysisSourceLength : p.novel.length;
      const baseHash = typeof p.analysisSourceHash === 'string' ? p.analysisSourceHash : sourceHash(p.novel.slice(0, baseLength));
      if (p.novel.length <= baseLength || sourceHash(p.novel.slice(0, baseLength)) !== baseHash) fail('没有检测到可靠的新增原稿，请从已分析正文末尾继续追加。', 'NO_APPEND_CONTENT', 409);
      if (p.jobs.some(job => job.kind === 'analyze' && ['queued', 'running', 'paused', 'unknown'].includes(job.status))) fail('请先处理当前分析任务，再分析新增内容。', 'ACTIVE_JOB', 409);
      normalizeSegmentBoardAnalysisBudget(p, { allowExisting: true });
      return [addJob(p, 'analyze', p.id, { analysisModel: p.llmModel, analysisAppend: true, analysisBaseLength: baseLength, analysisBaseHash: baseHash, analysisBaseSegments: p.segments.length })];
    }); },
    async retryAnalysis(id, jid, body = {}) { return mutate(id, p => {
      onlyFields(body, ['confirmDuplicateCost']);
      if (body.confirmDuplicateCost !== true) fail('继续前请确认上次请求可能已计费，本次会再次请求未完成部分', 'RETRY_CONFIRMATION_REQUIRED', 409);
      const previous = p.jobs.find(job => job.id === jid);
      if (!previous) fail('找不到该任务', 'NOT_FOUND', 404);
      const retryableFailedBlock = previous.kind === 'analyze' && previous.status === 'failed'
        && (previous.analysisRetryable === true || isLegacyBudgetValidationFailure(previous.error));
      if (previous.kind !== 'analyze' || (previous.status !== 'unknown' && !retryableFailedBlock)) fail('只有结果待核实或当前块校验失败的小说分析可在确认后继续', 'CANNOT_RESUME', 409);
      // Idempotency is tied to the original attempt, even after the follow-up
      // finishes or also times out. A later unknown attempt needs new consent.
      if (previous.analysisRetryJobId) return [];
      if (!current(p, previous)) fail('任务对应旧版原稿，请先核对当前输入', 'STALE_INPUT', 409);
      const hasAnalysisState = Boolean(p.segments.length || p.characters.length || p.scenes.length || p.looks.length);
      // A service restart can turn a running analysis into `unknown` after a
      // safe front has already been published. The restart path cannot know
      // whether the provider received the current chunk, so the same explicit
      // acknowledgement must reopen that pending checkpoint. Do not allow a
      // completed analysis (or an unrelated manually populated project) to be
      // overwritten by this path.
      const hasPartialAnalysisCheckpoint = p.analysisReady?.complete === false
        || (Number.isInteger(previous.analysisProgress?.completedChunks)
          && Number.isInteger(previous.analysisProgress?.totalChunks)
          && previous.analysisProgress.completedChunks > 0
          && previous.analysisProgress.completedChunks < previous.analysisProgress.totalChunks);
      const resumablePartialCheckpoint = previous.analysisAppend !== true
        && (previous.status === 'unknown' || previous.analysisRetryable === true)
        && hasPartialAnalysisCheckpoint;
      if (!previous.analysisAppend && hasAnalysisState && !resumablePartialCheckpoint) fail('作品已有分析结果或人工场景，不能覆盖', 'ANALYSIS_EXISTS', 409);
      if (p.jobs.some(job => job.id !== jid && blocksCurrent(p, job))) fail('请先处理当前仍在执行或待核实的任务', 'ACTIVE_JOB', 409);
      const acceptedAt = now();
      // Save the acknowledgment and the new job atomically before scheduling.
      // The original status/error remains a truthful record of the lost result.
      const next = addJob(p, 'analyze', p.id, {
        ignoreJobId: previous.id,
        analysisModel: previous.analysisModel || p.llmModel,
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
    async pauseAnalysis(id, jid) { return mutate(id, p => {
      const job = p.jobs.find(item => item.id === jid);
      if (!job) fail('找不到该任务', 'NOT_FOUND', 404);
      if (job.kind !== 'analyze' || !active(job)) fail('只有进行中的文本分析可以暂停', 'CANNOT_PAUSE', 409);
      job.analysisPauseRequested = true;
      job.analysisRetryDeterministic = true;
      job.status = 'paused';
      job.error = '已请求暂停；当前模型请求结束后会保存检查点。';
      return [];
    }); },
    async createScene(id,input){return mutate(id,p=>{
      onlyFields(input,['name','description']);
      if(p.jobs.some(j=>j.kind==='analyze'&&['queued','running','paused','unknown'].includes(j.status)&&current(p,j)))fail('请等待小说分析完成后再创建场景','ACTIVE_JOB',409);
      if(p.scenes.length>=300)fail('场景数量超过上限');p.scenes.push({id:randomUUID(),...sceneFields(input),reference:null,referenceVersion:null,approved:false,version:1});
    });},
    async updateScene(id,sceneId,patch){return mutate(id,p=>{
      onlyFields(patch,['name','description']);const scene=findScene(p,sceneId),before=JSON.stringify(scene);
      Object.assign(scene,sceneFields({...scene,...patch}));
      if(JSON.stringify(scene)===before)return;
      invalidateScene(p, scene);
      for(const look of p.looks)if(look.sceneId===sceneId){look.version++;look.approved=false;}
    });},
    async sceneAction(id, sceneId, action, body = {}) {
      if (action === 'upload') {
        const p = await service.get(id); const scene = findScene(p, sceneId); expectedVersion(scene, body); const before = scene.version;
        const url = mediaUrl(await providers.importImage(p, body.dataUrl), p);
        return mutate(id, live => { const currentScene = findScene(live, sceneId); expectedVersion(currentScene, body); if (currentScene.version !== before) fail('场景已修改，请重新上传', 'STALE_INPUT', 409); invalidateScene(live, currentScene); currentScene.reference = url; currentScene.referenceVersion = currentScene.version; recordMedia(live, { recordType: 'scene-image', assetUrl: url, assetTitle: `场景参考 · ${currentScene.name}`, segmentTitle: '场景资料', sceneId: currentScene.id, sceneTitle: currentScene.name, version: currentScene.version, source: 'upload' }); });
      }
      return mutate(id, p => {
        const scene = findScene(p, sceneId); expectedVersion(scene, body);
        if (action === 'generate') { if (body.reuseExisting === true && scene.reference && scene.referenceVersion === scene.version) return; return [addJob(p, 'scene', sceneId)]; }
        if (action !== 'approve') fail('未知场景操作'); reviewedVersion(scene, body);
        if (p.jobs.some(job => job.kind === 'scene' && job.targetId === sceneId && blocksCurrent(p, job))) fail('场景参考任务仍在执行或待核实，不能审核', 'ACTIVE_JOB', 409);
        if (!scene.reference) fail('请先生成或上传场景参考图');
        if (scene.referenceVersion !== scene.version) fail('场景参考图为旧版或未验证版本，请重新生成或上传', 'STALE_ASSET', 409);
        scene.approved = true;
      });
    },
    async createLook(id,input){return mutate(id,p=>{
      onlyFields(input,['sceneId','characterId','name','appearance']);findScene(p,input.sceneId);identityReady(p,input.characterId);
      if(p.looks.some(look=>look.sceneId===input.sceneId&&look.characterId===input.characterId))fail('同一场景和角色已存在造型，请编辑原造型','LOOK_EXISTS',409);
      if(p.looks.length>=900)fail('造型数量超过上限');
      p.looks.push({id:randomUUID(),sceneId:input.sceneId,characterId:input.characterId,...lookFields(input),reference:null,approved:false,version:1});
    });},
    async lookAssets(id, characterId) {
      return exclusive(async () => {
        const p = project(id);
        if (typeof characterId !== 'string' || !characterId.trim()) fail('缺少人物 ID', 'INVALID_INPUT');
        findCharacter(p, characterId);
        ensureLookAssets(p);
        const scenes = new Map((p.scenes ?? []).map(scene => [scene.id, scene.name]));
        const characters = new Map((p.characters ?? []).map(character => [character.id, character.name]));
        return copy((p.lookAssets ?? []).filter(asset => asset.characterId === characterId && asset.reference).map(asset => ({ ...asset, sceneName: asset.sceneId ? scenes.get(asset.sceneId) || '历史场景' : undefined, characterName: characters.get(asset.characterId) || '' })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
      });
    },
    async reuseLook(id, lookId, body = {}) {
      return mutate(id, p => {
        onlyFields(body, ['sourceAssetId', 'expectedVersion']);
        const target = findLook(p, lookId);
        expectedVersion(target, body);
        identityReady(p, target.characterId);
        ensureLookAssets(p);
        const source = p.lookAssets.find(asset => asset.id === body.sourceAssetId && asset.reference);
        if (!source) fail('找不到可复用的造型图片', 'LOOK_ASSET_NOT_FOUND', 404);
        if (source.characterId !== target.characterId) fail('只能复用同一人物的身份图或历史造型', 'LOOK_ASSET_CHARACTER_MISMATCH', 409);
        mediaUrl(source.reference, p);
        // An identity asset carries the outfit used for the character's
        // baseline portrait. Copy that fact into the target look as well so
        // the selected image and editable look description cannot disagree.
        if (source.kind === 'look' && source.name) target.name = source.name;
        if (source.appearance) target.appearance = source.appearance;
        invalidateLook(p, target);
        target.reference = source.reference;
        target.referenceVersion = target.version;
        target.approved = false;
        const scene = p.scenes?.find(item => item.id === target.sceneId);
        const character = p.characters?.find(item => item.id === target.characterId);
        const asset = registerLookAsset(p, { kind: 'look', characterId: target.characterId, lookId: target.id, sceneId: target.sceneId, name: target.name, appearance: target.appearance, reference: source.reference, sourceVersion: target.version, approved: false, sourceAssetId: source.id, classification: source.classification });
        recordMedia(p, { recordType: 'look-image', assetUrl: source.reference, assetTitle: `场景造型 · ${target.name}`, segmentTitle: scene?.name || '场景造型', sceneId: target.sceneId, sceneTitle: scene?.name, characterId: target.characterId, characterName: character?.name, lookId: target.id, lookName: target.name, lookAppearance: target.appearance, version: target.version, lookAssetId: asset.id, approved: false, source: 'reuse', sourceAssetId: source.id });
      });
    },
    async createAsset(id,input){return mutate(id,p=>{
      onlyFields(input,['name','kind','description']);
      if (p.assets.length >= 300) fail('关键物品数量超过上限');
      p.assets.push({id:randomUUID(),...assetFields(input),reference:null,referenceVersion:null,approved:false,version:1,createdAt:now(),updatedAt:now()});
    });},
    async updateAsset(id,assetId,patch){return mutate(id,p=>{
      onlyFields(patch,['name','kind','description']);
      const asset=findAsset(p,assetId); const before=JSON.stringify(asset);
      Object.assign(asset,assetFields({...asset,...patch}),{updatedAt:now()});
      if(JSON.stringify(asset)!==before) invalidateAsset(p,asset);
    });},
    async assetAction(id,assetId,action,body={}){
      if(action==='upload'){
        const p=await service.get(id); const asset=findAsset(p,assetId); expectedVersion(asset,body); const before=asset.version;
        const url=mediaUrl(await providers.importImage(p,body.dataUrl),p);
        return mutate(id,live=>{const currentAsset=findAsset(live,assetId); expectedVersion(currentAsset,body); if(currentAsset.version!==before)fail('关键物品已修改，请重新上传','STALE_INPUT',409); invalidateAsset(live,currentAsset); currentAsset.reference=url; currentAsset.referenceVersion=currentAsset.version; currentAsset.updatedAt=now(); recordMedia(live,{recordType:'asset-image',assetUrl:url,assetTitle:`关键物品 · ${currentAsset.name}`,segmentTitle:'关键物品',assetId:currentAsset.id,assetName:currentAsset.name,version:currentAsset.version,source:'upload'});});
      }
      return mutate(id,p=>{
        const asset=findAsset(p,assetId); expectedVersion(asset,body);
        if(action==='generate'){if(body.reuseExisting===true&&asset.reference&&asset.referenceVersion===asset.version)return; return [addJob(p,'asset',assetId)];}
        if(action!=='approve')fail('未知关键物品操作'); reviewedVersion(asset,body);
        if(p.jobs.some(j=>j.kind==='asset'&&j.targetId===assetId&&blocksCurrent(p,j)))fail('关键物品任务仍在执行或待核实，不能审核','ACTIVE_JOB',409);
        if(!asset.reference)fail('请先生成或上传关键物品参考图');
        if(asset.referenceVersion!==asset.version)fail('关键物品参考图为旧版或未验证版本，请重新生成或上传','STALE_ASSET',409);
        asset.approved=true; asset.updatedAt=now();
      });
    },
    async updateLook(id,lookId,patch){return mutate(id,p=>{onlyFields(patch,['name','appearance']);const look=findLook(p,lookId),before=JSON.stringify(look);Object.assign(look,lookFields({...look,...patch}));if(JSON.stringify(look)!==before)invalidateLook(p,look);});},
    async lookAction(id,lookId,action,body={}){
      if(action==='upload'){
        const p=await service.get(id),look=findLook(p,lookId);expectedVersion(look,body);identityReady(p,look.characterId);const before=look.version;
        const url=mediaUrl(await providers.importImage(p,body.dataUrl),p);
        const classification=await classifyLookAsset(p,{kind:'look',characterId:look.characterId,lookId:look.id,sceneId:look.sceneId,name:look.name,appearance:look.appearance,reference:url,sourceVersion:look.version,approved:false});
        return mutate(id,live=>{const currentLook=findLook(live,lookId);expectedVersion(currentLook,body);identityReady(live,currentLook.characterId);if(currentLook.version!==before)fail('造型已修改，请重新上传','STALE_INPUT',409);invalidateLook(live,currentLook);currentLook.reference=url;currentLook.referenceVersion=currentLook.version;const scene=live.scenes?.find(item=>item.id===currentLook.sceneId);const character=live.characters?.find(item=>item.id===currentLook.characterId);const asset=registerLookAsset(live,{kind:'look',characterId:currentLook.characterId,lookId:currentLook.id,sceneId:currentLook.sceneId,name:currentLook.name,appearance:currentLook.appearance,reference:url,sourceVersion:currentLook.version,approved:false,classification});recordMedia(live,{recordType:'look-image',assetUrl:url,assetTitle:`场景造型 · ${currentLook.name}`,segmentTitle:scene?.name||'场景造型',version:currentLook.version,sceneId:currentLook.sceneId,sceneTitle:scene?.name,characterId:currentLook.characterId,characterName:character?.name,lookId:currentLook.id,lookName:currentLook.name,lookAppearance:currentLook.appearance,lookAssetId:asset.id,approved:false,source:'upload'});});
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
        const classification=await classifyLookAsset(p,{kind:'identity',characterId:character.id,name:`人物身份 · ${character.name}`,appearance:character.appearance,reference:url,sourceVersion:character.version,approved:false});
        return mutate(id, live => { const c = findCharacter(live, cid);expectedVersion(c,body); if (c.version !== before) fail('角色已被修改，请重新上传', 'STALE_INPUT', 409); invalidateCharacter(live, c); c.reference = url;c.referenceVersion=c.version;const asset=registerLookAsset(live,{kind:'identity',characterId:c.id,name:`人物身份 · ${c.name}`,appearance:c.appearance,reference:url,sourceVersion:c.version,approved:false,classification});recordMedia(live,{recordType:'character-image',assetUrl:url,assetTitle:`人物身份 · ${c.name}`,segmentTitle:'人物资料',characterId:c.id,characterName:c.name,version:c.version,lookAssetId:asset.id,lookName:asset.name,lookAppearance:asset.appearance,approved:false,source:'upload'}); });
      }
      return mutate(id, p => { const c = findCharacter(p, cid);expectedVersion(c,body); if (action === 'generate') {if(body.reuseExisting===true&&c.reference&&c.referenceVersion===c.version)return;return [addJob(p, 'character', cid)];} if (action !== 'approve') fail('未知角色操作');reviewedVersion(c,body); if (p.jobs.some(j => j.kind === 'character' && j.targetId === cid && blocksCurrent(p, j))) fail('角色任务仍在执行或待核实，不能确认定妆', 'ACTIVE_JOB', 409); if (!c.reference) fail('请先生成或上传角色参考图');if(p.workflowVersion===2&&c.referenceVersion!==c.version)fail('身份参考为旧版或未验证版本，请重新生成或上传','STALE_ASSET',409); c.approved = true; });
    },
    async updateShot(id, sid, patch) { return mutate(id, p => {
      const { segment, shot } = findShot(p, sid);
      const previous = copy(shot);
      const wasCurrent = !!shot.video && shot.videoVersion === shot.version;
      updateShotFields(shot, patch, p.characters,p.scenes,p.assets);
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
        if (action === 'video') { if (p.generationMode === 'segment-board') fail('片段级模式请在片段视频区生成一条完整视频', 'SEGMENT_VIDEO_REQUIRED', 409); requireApproved(p, segment); shotAssetsReady(p,shot); if (p.jobs.some(j => ['character', 'asset', 'look', 'image', 'export'].includes(j.kind) && blocksCurrent(p, j)) || (p.jobs.some(j => j.kind === 'analyze' && blocksCurrent(p, j)) && !segmentAnalysisReady(p, segment))) fail('请等待当前素材任务完成并重新审核', 'ACTIVE_JOB', 409);if(body.reuseExisting===true&&shot.video&&shot.videoVersion===shot.version)return; return [addJob(p, 'video', sid)]; }
        fail('未知分镜操作');
      });
    },
    async segmentAction(id, segmentId, action, body = {}) { return mutate(id, p => {
      onlyFields(body, ['reviewedVersion', 'reuseExisting', 'videoModel', 'videoResolution']);
      const segment = findSegment(p, segmentId);
      if (action === 'approve') { validateSegment(segment,{generationMode:p.generationMode,durationMode:p.durationMode,projectDuration:p.duration}); const traditional=p.videoMode==='traditional'; if(p.generationMode==='segment-board'&&!traditional){const boardVersion=version(p,'storyboard',segmentId);if(body.reviewedVersion!==undefined&&body.reviewedVersion!==boardVersion)fail('审核内容已变化，请检查当前整板版本后重新审核','STALE_INPUT',409);if(!segment.storyboardImage||segment.storyboardImageVersion!==boardVersion)fail('请先生成当前模板的整段分镜板','STALE_ASSET',409);if(p.jobs.some(j=>j.kind==='storyboard'&&j.targetId===segmentId&&blocksCurrent(p,j)))fail('整段分镜板任务仍在执行或待核实','ACTIVE_JOB',409);segment.storyboardApproved=true;} for (const shot of segment.shots) { shotAssetsReady(p, shot); if (!traditional) { if (!shot.image) fail(`全部 ${segment.shots.length} 个分镜都需要图片才能审核`);requireCurrentImage(p,shot); if (p.jobs.some(j => j.targetId === shot.id && blocksCurrent(p, j))) fail('分镜任务仍在执行或待核实', 'ACTIVE_JOB', 409); } } for (const shot of segment.shots) shot.approved = true; return; }
      if (action === 'generate-images' || action === 'generate-storyboard') { const batchId=randomUUID(); const batchLabel='批量生成分镜'; if(p.generationMode==='segment-board'&&p.videoMode!=='traditional'){const boardVersion=version(p,'storyboard',segmentId);const current=Boolean(segment.storyboardImage&&segment.storyboardImageVersion===boardVersion&&segment.shots.length&&segment.shots.every(shot=>shot.image&&shot.imageVersion===shot.version));if(body.reuseExisting===true&&current)return;return [addJob(p,'storyboard',segmentId,{batchId,batchLabel})];} const targets = segment.shots.filter(s => !s.image); for (const shot of targets) shotAssetsReady(p, shot); return targets.map(s => addJob(p, 'image', s.id,{batchId,batchLabel})); }
      if (action === 'generate-videos') {
        requireApproved(p, segment);
        for (const shot of segment.shots) shotAssetsReady(p,shot);
        if (p.jobs.some(j => !['video', 'segment-video', 'analyze'].includes(j.kind) && blocksCurrent(p, j)) || (p.jobs.some(j => j.kind === 'analyze' && blocksCurrent(p, j)) && !segmentAnalysisReady(p, segment))) fail('请等待当前素材任务完成并重新审核', 'ACTIVE_JOB', 409);
        if (p.generationMode === 'segment-board') {
          const current = segment.video && segment.videoVersion === version(p, 'segment-video', segment.id);
          if (body.reuseExisting === true && current) return;
          if (typeof providers.getVideoModel === 'function') resolveVideoOption(body.videoModel ?? providers.getVideoModel(), body.videoResolution);
          return [addJob(p, 'segment-video', segment.id, { videoModel: body.videoModel, videoResolution: body.videoResolution, batchId: randomUUID(), batchLabel: '生成完整片段视频' })];
        }
        if (typeof providers.getVideoModel === 'function') resolveVideoOption(body.videoModel ?? providers.getVideoModel(), body.videoResolution);
        const batchId=randomUUID();
        return segment.shots.filter(s => !s.video || s.videoVersion !== s.version).map(s => addJob(p, 'video', s.id, { videoModel: body.videoModel, videoResolution: body.videoResolution, batchId, batchLabel: '批量生成视频' }));
      }
      if (action === 'export') { requireCurrentExport(p, segment); if (p.jobs.some(j => blocksCurrent(p, j) && (j.targetId === segmentId || segment.shots.some(s => s.id === j.targetId)))) { const existing = p.jobs.find(j => j.kind === 'export' && j.targetId === segmentId && blocksCurrent(p, j)); if (existing) return [existing]; fail('片段任务仍在执行或待核实，请等待后导出', 'ACTIVE_JOB', 409); } return [addJob(p, 'export', segmentId)]; }
      fail('未知片段操作');
    }); },
    async generateEpisodeStoryboards(id, episodeKey, body = {}) {
      return mutate(id, p => {
        onlyFields(body, ['reuseExisting']);
        if (p.videoMode === 'traditional') fail('传统模式不生成九宫格分镜板，请直接确认素材后生成片段视频。', 'TRADITIONAL_MODE_NO_STORYBOARD', 409);
        const match = /^episode-(\d+)$/.exec(String(episodeKey));
        const episodeNumber = match ? Number(match[1]) : undefined;
        if (episodeKey !== 'unassigned' && episodeNumber === undefined) fail('集数标识无效');
        const segments = p.segments.filter(segment => episodeNumber === undefined ? segment.episodeNumber === undefined : segment.episodeNumber === episodeNumber);
        if (!segments.length) fail('该集没有可生成的片段', 'NOT_FOUND', 404);
        const batchId = randomUUID();
        const batchLabel = episodeNumber === undefined ? '生成未分集内容分镜' : `生成第${episodeNumber}集分镜`;
        const jobs = [];
        for (const segment of segments) {
          if (p.generationMode === 'segment-board') {
            const current = segment.storyboardImage && segment.storyboardImageVersion === version(p, 'storyboard', segment.id);
            if (body.reuseExisting === true && current) continue;
            const job = addJob(p, 'storyboard', segment.id, { batchId, batchLabel }); jobs.push(job);
          } else {
            for (const shot of segment.shots.filter(item => body.reuseExisting === true ? true : !item.image)) {
              shotAssetsReady(p, shot);
              const job = addJob(p, 'image', shot.id, { batchId, batchLabel }); jobs.push(job);
            }
          }
        }
        return jobs;
      });
    },
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
          const batchId = randomUUID();
          const batchLabel = body.action === 'video' ? '批量生成视频' : body.kind === 'character' ? '批量生成角色身份' : body.kind === 'look' ? '批量生成造型' : '批量生图';
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
                  const job = batchJob(p, 'character', targetId, { batchId, batchLabel }); jobs.push(job); accepted.push(targetId); createdJobIds.push(job.id);
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
                  const job = batchJob(p, 'look', targetId, { batchId, batchLabel }); jobs.push(job); accepted.push(targetId); createdJobIds.push(job.id);
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
                  const job = batchJob(p, 'image', targetId, { batchId, batchLabel }); jobs.push(job); accepted.push(targetId); createdJobIds.push(job.id);
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
                  const job = batchJob(p, 'video', targetId, { videoModel: body.videoModel, videoResolution: body.videoResolution, batchId, batchLabel }); jobs.push(job); accepted.push(targetId); createdJobIds.push(job.id);
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
      if (j.kind === 'analyze' && j.status === 'paused') {
        if (!current(p, j)) fail('任务对应旧版原稿，请先核对当前输入', 'STALE_INPUT', 409);
        j.status = 'queued'; j.error = undefined; j.analysisPauseRequested = false; j.analysisRetryDeterministic = true;
        return [j];
      }
      if (active(j) || j.status === 'completed') return [];
      if (!['video', 'segment-video', 'character', 'asset', 'look', 'image', 'storyboard'].includes(j.kind) || (!j.providerTaskId && !j.businessId)) fail('该任务没有可恢复查询的供应商 ID；禁止自动重发不明确请求', 'CANNOT_RESUME', 409);
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
      else if (['image','character','asset','look','storyboard'].includes(j.kind) && j.submissionStarted && j.providerTaskId) { j.status = 'queued'; recoveryQueue.push([p.id, j.id]); }
      else if (!j.submissionStarted || j.kind === 'export') { j.status = 'queued'; recoveryQueue.push([p.id, j.id]); }
      else { j.status = 'unknown'; j.error = '应用退出前请求结果不明确，未自动重复提交'; }
      changed = true;
    }
    if (changed) await save(p);
  }
  for (const [id, jid] of recoveryQueue) schedule(id, jid);
  return service;
}

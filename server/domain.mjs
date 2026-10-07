import { randomUUID } from 'node:crypto';
import { movementById } from './movement-library.mjs';

export const now = () => new Date().toISOString();
export function fail(message, code = 'INVALID_INPUT', status = 400) {
  const error = new Error(message); error.code = code; error.status = status; error.statusCode = status; throw error;
}
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('输入必须是对象');
  return value;
}
export function text(value, label, max = 4000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}格式无效${required ? '或为空' : ''}（最多 ${max} 字）`);
  return value.trim();
}
const choose = (value, choices, label) => { if (!choices.includes(value)) fail(`${label}必须为 ${choices.join(' / ')}`); return value; };
export function finite(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label}必须在 ${min}–${max} 之间`);
  return value;
}
export function projectInput(input) {
  object(input);
  return { title: text(input.title, '标题', 160, true), novel: text(input.novel ?? '', '原始内容', 120000), style: text(input.style ?? '写实电影质感，人物与服装保持一致', '风格', 2000), visualStyle: choose(input.visualStyle ?? 'photorealistic', ['photorealistic', '2d-animation', '3d-animation'], '视觉媒介'), sourceType: choose(input.sourceType ?? 'auto', ['auto', 'novel', 'script', 'article', 'paper', 'news'], '内容类型'), narrativeMode: choose(input.narrativeMode ?? 'auto', ['auto', 'narrator', 'protagonist'], '叙事视角'), aspectRatio: choose(input.aspectRatio ?? '9:16', ['9:16', '16:9'], '画幅'), duration: choose(input.duration ?? 30, [15, 30], '片段时长'), durationMode: choose(input.durationMode ?? 'fixed', ['auto', 'fixed'], '时长模式'), generationMode: choose(input.generationMode ?? 'legacy-shot', ['segment-board', 'legacy-shot'], '生图模式') };
}
export function createProject(input) {
  const fields=projectInput(input);
  return { id: randomUUID(), ...fields, analysisSourceLength: 0, analysisSourceHash: null, workflowVersion:2, createdAt: now(), updatedAt: now(), characters: [], scenes:[], looks:[], segments: [], jobs: [], exports: [], projectExports: [] };
}
export function onlyFields(patch, allowed) {
  object(patch);
  if (Object.keys(patch).some(key => !allowed.includes(key))) fail('包含不允许修改的字段');
}
export function characterFields(input) {
  object(input);
  const aliases = input.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 30) fail('人物别名格式无效');
  return { name: text(input.name, '人物名称', 100, true), role: choose(input.role ?? 'supporting', ['protagonist', 'supporting', 'extra'], '人物类型'), aliases: [...new Set(aliases.map(v => text(v, '别名', 100, true)))], appearance: text(input.appearance ?? '', '外貌', 4000), evidence: text(input.evidence ?? '', '原文依据', 6000) };
}
export function updateCharacterFields(character, patch) {
  onlyFields(patch, ['name', 'role', 'aliases', 'appearance', 'evidence']);
  Object.assign(character, characterFields({ ...character, ...patch }));
}
export function sceneFields(input) {
  object(input);
  return {name:text(input.name,'场景名称',200,true),description:text(input.description??'','场景说明',4000)};
}
export function lookFields(input) {
  object(input);
  return {name:text(input.name,'造型名称',200,true),appearance:text(input.appearance??'','造型说明',4000)};
}
function entityId(value,label,ids) {
  const id=text(value,label,100,true);
  if(!/^[\w-]+$/.test(id)||ids.has(id))fail(`${label}无效或重复`);
  ids.add(id);return id;
}
function sceneStructure(input,characters) {
  if(input.scenes!==undefined&&!Array.isArray(input.scenes))fail('场景列表格式无效');
  if(input.looks!==undefined&&!Array.isArray(input.looks))fail('造型列表格式无效');
  if((input.scenes?.length??0)>300||(input.looks?.length??0)>900)fail('场景或造型数量超过上限');
  const sceneIds=new Set(),lookIds=new Set(),pairs=new Set();
  const scenes=(input.scenes??[]).map(value=>{object(value);return {id:entityId(value.id,'场景 ID',sceneIds),...sceneFields(value)};});
  const looks=(input.looks??[]).map(value=>{
    object(value);
    if(!sceneIds.has(value.sceneId))fail('造型引用了未知场景');
    if(!characters.some(c=>c.id===value.characterId))fail('造型引用了未知角色');
    const pair=`${value.sceneId}/${value.characterId}`;
    if(pairs.has(pair))fail('同一场景和角色的造型必须唯一，不能重复');
    pairs.add(pair);
    return {id:entityId(value.id??randomUUID(),'造型 ID',lookIds),sceneId:value.sceneId,characterId:value.characterId,...lookFields(value),reference:null,approved:false,version:1};
  });
  const segmentScenes=input.segments.map((segment,index)=>{
    object(segment);
    if(!Array.isArray(segment.shots))fail('分析结果缺少分镜');
    let fallback;
    return segment.shots.map(shot=>{
      object(shot);
      let sceneId=shot.sceneId;
      if(sceneId===undefined||sceneId===null||sceneId===''){
        if(!fallback){fallback=randomUUID();sceneIds.add(fallback);scenes.push({id:fallback,name:`${segment.title??`片段 ${index+1}`} · 待检查场景`.slice(0,200),description:'由兼容分析建立，请核对连续时空与角色造型。'});}
        sceneId=fallback;
      }else if(!sceneIds.has(sceneId))fail('分镜引用了未知场景');
      if(!Array.isArray(shot.characterIds)||shot.characterIds.some(id=>!characters.some(c=>c.id===id)))fail('分镜引用了未知角色');
      for(const characterId of shot.characterIds){
        const pair=`${sceneId}/${characterId}`;
        if(!pairs.has(pair)){
          const character=characters.find(c=>c.id===characterId);pairs.add(pair);
          looks.push({id:randomUUID(),sceneId,characterId,name:`${character.name} · 待确认造型`.slice(0,200),appearance:`待确认场景造型：请根据本场景的原文核对服装、配饰与发型状态。人物资料：${character.appearance??''}`.slice(0,4000),reference:null,approved:false,version:1});
        }
      }
      return sceneId;
    });
  });
  if(scenes.length>300||looks.length>900)fail('场景或造型数量超过上限');
  return {scenes,looks,segmentScenes};
}
export function shotFields(input, characters, scenes) {
  object(input);
  if (!Array.isArray(input.characterIds) || input.characterIds.some(id => !characters.some(c => c.id === id))) fail('分镜引用了未知角色');
  if (input.characterIds.length > 9) fail('单镜最多支持 9 个角色参考，请拆分群像镜头');
  const duration = finite(input.duration, '镜头时长', 0.1, 15);
  const trimStart = finite(input.trimStart ?? 0, '剪辑入点', 0, 14.9);
  if (duration + trimStart > 15 + 1e-8) fail('剪辑入点与镜头时长之和不能超过 15 秒');
  if(scenes&&!scenes.some(scene=>scene.id===input.sceneId))fail('分镜引用了未知场景');
  const backgroundActors = input.backgroundActors === undefined ? undefined : text(input.backgroundActors ?? '', '群众演员', 1200);
  const movementId = input.movementId === undefined || input.movementId === null || input.movementId === '' ? undefined : text(input.movementId, '运镜库编号', 40, true);
  if (movementId && !movementById(movementId)) fail('运镜库编号无效，必须引用 move-1 到 move-120');
  return { ...(input.sceneId!==undefined?{sceneId:input.sceneId}:{}),scene: text(input.scene ?? '', '场景', 2000), action: text(input.action ?? '', '动作', 3000), camera: text(input.camera ?? '', '镜头', 1500), ...(movementId?{movementId}:{}), movementPlan: text(input.movementPlan ?? '', '运镜执行计划', 600), transitionPlan: text(input.transitionPlan ?? '', '镜头衔接计划', 400), dialogue: text(input.dialogue ?? '', '台词', 3000), narration: text(input.narration ?? '', '旁白', 3000), ...(input.sourceEvidence!==undefined?{sourceEvidence:text(input.sourceEvidence ?? '', '原文依据', 1200)}:{}), ...(backgroundActors!==undefined?{backgroundActors}:{}), characterIds: [...new Set(input.characterIds)], duration, trimStart };
}
export function updateShotFields(shot, patch, characters, scenes) {
  onlyFields(patch, ['sceneId','scene', 'action', 'camera', 'movementId', 'movementPlan', 'transitionPlan', 'dialogue', 'narration', 'sourceEvidence', 'backgroundActors', 'characterIds', 'duration', 'trimStart']);
  Object.assign(shot, shotFields({ ...shot, ...patch }, characters,scenes));
}
export function validateSegment(segment, options = {}) {
  const generationMode = options.generationMode ?? segment.generationMode ?? 'legacy-shot';
  const flexibleDuration = generationMode === 'segment-board' && options.durationMode !== 'fixed';
  if (flexibleDuration) finite(segment.duration, '片段时长', 3, 30);
  else choose(segment.duration, [15, 30], '片段时长');
  if (options.durationMode === 'fixed' && options.projectDuration !== undefined && segment.duration !== options.projectDuration) fail(`片段时长必须等于作品设定的 ${options.projectDuration} 秒`);
  const minimum = generationMode === 'segment-board' ? 3 : 9;
  const maximum = generationMode === 'segment-board' ? 12 : 9;
  if (!Array.isArray(segment.shots) || segment.shots.length < minimum || segment.shots.length > maximum) fail(`每个片段必须包含 ${minimum === maximum ? minimum : `${minimum} 到 ${maximum}`} 个分镜`);
  const sum = segment.shots.reduce((total, shot) => total + finite(shot.duration, '镜头时长', 0.1, 15), 0);
  if (Math.abs(sum - segment.duration) > 0.01) fail(`${segment.shots.length} 个分镜时长合计为 ${Number(sum.toFixed(2))} 秒，必须等于片段的 ${segment.duration} 秒`);
  return segment;
}
export function validateAnalysis(input, project) {
  object(input);
  if (!Array.isArray(input.characters) || input.characters.length > 100 || !Array.isArray(input.segments) || input.segments.length < 1 || input.segments.length > 300) fail('分析结果的角色或片段数量无效');
  const ids = new Set();
  const characters = input.characters.map(value => {
    object(value);
    const id = text(value.id, '角色 ID', 100, true);
    if (!/^[\w-]+$/.test(id) || ids.has(id)) fail('角色 ID 无效或重复');
    ids.add(id);
    return { id, ...characterFields(value), reference: null, approved: false, version: 1 };
  });
  const {scenes,looks,segmentScenes}=sceneStructure(input,characters);
  const segments = input.segments.map((value, index) => {
    object(value);
    if (!Array.isArray(value.shots)) fail('分析结果缺少分镜');
    const duration = value.duration ?? project.duration;
    if (project.durationMode !== 'auto' && duration !== project.duration) fail('分析片段时长必须等于作品设定时长');
    const episodeNumber = value.episodeNumber === undefined ? undefined : finite(value.episodeNumber, '剧集编号', 1, 10000);
    if (episodeNumber !== undefined && !Number.isInteger(episodeNumber)) fail('剧集编号必须为整数');
    const episodeTitle = value.episodeTitle === undefined ? undefined : text(value.episodeTitle ?? '', '剧集标题', 200);
    return validateSegment({ id: randomUUID(), number: index + 1, ...(episodeNumber !== undefined ? { episodeNumber } : {}), ...(episodeTitle !== undefined ? { episodeTitle } : {}), title: text(value.title ?? `片段 ${index + 1}`, '片段名称', 200, true), summary: text(value.summary ?? '', '片段摘要', 4000), duration, ...(project.generationMode === 'segment-board' ? { generationMode: 'segment-board', shotCount: value.shots.length, storyboardImage: null, storyboardImageVersion: null, storyboardApproved: false, video: null, videoVersion: null, videoDuration: null } : {}), shots: value.shots.map((shot, i) => ({ id: randomUUID(), number: i + 1, ...shotFields({...shot,sceneId:segmentScenes[index][i]}, characters,scenes), image: null, approved: false, version: 1, video: null, videoVersion: null, videoDuration: null })) }, {generationMode: project.generationMode, durationMode: project.durationMode, projectDuration: project.duration});
  });
  return { workflowVersion:2,characters,scenes,looks,segments };
}
export function migrateSceneWorkflow(project) {
  if(project.workflowVersion===2)return false;
  const {scenes,looks,segmentScenes}=sceneStructure(project,project.characters);
  project.scenes=scenes;project.looks=looks;project.workflowVersion=2;
  if(project.exports.length)project.legacyExports=[...(project.legacyExports??[]),...project.exports];
  project.exports=[];
  for(const [index,segment] of project.segments.entries())for(const [i,shot] of segment.shots.entries()){
    shot.sceneId=segmentScenes[index][i];invalidateShot(shot);
  }
  for(const job of project.jobs)if(['queued','running','unknown'].includes(job.status)&&job.kind!=='analyze'){
    job.status='interrupted';job.error='旧版任务缺少场景造型依据，已保留记录；不会重新提交';job.updatedAt=now();
  }
  return true;
}
export function invalidateShot(shot) { shot.version++; shot.approved = false; shot.videoVersion = null; }
export function findShot(project, id) {
  for (const segment of project.segments) { const shot = segment.shots.find(s => s.id === id); if (shot) return { segment, shot }; }
  fail('找不到该分镜', 'NOT_FOUND', 404);
}
export function findCharacter(project, id) { return project.characters.find(c => c.id === id) ?? fail('找不到该角色', 'NOT_FOUND', 404); }
export function findScene(project,id) {return (project.scenes??[]).find(s=>s.id===id)??fail('找不到该场景','NOT_FOUND',404);}
export function findLook(project,id) {return (project.looks??[]).find(look=>look.id===id)??fail('找不到该造型','NOT_FOUND',404);}
export function findSegment(project, id) { return project.segments.find(s => s.id === id) ?? fail('找不到该片段', 'NOT_FOUND', 404); }
export function requireIdentity(project,characterId) {
  const character=findCharacter(project,characterId);
  if(!character.approved||!character.reference)fail(`请先确认「${character.name}」的基础身份参考`,'CHARACTER_NOT_APPROVED',409);
  if(character.referenceVersion!==character.version)fail(`「${character.name}」的身份参考为旧版或未验证版本，请重新生成或上传`,'STALE_ASSET',409);
  return character;
}
export function requireCharacters(project, shot) {
  if (project.generationMode === 'segment-board') return;
  if(project.workflowVersion===2)findScene(project,shot.sceneId);
  for (const id of shot.characterIds) {
    if(project.workflowVersion!==2){const character=findCharacter(project,id);if(!character.approved||!character.reference)fail(`请先确认「${character.name}」的角色定妆`,'CHARACTER_NOT_APPROVED',409);continue;}
    const character=requireIdentity(project,id);
    const look=(project.looks??[]).find(value=>value.sceneId===shot.sceneId&&value.characterId===id);
    if(!look||!look.reference||!look.approved)fail(`请先确认「${character.name}」在当前场景的三视图造型`,'LOOK_NOT_APPROVED',409);
    if(look.referenceVersion!==look.version)fail(`「${look.name}」三视图为旧版或未验证版本，请重新生成或上传`,'STALE_ASSET',409);
  }
}
export function requireCurrentImage(project,shot){if(project.workflowVersion===2&&shot.imageVersion!==shot.version)fail('分镜图片为旧版或未验证版本，请按当前场景造型重新生成或上传','STALE_ASSET',409);}
export function requireApproved(project, segment) {
  validateSegment(segment, {generationMode: project.generationMode, durationMode: project.durationMode, projectDuration: project.duration});
  if (project.generationMode === 'segment-board' && (!segment.storyboardImage || segment.storyboardImageVersion === null || segment.storyboardApproved !== true)) fail('请先检查并审核这一段的整板分镜图片', 'STORYBOARD_NOT_APPROVED', 409);
  for (const shot of segment.shots) { requireCharacters(project, shot); if (!shot.image || !shot.approved) fail(`请先完成全部 ${segment.shots.length} 个分镜图片并通过人工审核`, 'SHOT_NOT_APPROVED', 409); requireCurrentImage(project,shot); }
}
export function requireExport(project, segment) {
  requireApproved(project, segment);
  if (project.generationMode === 'segment-board') {
    if (!segment.video || segment.videoVersion === null) fail(`片段 ${segment.number} 缺少当前版本的完整视频，不能跳过生成`, 'VIDEO_NOT_READY', 409);
    return;
  }
  for (const shot of segment.shots) if (!shot.video || shot.videoVersion !== shot.version) fail(`第 ${shot.number} 镜缺少当前版本的视频，不能跳过导出`, 'VIDEO_NOT_READY', 409);
}
export function mediaUrl(value, project) {
  if (typeof value !== 'string' || !value.startsWith(`/media/${project.id}/`) || value.includes('..') || /[\\?#\x00]/.test(value)) fail('媒体提供商返回了无效文件地址', 'INVALID_MEDIA', 502);
  return value;
}

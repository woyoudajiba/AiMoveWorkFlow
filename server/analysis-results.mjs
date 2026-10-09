import { randomUUID } from 'node:crypto';
import { safeError } from './network.mjs';
import { mergeSceneChunk } from './analysis-scenes.mjs';
import { validateAnalysis } from './domain.mjs';
import { movementById, normalizeMovementPlan } from './movement-library.mjs';

// New analysis must fit the common video-model ceiling. Legacy 30-second
// records remain readable elsewhere, but are never valid analysis candidates.
export const MAX_ANALYSIS_SEGMENT_DURATION_SECONDS = 15;
export const MIN_ANALYSIS_SEGMENT_DURATION_SECONDS = 3;

const normalizeName=value=>value.trim().replace(/\s/g,'');
const unique=values=>[...new Set(values.filter(Boolean))];
function localText(value,max=4000){if(typeof value!=='string'||value.length>max)throw safeError('模型返回的文本字段无效。','ANALYSIS_INVALID');return value.trim();}
function compactCharacterText(value,max){
  const text=localText(value,max);if(!text)return text;
  const lines=text.split(/\r?\n+/).map(item=>item.replace(/\s+/g,' ').trim()).filter(Boolean);
  const uniqueLines=[];for(const line of lines)if(!uniqueLines.includes(line))uniqueLines.push(line);
  const joined=uniqueLines.join('\n');
  const flat=joined.replace(/\s+/g,'');
  if(flat.length>20&&flat.length%2===0){const half=flat.length/2;if(flat.slice(0,half)===flat.slice(half))return flat.slice(0,half);}
  return joined;
}
export function normalizeCharacterAppearance(value,evidence,max=4000){
  const text=compactCharacterText(value,max);if(!text)return text;
  const evidenceLines=compactCharacterText(evidence??'',6000).split(/[。！？!?；;\n]+/).map(item=>item.replace(/[\s，,、。！？!?；;：:"“”‘’'（）()\[\]]/g,'').toLowerCase()).filter(item=>item.length>=12);
  const lines=text.replace(/([。！？!?；;])\s*/g,'$1\n').split(/\r?\n+/).map(item=>item.replace(/\s+/g,' ').trim()).filter(Boolean);
  const kept=[];
  for(let line of lines){
    if(/^(?:原文|小说原文|原文依据|依据|证据)\s*[:：]/.test(line))continue;
    const comparable=line.replace(/^(?:原文|小说原文|原文依据|依据|证据)\s*[:：]/,'').replace(/[\s，,、。！？!?；;：:"“”‘’'（）()\[\]]/g,'').toLowerCase();
    if(evidenceLines.some(item=>comparable===item||comparable.includes(item)||item.includes(comparable)))continue;
    if(!kept.includes(line))kept.push(line);
  }
  return kept.join('\n')||'待确认创作设定：请根据原文补充年龄段、脸型、肤色、发型、体型和稳定辨识点。';
}
const invalid=(message,repairShots=false)=>{const error=safeError(message,'ANALYSIS_INVALID');error.repairShots=repairShots;throw error;};

function normalizeAudioPlan(data, project = {}) {
  const mode = project.narrativeMode ?? 'auto';
  const sourceType = project.sourceType ?? 'auto';
  const explicitNarration = /旁白|画外音|解说|voice[- ]?over|narrator/i.test(String(project.novel ?? ''));
  const narrationAllowed = mode === 'narrator'
    || ['article', 'paper', 'news'].includes(sourceType)
    || (sourceType === 'auto' && explicitNarration);
  for (const segment of data.segments ?? []) {
    const seenDialogue = new Set();
    for (const shot of segment.shots ?? []) {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) continue;
      shot.dialogue = typeof shot.dialogue === 'string' ? shot.dialogue.trim() : '';
      if (Object.hasOwn(shot, 'narration')) {
        shot.narration = typeof shot.narration === 'string' ? shot.narration.trim() : '';
        if (!narrationAllowed) shot.narration = '';
      }
      // A model often copies one line into the reaction shot. A reaction shot
      // may show listening and movement, but it must not speak the same line
      // again unless the source is explicitly represented as a new line.
      const key = shot.dialogue.replace(/[\s“”"'「」『』。！？!?，,：:；;]/g, '');
      if (key && seenDialogue.has(key)) shot.dialogue = '';
      else if (key) seenDialogue.add(key);
    }
  }
}

export function parseAnalysis(result,{shotsOnly=false}={}){
  const choice=result?.choices?.[0];
  if(choice?.finish_reason==='length')invalid('模型返回的分析被截断，未完成本块结构。');
  let content=choice?.message?.content;
  if(typeof content!=='string')invalid('模型没有返回结构化分析文本。');
  content=content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let data;try{data=JSON.parse(content);}catch{invalid('模型返回的分析不是有效 JSON。');}
  if(!data||typeof data!=='object'||Array.isArray(data))invalid('模型返回的分析必须是 JSON 对象。');
  if(!shotsOnly&&(!Array.isArray(data.characters)||data.characters.length>100))invalid('模型返回的 characters 人物列表缺失或格式无效。');
  if(!Array.isArray(data.segments)||!data.segments.length||data.segments.length>100)invalid('模型返回的 segments 片段列表缺失或格式无效。');
  return data;
}

function normalizeShotTiming(segment){
  const sum=segment.shots.reduce((total,shot)=>total+shot.duration,0);
  const difference=segment.duration-sum;
  if(Math.abs(difference)<1e-8)return;
  if(!Number.isFinite(sum)||sum<=0)invalid('分镜时长合计必须大于 0 秒，请重新安排镜头时长。',true);
  // A model that overestimates a segment is still giving us a usable rhythm:
  // scale it down to the requested budget. A model that underestimates by
  // more than half would need a large artificial stretch, so ask it to
  // repair the timing instead of silently changing the scene pacing.
  if(sum<segment.duration && difference>segment.duration*0.5+1e-8)invalid(`${segment.shots.length} 个分镜时长合计为 ${Number(sum.toFixed(3))} 秒，目标为 ${segment.duration} 秒，偏差超过 50%，请重新安排镜头时长。`,true);
  // Providers often preserve the right relative rhythm but return a rough
  // total (for example 12 shots adding up to 39 seconds for a 30-second
  // segment). Normalize any finite positive total locally; rejecting a whole
  // analysis for arithmetic drift makes long works stop at the last block.
  const scaled=segment.shots.map(shot=>shot.duration*segment.duration/sum);
  if(scaled.some(duration=>duration<0.1-1e-8||duration>15+1e-8))invalid('按比例校正后镜头时长超出 0.1 到 15 秒，请重新安排。',true);
  const milliseconds=scaled.map(duration=>Math.round(duration*1000));
  const longest=milliseconds.indexOf(Math.max(...milliseconds));
  milliseconds[longest]+=segment.duration*1000-milliseconds.reduce((total,value)=>total+value,0);
  if(milliseconds.some(value=>value<100||value>15000))invalid('分镜时长舍入后超出允许范围，请重新安排。',true);
  // Only the candidate copy changes. Keep the model's relative pacing and
  // absorb millisecond rounding in the longest shot, not an arbitrary last shot.
  segment.shots.forEach((shot,index)=>{shot.duration=milliseconds[index]/1000;});
}

function validateShots(data,project,{analysisDurationCap=false}={}){
  const generationMode=project.generationMode??'legacy-shot';
  const minimumShots=generationMode==='segment-board'?3:9;
  const maximumShots=generationMode==='segment-board'?12:9;
  const strictSegmentDuration=analysisDurationCap||generationMode==='segment-board';
  for(const segment of data.segments){
    if(!segment||!Array.isArray(segment.shots)||segment.shots.length<minimumShots||segment.shots.length>maximumShots)invalid(generationMode==='segment-board'?`每个片段必须有 ${minimumShots} 到 ${maximumShots} 个完整分镜，不能用占位内容补齐。`:'每个片段必须有 9 个完整分镜，不能用占位内容补齐。',true);
    for(const shot of segment.shots){
      if(!shot||typeof shot!=='object'||Array.isArray(shot))invalid('模型返回了无效分镜。',true);
      for(const field of ['scene','action','camera']){
        if(typeof shot[field]!=='string'||!shot[field].trim()||/待确认分镜|依据本段摘要补充/.test(shot[field]))invalid('模型返回的分镜缺少场景、动作或景别，不能作为有效画面。',true);
      }
      if(typeof shot.sceneId!=='string'||!shot.sceneId.trim())invalid('分镜没有引用明确场景 ID。',true);
      if(!Array.isArray(shot.characterIds))invalid('分镜必须声明出场角色列表。',true);
      if(shot.movementId!==undefined&&shot.movementId!==null&&shot.movementId!==''&&!movementById(shot.movementId))invalid('分镜引用了未知的运镜库编号。',true);
      if(shot.movementPlan!==undefined&&typeof shot.movementPlan!=='string')invalid('运镜执行计划格式无效。',true);
      if(shot.transitionPlan!==undefined&&typeof shot.transitionPlan!=='string')invalid('镜头衔接计划格式无效。',true);
      if(typeof shot.duration!=='number'||!Number.isFinite(shot.duration)||shot.duration<0.1||shot.duration>15)invalid('分镜时长必须是 0.1 到 15 秒的数字。',true);
      if(shot.backgroundActors!==undefined&&(typeof shot.backgroundActors!=='string'||shot.backgroundActors.length>1200))invalid('群众演员信息必须是 1200 字以内的文字。',true);
    }
    const duration=segment.duration;
    if(strictSegmentDuration) {
      if(typeof duration!=='number'||!Number.isFinite(duration)||duration<MIN_ANALYSIS_SEGMENT_DURATION_SECONDS||duration>MAX_ANALYSIS_SEGMENT_DURATION_SECONDS) invalid(`分析片段时长必须为 ${MIN_ANALYSIS_SEGMENT_DURATION_SECONDS} 到 ${MAX_ANALYSIS_SEGMENT_DURATION_SECONDS} 秒，不能返回超过 15 秒的片段。`,true);
    } else if(project.generationMode==='segment-board' && project.durationMode==='auto') {
      const maximumDuration = project.generationMode === 'segment-board' ? MAX_ANALYSIS_SEGMENT_DURATION_SECONDS : (project.duration === 30 ? 30 : 15);
      if(typeof duration!=='number'||!Number.isFinite(duration)||duration<MIN_ANALYSIS_SEGMENT_DURATION_SECONDS||duration>maximumDuration) invalid(`自动片段时长必须为 3 到 ${maximumDuration} 秒。`,true);
    } else if(![15,30].includes(duration)) invalid('片段时长必须为 15 或 30 秒。',true);
    if(project.durationMode!=='auto'&&duration!==project.duration&&!strictSegmentDuration)invalid(`片段时长必须为作品设定的 ${project.duration} 秒。`,true);
    normalizeShotTiming(segment);
  }
}

const ASSET_KINDS = new Set(['weapon', 'costume', 'prop', 'other']);
function normalizeAssetKind(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const aliases = {
    武器: 'weapon', 武器装备: 'weapon', weapon: 'weapon',
    服饰: 'costume', 服装: 'costume', 制服: 'costume', costume: 'costume',
    道具: 'prop', props: 'prop', prop: 'prop',
  };
  return aliases[raw] ?? (ASSET_KINDS.has(raw) ? raw : 'other');
}

function normalizeAssetText(value, label, max, required = false) {
  if (value === undefined || value === null) {
    if (required) throw safeError(`关键物品${label}为空。`, 'ANALYSIS_INVALID');
    return '';
  }
  return localText(String(value), max);
}

function normalizeAssetRefs(data, assets, assetIds) {
  for (const segment of data.segments ?? []) {
    for (const shot of segment?.shots ?? []) {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) continue;
      if (shot.assetIds === undefined || shot.assetIds === null) {
        continue;
      }
      if (!Array.isArray(shot.assetIds)) invalid('分镜关键物品引用必须是数组。', true);
      shot.assetIds = unique(shot.assetIds.map(value => {
        const token = referenceToken(value);
        if (!token) invalid('分镜包含无效关键物品引用。', true);
        const canonical = assetIds.get(token) ?? assetIds.get(normalizeName(token));
        if (!canonical) invalid('分镜引用了未分析出的关键物品。', true);
        return canonical;
      }));
    }
  }
}

function validateEpisodeCoverage(data, expectedEpisodes = [], { requireAll = true } = {}) {
  if (!Array.isArray(expectedEpisodes) || expectedEpisodes.length === 0) return;
  const expected = new Set(expectedEpisodes);
  const seen = new Set();
  for (const segment of data.segments) {
    // Episode headings are guidance, not a filter. Segments covering a
    // preface, appendix, notes, or other source material may remain unnumbered.
    if (segment?.episodeNumber === undefined || segment?.episodeNumber === null) continue;
    if (!Number.isInteger(segment.episodeNumber) || !expected.has(segment.episodeNumber)) invalid('片段的 episodeNumber 必须引用原文检测到的剧集编号。');
    if (segment.episodeTitle !== undefined && (typeof segment.episodeTitle !== 'string' || segment.episodeTitle.length > 200)) invalid('剧集标题格式无效。');
    seen.add(segment.episodeNumber);
  }
  const missing = expectedEpisodes.filter(number => !seen.has(number));
  if (requireAll && missing.length) invalid(`分析结果缺少第 ${missing.join('、')} 集，不能把多集内容压缩到少数片段。`);
}

export function emptyAnalysisState(){return {characters:[],assets:[],segments:[],scenes:[],looks:[],idMap:new Map(),ambiguousCharacterRefs:new Set()};}

export function prepareAnalysisChunk(rawData, previous, project, options = {}){
  const data=structuredClone(rawData);
  const state=structuredClone(previous);
  const {characters,assets,segments,scenes,looks,idMap,ambiguousCharacterRefs}=state;
  // Models occasionally recycle a previously used character ID for a new
  // person whose name differs. Treat that as a local identity drift rather
  // than aborting the whole book: preserve the established character and
  // give the new candidate a fresh ID, then rewrite this block's references.
  // The source block remains the authority; no new story content is created.
  const knownCharacters=characters.map(character=>({
    ...character,
    tokens:new Set([character.name,...(character.aliases??[])].map(value=>normalizeName(String(value??''))).filter(Boolean)),
  }));
  const remappedCharacterRefs=new Map();
  const freshCharacterNames=new Map();
  for(const item of data.characters??[]){
    if(!item||typeof item!=='object'||Array.isArray(item))continue;
    const rawId=typeof item.id==='string'?item.id.trim():'';
    const name=typeof item.name==='string'?item.name.trim():'';
    const normalizedName=normalizeName(name);
    const existingById=knownCharacters.find(character=>character.id===rawId);
    const mappedId=idMap.get(rawId);
    const existingByMappedId=mappedId ? knownCharacters.find(character=>character.id===mappedId) : undefined;
    const idMatchesName=Boolean(existingById&&existingById.tokens.has(normalizedName));
    if((existingById||existingByMappedId)&&!(idMatchesName || existingByMappedId?.tokens.has(normalizedName))){
      const freshId=`character-local-${randomUUID()}`;
      remappedCharacterRefs.set(rawId,freshId);
      if(name)freshCharacterNames.set(normalizedName,freshId);
      item.id=freshId;
    }
  }
  for(const segment of data.segments??[]){
    for(const shot of segment?.shots??[]){
      if(!shot||typeof shot!=='object'||!Array.isArray(shot.characterIds))continue;
      shot.characterIds=shot.characterIds.map(value=>{
        const token=typeof value==='string'?value.trim():referenceToken(value);
        if(remappedCharacterRefs.has(token))return remappedCharacterRefs.get(token);
        const normalized=normalizeName(token??'');
        return freshCharacterNames.get(normalized)??value;
      });
    }
  }
  for(const look of data.looks??[]){
    if(!look||typeof look!=='object')continue;
    const token=typeof look.characterId==='string'?look.characterId.trim():referenceToken(look.characterId);
    if(remappedCharacterRefs.has(token))look.characterId=remappedCharacterRefs.get(token);
    else if(freshCharacterNames.has(normalizeName(token??'')))look.characterId=freshCharacterNames.get(normalizeName(token));
  }
  const analysisDurationCap=project.generationMode==='segment-board'||options.analysisDurationCap===true;
  const automaticDuration=project.durationMode==='auto'||analysisDurationCap;
  const addReference=(token,canonical)=>{
    if(typeof token!=='string'||!token.trim())return;
    const exact=token.trim(),normalized=normalizeName(exact);
    for(const key of new Set([exact,normalized])){
      if(ambiguousCharacterRefs.has(key))continue;
      const previous=idMap.get(key);
      if(previous&&previous!==canonical){ambiguousCharacterRefs.add(key);idMap.delete(key);}
      else idMap.set(key,canonical);
    }
  };
  for(const character of characters){addReference(character.id,character.id);addReference(character.name,character.id);for(const alias of character.aliases)addReference(alias,character.id);}
  for(const item of data.characters){
    if(!item||typeof item!=='object')throw safeError('人物条目格式无效。','ANALYSIS_INVALID');
    const name=localText(item.name,100);if(!name)throw safeError('人物姓名为空。','ANALYSIS_INVALID');
    const aliases=Array.isArray(item.aliases)?item.aliases.map(x=>localText(x,100)):[];
    const rawId=typeof item.id==='string'?item.id.trim():'';
    const tokens=new Set([name,...aliases].map(normalizeName));
    const mappedExisting=rawId&&!ambiguousCharacterRefs.has(rawId)?idMap.get(rawId):undefined;
    const idCandidate=characters.find(c=>c.id===rawId)??(mappedExisting?characters.find(c=>c.id===mappedExisting):undefined);
    const tokenCandidates=characters.filter(c=>[c.name,...c.aliases].some(v=>tokens.has(normalizeName(v))));
    if(rawId&&idCandidate&&!tokenCandidates.includes(idCandidate)){
      ambiguousCharacterRefs.add(rawId);idMap.delete(rawId);
      const error=safeError('模型给出了与既有人物 ID 冲突的姓名，无法可靠合并，请分段分析。','ANALYSIS_INVALID');
      error.definitive=true;
      error.hardIdentityConflict=true;
      throw error;
    }
    const exactNameCandidates=characters.filter(c=>c.name===name);
    const candidates=[...new Set([...(idCandidate&&tokenCandidates.includes(idCandidate)?[idCandidate]:[]),...tokenCandidates])];
    // An exact existing name is stronger evidence than a loose alias match.
    // For a freshly re-keyed candidate, keep a separate character when the
    // source name is genuinely ambiguous instead of blocking the chunk.
    let character=exactNameCandidates.length===1
      ? exactNameCandidates[0]
      : candidates.length===1
        ? candidates[0]
        : rawId.startsWith('character-local-')
          ? undefined
          : candidates[0];
    const mappedRaw=rawId&&!ambiguousCharacterRefs.has(rawId)?idMap.get(rawId):undefined;
    const mappedCharacter=mappedRaw?characters.find(c=>c.id===mappedRaw):undefined;
    if(!character&&mappedCharacter&&[mappedCharacter.name,...mappedCharacter.aliases].some(value=>tokens.has(normalizeName(value))))character=mappedCharacter;
    if(!character){character={id:`character-${randomUUID()}`,name,role:['protagonist','supporting','extra'].includes(item.role)?item.role:'supporting',aliases:unique(aliases.filter(x=>x!==name)),appearance:compactCharacterText(item.appearance??'',4000),evidence:compactCharacterText(item.evidence??'',6000)};character.appearance=normalizeCharacterAppearance(character.appearance,character.evidence);characters.push(character);}
    else{
      character.aliases=unique([...character.aliases,...aliases,name].filter(x=>x!==character.name));
      const appearance=compactCharacterText(item.appearance??'',4000);const evidence=compactCharacterText(item.evidence??'',6000);
      if(appearance&&!character.appearance.includes(appearance))character.appearance=unique([character.appearance,appearance]).join('\n');
      if(evidence&&!character.evidence.includes(evidence))character.evidence=unique([character.evidence,evidence]).join('\n');
      character.appearance=normalizeCharacterAppearance(character.appearance,character.evidence);
      if(item.role==='protagonist')character.role='protagonist';
    }
    if(character.aliases.length>30||character.appearance.length>4000||character.evidence.length>6000)throw safeError('累计人物资料超过首版容量，请拆分作品，不会静默丢弃资料。','ANALYSIS_INVALID');
    if(rawId){
      const previous=idMap.get(rawId);
      if(previous&&previous!==character.id){ambiguousCharacterRefs.add(rawId);idMap.delete(rawId);}else if(!ambiguousCharacterRefs.has(rawId))idMap.set(rawId,character.id);
    }
    addReference(name,character.id);for(const alias of aliases)addReference(alias,character.id);
  }
  const assetIds = new Map();
  for (const asset of assets) {
    for (const token of [asset.id, asset.name]) {
      if (typeof token === 'string' && token.trim()) assetIds.set(token.trim(), asset.id);
      if (typeof token === 'string' && token.trim()) assetIds.set(normalizeName(token), asset.id);
    }
  }
  if (data.assets !== undefined && !Array.isArray(data.assets)) invalid('模型返回的关键物品列表无效。', true);
  for (const item of data.assets ?? []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('关键物品条目格式无效。', true);
    const rawId = typeof item.id === 'string' ? item.id.trim() : '';
    const name = normalizeAssetText(item.name, '名称', 120, true);
    const description = normalizeAssetText(item.description, '说明', 4000, false);
    const evidence = normalizeAssetText(item.evidence, '依据', 6000, false);
    const kind = normalizeAssetKind(item.kind);
    const existing = assets.find(asset => asset.id === rawId || normalizeName(asset.name) === normalizeName(name));
    const asset = existing ?? { id: rawId || `asset-${randomUUID()}`, name, kind, description, evidence };
    if (existing) {
      if (existing.name !== name && existing.id === rawId) invalid('关键物品 ID 与名称冲突，无法可靠合并。', true);
      existing.kind = existing.kind || kind;
      if (description && !existing.description.includes(description)) existing.description = unique([existing.description, description]).join('；');
      if (evidence && !String(existing.evidence ?? '').includes(evidence)) existing.evidence = unique([existing.evidence, evidence]).filter(Boolean).join('；');
    } else {
      assets.push(asset);
    }
    assetIds.set(rawId || name, asset.id);
    assetIds.set(normalizeName(rawId || name), asset.id);
    assetIds.set(name, asset.id);
    assetIds.set(normalizeName(name), asset.id);
  }
  normalizeAssetRefs(data, assets, assetIds);
  normalizeAudioPlan(data, project);
  validateShots(data,project,{analysisDurationCap});
  // A chunk normally belongs to one episode. Models sometimes omit the
  // optional label even when the source range is unambiguous; attach that
  // label locally so the whole-work coverage check does not reject an
  // otherwise valid block. Mixed-episode chunks still have to label their
  // boundaries explicitly and are left for the repair prompt.
  if (options.expectedEpisodes?.length === 1 && !(data.segments ?? []).some(segment => Number.isInteger(segment?.episodeNumber))) {
    for (const segment of data.segments ?? []) {
      if (segment && segment.episodeNumber === undefined) segment.episodeNumber = options.expectedEpisodes[0];
    }
  }
  validateEpisodeCoverage(data, options.expectedEpisodes, { requireAll: false });
  normalizeShotCharacterRefs(data);
  normalizeShotDialogueSpeakerRefs(data, idMap);
  normalizeShotMovement(data);
  if(data.segments.some(s=>!s||!Array.isArray(s.shots)))throw safeError('模型没有返回分镜列表。','ANALYSIS_INVALID');
  const mergedSegments=mergeSceneChunk(data,characters,idMap,scenes,looks);
  const segmentSignature=segment=>JSON.stringify({
    episodeNumber:segment.episodeNumber??null,
    episodeTitle:segment.episodeTitle??'',
    title:segment.title??'',
    summary:segment.summary??'',
    duration:segment.duration,
    shots:(segment.shots??[]).map(shot=>({
      sceneId:shot.sceneId,
      scene:shot.scene,
      action:shot.action,
      camera:shot.camera,
      movementId:shot.movementId??'',
      movementPlan:shot.movementPlan??'',
      transitionPlan:shot.transitionPlan??'',
      dialogue:shot.dialogue??'',
      dialogueSpeakerId:shot.dialogueSpeakerId??'',
      narration:shot.narration??'',
      backgroundActors:shot.backgroundActors??'',
      characterIds:shot.characterIds??[],
      assetIds:shot.assetIds??[],
      duration:shot.duration,
    })),
  });
  const existingSegmentSignatures=new Set(
    segments.filter(segment=>Number.isInteger(segment?.episodeNumber)).map(segmentSignature),
  );
  for(const segment of mergedSegments){
    if(!segment||!Array.isArray(segment.shots))throw safeError('模型没有返回分镜列表。','ANALYSIS_INVALID');
    const shots=segment.shots.map(shot=>{
      if(!Array.isArray(shot.characterIds))throw safeError('分镜没有声明出场角色。','ANALYSIS_INVALID');
      return {...shot,characterIds:unique(shot.characterIds.map(id=>{const mapped=idMap.get(id);if(!mapped)throw safeError('分镜引用了未识别角色。','ANALYSIS_INVALID');return mapped;}))};
    });
    const normalizedSegment={...segment,duration:automaticDuration?segment.duration:project.duration,shots};
    const signature=segmentSignature(normalizedSegment);
    // A continuation may repeat the last complete segment from its boundary.
    // Drop only an exact content duplicate; changed shots or summaries remain
    // separate segments even when their titles happen to match.
    if(Number.isInteger(normalizedSegment.episodeNumber)){
      if(existingSegmentSignatures.has(signature))continue;
      existingSegmentSignatures.add(signature);
    }
    segments.push(normalizedSegment);
  }
  if(characters.length>100||segments.length>300||scenes.length>300||looks.length>900)throw safeError('本次作品超过 100 角色、300 片段、300 场景或 900 造型容量，请拆分作品；没有截断正文。','ANALYSIS_INVALID');

  try{validateAnalysis({characters,assets,segments,scenes,looks},project,{analysisResult:analysisDurationCap});}
  catch(error){if(error.code==='INVALID_INPUT')invalid(error.message);throw error;}
  return state;
}

function referenceToken(value){
  if(typeof value==='string'&&value.trim())return value.trim();
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    for(const key of ['id','characterId','name'])if(typeof value[key]==='string'&&value[key].trim())return value[key].trim();
  }
  return null;
}

function normalizeShotCharacterRefs(data){
  for(const segment of data.segments){
    if(!segment||!Array.isArray(segment.shots))invalid('模型返回的片段缺少完整分镜。',true);
    for(const shot of segment.shots){
      if(!shot||typeof shot!=='object'||Array.isArray(shot))invalid('模型返回了无效分镜。',true);
      if(!Array.isArray(shot.characterIds))throw safeError('小说分析包含无效分镜或人物引用列表。','ANALYSIS_INVALID');
      shot.characterIds=shot.characterIds.map(value=>{
        const token=referenceToken(value);if(!token)throw safeError('小说分析包含无效人物引用。','ANALYSIS_INVALID');return token;
      });
    }
  }
}

function normalizeShotDialogueSpeakerRefs(data, idMap){
  for(const segment of data.segments){
    for(const shot of segment.shots){
      const raw=shot.dialogueSpeakerId ?? shot.dialogueSpeaker ?? shot.speaker;
      if(raw===undefined||raw===null||raw===''){
        delete shot.dialogueSpeaker;
        delete shot.speaker;
        continue;
      }
      const token=referenceToken(raw);
      const mapped=token && (idMap.get(token) || idMap.get(normalizeName(token)));
      if(!mapped)invalid('模型返回的台词角色无法映射到人物 ID。',true);
      const castIds=shot.characterIds.map(value=>{const castToken=referenceToken(value);return castToken&&(idMap.get(castToken)||idMap.get(normalizeName(castToken)))||castToken;});
      if(!castIds.includes(mapped))invalid('台词角色必须出现在本镜 characterIds 中。',true);
      shot.dialogueSpeakerId=mapped;
      delete shot.dialogueSpeaker;
      delete shot.speaker;
    }
  }
}

function normalizeShotMovement(data){
  for(const segment of data.segments){
    if(!Array.isArray(segment?.shots))continue;
    segment.shots=segment.shots.map((shot,index)=>{
      const hasMovementFields=['movementId','movementPlan','transitionPlan'].some(key=>shot[key]!==undefined&&shot[key]!==null&&shot[key]!=='');
      return hasMovementFields?normalizeMovementPlan(shot,index):shot;
    });
  }
}


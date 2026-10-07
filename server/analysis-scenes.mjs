import {randomUUID} from 'node:crypto';
import {safeError} from './network.mjs';

const invalid=(message,repairShots=false)=>{const error=safeError(message,'ANALYSIS_INVALID');error.repairShots=repairShots;throw error;};
function field(value,label,max,required=true){
  if(typeof value!=='string'||value.length>max||(required&&!value.trim()))invalid(`模型返回的${label}无效。`);
  return value.trim();
}
function modelId(value){const id=field(value,'场景或造型 ID',100);if(!/^[\w-]+$/.test(id))invalid('模型场景 ID 必须是 ASCII 标识。');return id;}
const sceneToken=value=>typeof value==='string'?value.trim().replace(/\s/g,''):'';

// IDs supplied in each chunk are local unless the model explicitly reuses a
// canonical ID it received in existingScenes. Similar names do not imply the
// same time, location or wardrobe.
export function mergeSceneChunk(data,characters,characterIds,scenes,looks){
  if(data.scenes===undefined&&data.looks===undefined){
    return data.segments.map(segment=>{
      if(segment.shots.some(s=>s.sceneId!==undefined))invalid('分镜声明了场景 ID，但没有对应场景资料。');
      const sceneId=`scene-${randomUUID()}`;
      scenes.push({id:sceneId,name:field(segment.title||'待确认场景','场景名称',200),description:'旧格式分析结果，连续场景和服装须检查确认。'});
      for(const id of new Set(segment.shots.flatMap(s=>s.characterIds??[]))){
        const characterId=characterIds.get(id);const character=characters.find(c=>c.id===characterId);
        if(!character)invalid('分镜引用了未知或歧义人物 ID。');
        looks.push({id:`look-${randomUUID()}`,sceneId,characterId,name:'待确认场景造型',appearance:`待确认创作设定：依据本场景小说核实服装、发型状态与配饰。人物资料：${character.appearance}`.slice(0,4000)});
      }
      return {...segment,shots:segment.shots.map(shot=>({...shot,sceneId}))};
    });
  }
  if(!Array.isArray(data.scenes)||!Array.isArray(data.looks)||data.scenes.length>100||data.looks.length>900)invalid('模型场景或造型列表无效。');
  const ids=new Map(scenes.map(s=>[s.id,s.id]));const seen=new Set();
  for(const input of data.scenes){
    const id=modelId(input?.id);if(seen.has(id))invalid('模型返回了重复场景 ID。');seen.add(id);
    const fields={name:field(input.name,'场景名称',200),description:field(input.description??'','场景描述',4000,false)};
    const existingById=scenes.find(s=>s.id===id);
    const sameDescription=scenes.filter(s=>s.name===fields.name&&s.description===fields.description);
    const existing=existingById??(sameDescription.length===1?sameDescription[0]:null);
    if(existing&&existing.name===fields.name&&existing.description===fields.description){
      ids.set(id,existing.id);
    }else{
      // Providers sometimes reuse a local token after a time or wardrobe
      // change. Fork the scene so the old look cannot leak into this chunk.
      const mapped=`scene-${randomUUID()}`;ids.set(id,mapped);scenes.push({id:mapped,...fields});
    }
  }
  const lookIds=new Set();const pairs=new Set();const lookInputs=[];const pairInputs=new Map();
  for(const input of data.looks){
    const rawId=modelId(input?.id);if(lookIds.has(rawId))invalid('模型返回了重复造型 ID。');lookIds.add(rawId);
    const sceneId=ids.get(typeof input.sceneId==='string'?input.sceneId.trim():''),characterId=characterIds.get(input.characterId)??characterIds.get(typeof input.characterId==='string'?input.characterId.trim():'');
    if(!sceneId||!characterId)invalid('造型引用了未知场景或人物。');
    const fields={name:field(input.name,'造型名称',200),appearance:field(input.appearance,'场景服装描述',4000)};
    const pair=`${sceneId}/${characterId}`;const previousInput=pairInputs.get(pair);
    if(previousInput){if(previousInput.name!==fields.name||previousInput.appearance!==fields.appearance)invalid('同一场景人物存在冲突造型，请为换装创建新场景。');continue;}
    pairInputs.set(pair,fields);lookInputs.push({sceneId,characterId,fields});
  }
  // Decide all wardrobe forks before adding any look. This keeps a multi-actor
  // scene on one new canonical scene regardless of provider look ordering.
  const forkSources=new Set();
  for(const input of lookInputs){
    const existing=looks.find(l=>l.sceneId===input.sceneId&&l.characterId===input.characterId);
    if(existing&&(existing.name!==input.fields.name||existing.appearance!==input.fields.appearance))forkSources.add(input.sceneId);
  }
  const forks=new Map();
  for(const sourceId of forkSources){
    const mapped=`scene-${randomUUID()}`;const source=scenes.find(s=>s.id===sourceId);
    scenes.push({id:mapped,name:`${source?.name??'场景'}（新造型）`.slice(0,200),description:source?.description??'模型返回了新的场景造型状态。'});
    for(const [raw,mappedScene] of ids)if(mappedScene===sourceId)ids.set(raw,mapped);
    const currentLookChars=new Set(lookInputs.filter(input=>input.sceneId===sourceId).map(input=>input.characterId));
    const shotChars=new Set(data.segments.flatMap(segment=>segment.shots).flatMap(shot=>shot.characterIds??[]).map(value=>characterIds.get(value)).filter(Boolean));
    for(const oldLook of looks.filter(look=>look.sceneId===sourceId&&shotChars.has(look.characterId)&&!currentLookChars.has(look.characterId)))looks.push({id:`look-${randomUUID()}`,sceneId:mapped,characterId:oldLook.characterId,name:oldLook.name,appearance:oldLook.appearance});
    forks.set(sourceId,mapped);
  }
  for(const input of lookInputs){
    const sceneId=forks.get(input.sceneId)??input.sceneId;const pair=`${sceneId}/${input.characterId}`;
    if(pairs.has(pair))continue;
    pairs.add(pair);
    const existing=looks.find(l=>l.sceneId===sceneId&&l.characterId===input.characterId);
    if(existing){if(existing.name!==input.fields.name||existing.appearance!==input.fields.appearance)invalid('同一场景人物存在冲突造型，请为换装创建新场景。');}
    else looks.push({id:`look-${randomUUID()}`,sceneId,characterId:input.characterId,...input.fields});
  }
  return data.segments.map(segment=>({...segment,shots:segment.shots.map(shot=>{
    const rawId=typeof shot.sceneId==='string'?shot.sceneId.trim():'';
    const namedIds=new Set([...data.scenes,...scenes].filter(scene=>sceneToken(scene.name)&&sceneToken(scene.name)===sceneToken(shot.scene)).map(scene=>ids.get(scene.id)).filter(Boolean));
    const sceneId=rawId?ids.get(rawId):(namedIds.size===1?[...namedIds][0]:null);
    if(!sceneId)invalid('分镜引用了未知或歧义场景，需按原文与场景列表纠正。',true);
    for(const rawId of shot.characterIds??[]){
      const characterId=characterIds.get(rawId)??characterIds.get(typeof rawId==='string'?rawId.trim():'');
      if(!characterId)invalid('分镜引用了未知人物。');
      if(!looks.some(l=>l.sceneId===sceneId&&l.characterId===characterId)){
        const character=characters.find(item=>item.id===characterId);
        looks.push({id:`look-${randomUUID()}`,sceneId,characterId,name:'待确认场景造型',appearance:`待确认创作设定：依据本场景小说核实服装、发型状态与配饰。人物资料：${character?.appearance??''}`.slice(0,4000)});
      }
    }
    return {...shot,sceneId};
  })}));
}

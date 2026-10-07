import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createProviders } from '../server/providers.mjs';
import { safeError } from '../server/network.mjs';
import { emptyAnalysisState, prepareAnalysisChunk } from '../server/analysis-results.mjs';

const project = { id: 'recovery-project', novel: '正文'.repeat(9500), duration: 30, style: '写实', aspectRatio: '9:16' };
function result(title='片段') {
  return { characters: [], scenes: [{ id:'room', name:'房间', description:'日间' }], looks:[], segments:[{ title, summary:'雨后的空房间', duration:30, shots:Array.from({length:9},(_,i)=>({sceneId:'room',scene:'房间',action:'雨滴挂在窗边',camera:'近景',dialogue:'',characterIds:[],duration:i===8?6:3})) }] };
}
const response = data => ({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]});
async function setup(t,requestJson,getSettings=()=>({llmKey:'private-test-key',llmModel:'qwen3.7-plus'})) {
  const root=await mkdtemp(path.join(tmpdir(),'analysis-recovery-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const options={mediaRoot:path.join(root,'media'),getSettings,requestJson};
  return {root,options,provider:createProviders(options)};
}

test('failed late chunk resumes from durable validated chunks without mixing failed candidates',async t=>{
  const requested=[];let invalid=true;
  const {options,provider,root}=await setup(t,async(_url,options)=>{
    const input=JSON.parse(options.body.messages[1].content);requested.push(input.chunk);
    return response(input.chunk===2&&invalid?{characters:[]}:result(`块 ${input.chunk}`));
  });
  const progress=[];
  await assert.rejects(provider.analyze(project,'first',{onProgress:async x=>progress.push(x)}),e=>e.code==='ANALYSIS_INVALID');
  assert.deepEqual(requested,[1,2,2]);
  assert.ok(progress.some(p=>p.completedChunks===1&&p.totalChunks===2));
  const files=await readdir(path.join(root,'provider-receipts','analysis'));
  const saved=await readFile(path.join(root,'provider-receipts','analysis',files[0]),'utf8');
  assert.doesNotMatch(saved,/private-test-key|正文/);
  assert.equal(JSON.parse(saved).nextChunk,1);
  invalid=false;requested.length=0;
  const completed=await createProviders(options).analyze(project,'second');
  assert.deepEqual(requested,[2]);
  assert.deepEqual(completed.segments.map(s=>s.title),['块 1','块 2']);
  requested.length=0;
  assert.deepEqual(await createProviders(options).analyze(project,'third'),completed);
  assert.deepEqual(requested,[]);
});

test('uncertain request is not retried or replayed by a new provider instance',async t=>{
  let calls=0;
  const {provider,options}=await setup(t,async()=>{calls++;throw safeError('网络超时','NETWORK_TIMEOUT');});
  await assert.rejects(provider.analyze(project,'first'),e=>e.code==='NETWORK_TIMEOUT');
  await assert.rejects(createProviders(options).analyze(project,'second'),e=>e.code==='SUBMISSION_UNKNOWN');
  assert.equal(calls,1);
});

test('explicitly acknowledged analysis retry preserves completed chunks and replays only the uncertain block',async t=>{
  const requested=[];let fail=true;
  const {provider,options}=await setup(t,async(_url,options)=>{
    const input=JSON.parse(options.body.messages[1].content);requested.push(input.chunk);
    if(input.chunk===2&&fail)throw safeError('网络超时','NETWORK_TIMEOUT');
    return response(result(`块 ${input.chunk}`));
  });
  await assert.rejects(provider.analyze(project,'first'),e=>e.code==='NETWORK_TIMEOUT');
  fail=false;
  const complete=await createProviders(options).analyze(project,'acknowledged',{retryUncertain:true});
  assert.deepEqual(requested,[1,2,2]);
  assert.deepEqual(complete.segments.map(s=>s.title),['块 1','块 2']);
});

test('an acknowledged retry that times out cannot be repeated through ordinary analysis',async t=>{
  let calls=0;
  const {provider,options}=await setup(t,async()=>{calls++;throw safeError('网络超时','NETWORK_TIMEOUT');});
  await assert.rejects(provider.analyze(project,'first'),e=>e.code==='NETWORK_TIMEOUT');
  await assert.rejects(createProviders(options).analyze(project,'acknowledged',{retryUncertain:true}),e=>e.code==='NETWORK_TIMEOUT');
  await assert.rejects(createProviders(options).analyze(project,'ordinary'),e=>e.code==='SUBMISSION_UNKNOWN');
  assert.equal(calls,2);
});

test('source or selected model change invalidates the analysis checkpoint',async t=>{
  let calls=0,model='qwen3.7-plus';
  const {provider}=await setup(t,async()=>{calls++;return response(result());},()=>({llmKey:'private-test-key',llmModel:model}));
  const short={...project,novel:'空房间'};
  await provider.analyze(short,'first');
  await provider.analyze({...short,novel:'空房间。'},'changed-source');
  model='qwen3.6-plus';
  await provider.analyze(short,'changed-model');
  assert.equal(calls,3);
});

test('append analysis submits only the unsourced suffix and seeds continuity from existing results', async t => {
  const requested = [];
  const { provider, options } = await setup(t, async (_url, request) => {
    const input = JSON.parse(request.body.messages[1].content);
    requested.push(input.novelChunk);
    return response(result('新增片段'));
  });
  const oldSegment = result('旧片段').segments[0];
  oldSegment.id = 'old-segment';
  const projectWithAppend = {
    id: 'append-project', novel: 'OLDNEW', style: '写实', aspectRatio: '9:16', duration: 30,
    characters: [{ id: 'old-character', name: '旧角色', role: 'supporting', aliases: [], appearance: '成年人。', evidence: '旧正文。', reference: '/media/old.png', approved: true, version: 2 }],
    scenes: [{ id: 'room', name: '房间', description: '日间' }], looks: [], segments: [oldSegment],
  };
  const appended = await provider.analyze(projectWithAppend, 'append-receipt', { analysisAppend: true, appendFrom: 3, analysisBaseSegments: 1 });
  assert.deepEqual(requested, ['NEW']);
  assert.equal(appended.segments[0].id, 'old-segment');
  assert.equal(appended.segments.length, 2);
  assert.equal(appended.characters[0].id, 'old-character');
});

test('a shutdown between chunks preserves the last checkpoint and makes no further submission',async t=>{
  let calls=0;
  const {provider,options}=await setup(t,async()=>{calls++;return response(result());});
  await assert.rejects(provider.analyze(project,'first',{onProgress:async progress=>{
    if(progress.completedChunks===1)throw Object.assign(new Error('closing'),{code:'SERVICE_CLOSED'});
  }}),e=>e.code==='SERVICE_CLOSED');
  assert.equal(calls,1);
  await createProviders(options).analyze(project,'second');
  assert.equal(calls,2);
});

test('merging a rejected chunk never mutates prior state or raw input',()=>{
  const previous=emptyAnalysisState();
  const data=result();data.characters=[{id:'ghost',name:'错误候选',aliases:[],appearance:'短发',role:'extra',evidence:''}];
  data.segments[0].shots[0].sceneId='unknown';
  const before=structuredClone(data);
  assert.throws(()=>prepareAnalysisChunk(data,previous,project),e=>e.code==='ANALYSIS_INVALID');
  assert.deepEqual(previous,emptyAnalysisState());
  assert.deepEqual(data,before);
});

test('analysis compacts repeated character visual notes before they reach the editor',()=>{
  const data=result();
  data.characters=[{id:'cook',name:'御兽总厨',aliases:[],appearance:'成年男性，黑发束起，面容沉稳。\n成年男性，黑发束起，面容沉稳。',role:'supporting',evidence:'他在后厨掌厨。'}];
  const merged=prepareAnalysisChunk(data,emptyAnalysisState(),project);
  assert.equal(merged.characters[0].appearance,'成年男性，黑发束起，面容沉稳。');
});

test('analysis removes copied source evidence from the visual identity brief',()=>{
  const data=result();
  data.characters=[{id:'lin',name:'林遥',aliases:[],role:'protagonist',appearance:'原文：蓝色外套，肩头淋湿。创作设定待确认：青年女性，黑色及肩发，自然妆容。',evidence:'林遥推开门，蓝色外套的肩头淋湿。'}];
  const merged=prepareAnalysisChunk(data,emptyAnalysisState(),project);
  assert.equal(merged.characters[0].appearance,'创作设定待确认：青年女性，黑色及肩发，自然妆容。');
  assert.notEqual(merged.characters[0].appearance,merged.characters[0].evidence);
});

test('analysis keeps a reviewable placeholder when appearance is only copied evidence',()=>{
  const data=result();
  data.characters=[{id:'lin',name:'林遥',aliases:[],role:'protagonist',appearance:'林遥推开门，蓝色外套的肩头淋湿。',evidence:'林遥推开门，蓝色外套的肩头淋湿。'}];
  const merged=prepareAnalysisChunk(data,emptyAnalysisState(),project);
  assert.match(merged.characters[0].appearance,/待确认创作设定/);
  assert.notEqual(merged.characters[0].appearance,merged.characters[0].evidence);
});

test('whitespace in known scene references is normalized without changing wardrobe',()=>{
  const data=result();data.characters=[{id:'lin',name:'林晚',aliases:[],appearance:'短发',evidence:''}];
  data.looks=[{id:'look',sceneId:' room ',characterId:'lin',name:'风衣',appearance:'米色风衣'}];
  for(const shot of data.segments[0].shots){shot.sceneId=' room ';shot.characterIds=['lin'];}
  const merged=prepareAnalysisChunk(data,emptyAnalysisState(),project);
  assert.equal(merged.looks[0].appearance,'米色风衣');
  assert.ok(merged.segments[0].shots.every(s=>s.sceneId===merged.scenes[0].id));
});

test('small model timing errors preserve shot content and proportions while fitting 15 and 30 seconds',()=>{
  for(const duration of [15,30]){
    const data=result();data.segments[0].duration=duration;
    data.segments[0].shots.forEach((shot,index)=>{shot.duration=(index===8?2.4:1.6)*duration/15;shot.action=`镜头动作 ${index}`;});
    const original=structuredClone(data);
    const previous=emptyAnalysisState();
    const merged=prepareAnalysisChunk(data,previous,{...project,duration});
    const shots=merged.segments[0].shots;
    assert.ok(Math.abs(shots.reduce((sum,shot)=>sum+shot.duration,0)-duration)<1e-8);
    assert.ok(Math.abs(shots[8].duration/shots[0].duration-1.5)<0.01);
    assert.deepEqual(shots.map(({sceneId,duration,...content})=>content),original.segments[0].shots.map(({sceneId,duration,...content})=>content));
    assert.deepEqual(data,original);
    assert.deepEqual(previous,emptyAnalysisState());
  }
});

test('arithmetic-only timing errors do not cause a second paid model request',async t=>{
  let calls=0;
  const {provider}=await setup(t,async()=>{
    calls++;const data=result();data.segments[0].duration=15;
    data.segments[0].shots.forEach(shot=>{shot.duration=2;});
    return response(data);
  });
  const completed=await provider.analyze({...project,novel:'空房间',duration:15},'timing');
  assert.equal(calls,1);
  assert.ok(Math.abs(completed.segments[0].shots.reduce((sum,shot)=>sum+shot.duration,0)-15)<1e-8);
});

test('timing normalization still rejects large errors, invalid values, and fixed duration mismatch',()=>{
  const cases=[
    data=>data.segments[0].shots.forEach(shot=>{shot.duration=1;}),
    data=>{data.segments[0].shots[0].duration=0;},
    data=>{data.segments[0].shots[0].duration='3';},
    data=>{data.segments[0].shots[0].duration=Infinity;},
    data=>{data.segments[0].duration=15;data.segments[0].shots.forEach(shot=>{shot.duration=15/9;});},
    data=>{data.segments[0].shots.forEach(shot=>{shot.duration=4;});data.segments[0].shots[8].duration=0.1;},
    data=>{data.segments[0].shots.forEach(shot=>{shot.duration=1.5;});data.segments[0].shots[0].duration=15;},
  ];
  for(const modify of cases){
    const data=result();modify(data);
    assert.throws(()=>prepareAnalysisChunk(data,emptyAnalysisState(),project),error=>error.code==='ANALYSIS_INVALID');
  }
});

test('automatic duration respects the model selected 15 seconds within a 30 second project',()=>{
  const data=result();data.segments[0].duration=15;
  data.segments[0].shots.forEach(shot=>{shot.duration=1.5;});
  const merged=prepareAnalysisChunk(data,emptyAnalysisState(),{...project,durationMode:'auto'});
  assert.equal(merged.segments[0].duration,15);
  assert.ok(Math.abs(merged.segments[0].shots.reduce((sum,shot)=>sum+shot.duration,0)-15)<1e-8);
});

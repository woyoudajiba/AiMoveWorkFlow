import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createProviders, splitNovel, extractEpisodePlan } from '../server/providers.mjs';
import { emptyAnalysisState, prepareAnalysisChunk } from '../server/analysis-results.mjs';
import { isPublicAddress, validateRemoteUrl, requestBuffer, safeError } from '../server/network.mjs';

const nineShots = ({ sceneId = 's1', scene = '空场', characterIds = [] } = {}) =>
  Array.from({ length: 9 }, (_, index) => ({
    sceneId, scene, action: '静止', camera: '远景', dialogue: '', characterIds,
    duration: index === 8 ? 6 : 3,
  }));

test('remote download boundary rejects local IPv4, IPv6, mapped addresses and DNS rebinding', async () => {
  for (const ip of ['127.0.0.1','10.1.2.3','172.16.2.3','192.168.1.2','169.254.169.254','100.64.1.2','0.0.0.0','::1','::','fc00::1','fe80::1','::ffff:127.0.0.1','::ffff:7f00:1','2002:7f00:1::']) assert.equal(isPublicAddress(ip),false,ip);
  assert.equal(isPublicAddress('8.8.8.8'),true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  await assert.rejects(validateRemoteUrl('http://example.com'));
  await assert.rejects(validateRemoteUrl('https://name.test', async () => [{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]), /地址/);
});

test('novel chunking preserves every character and enforces a visible input bound', () => {
  const novel=('第一章，阿青回家。\n').repeat(5000);
  const chunks=splitNovel(novel);
  assert.equal(chunks.join(''),novel);
  assert.ok(chunks.every(chunk=>chunk.length<=18000));
  assert.throws(()=>splitNovel('文'.repeat(120001)),/120000/);
});

test('provider settings never fall back to process environment credentials', async t => {
  const names=['DASHSCOPE_API_KEY','QWEN_API_KEY','ALIBABA_CODING_PLAN_API_KEY','GRSAI_API_KEY','MINIMAX_API_KEY','XIONGMAO_API_KEY','XIONGMAO_MINIMAXH3_API_KEY','ARK_API_KEY'];
  const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  t.after(()=>{for(const name of names)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];});
  for(const name of names)process.env[name]='environment-secret-fixture';
  let requests=0;
  const providers=createProviders({mediaRoot:tmpdir(),getSettings:()=>({}),requestJson:async()=>{requests++;return {choices:[]};}});
  await assert.rejects(providers.analyze({novel:'小说',duration:30}),error=>error.code==='NOT_CONFIGURED');
  assert.equal(requests,0);
});

test('oversize request is a definite local rejection before a billable HTTP call',async()=>{
  await assert.rejects(requestBuffer('https://public.example',{method:'POST',body:'x'.repeat(48*1024*1024+1),lookup:async()=>[{address:'8.8.8.8',family:4}]}),e=>e.code==='PAYLOAD_TOO_LARGE'&&e.definitive===true);
});

test('analysis carries previous character IDs and merges aliases across chunks', async () => {
  let n=0; const requests=[];
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'test-key'}),requestJson:async (url, options)=>{
    requests.push(options.body); n++;
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({characters:[{id:n===1?'c1':'other',name:n===1?'沈青':'阿青',aliases:n===1?['阿青']:['沈青'],role:'protagonist',appearance:'黑发',evidence:'阿青'}],scenes:[{id:'rain',name:'雨巷',description:'夜雨'}],looks:[{id:'rain-look',sceneId:'rain',characterId:n===1?'c1':'other',name:'风衣',appearance:'深色风衣'}],segments:[{title:'重逢',summary:'见面',duration:30,shots:nineShots({sceneId:'rain',scene:'雨巷',characterIds:[n===1?'c1':'other']}).map(shot=>({...shot,action:'回望',camera:'近景'}))}]})}}]};
  }});
  const result=await p.analyze({novel:'阿青。'.repeat(7000),duration:30,style:'电影',aspectRatio:'9:16'});
  assert.equal(requests.length,2);
  assert.equal(result.characters.length,1);
  assert.equal(result.segments[1].shots[0].characterIds[0],result.characters[0].id);
  assert.match(requests[1].messages[1].content,/沈青/);
});

test('truncated structured model response fails explicitly', async () => {
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'secret'}),requestJson:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})});
  await assert.rejects(p.analyze({novel:'小说',duration:30}),/截断/);
});

test('analysis retries a provider rate limit without repeating a completed chunk', async () => {
  let calls = 0;
  const complete = { characters: [], scenes: [{ id: 's1', name: '空场', description: '' }], looks: [], segments: [{ title: '一段', summary: '空场', duration: 30, shots: nineShots() }] };
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async () => {
    calls++;
    if (calls === 1) {
      const error = safeError('模型服务限流', 'UPSTREAM_HTTP');
      error.status = 429; error.retryable = true; error.retryAfterMs = 1;
      throw error;
    }
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(complete) } }] };
  } });
  const result = await provider.analyze({ novel: '空场。', duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.equal(calls, 2);
  assert.equal(result.segments.length, 1);
});

test('long analysis bounds each model response to one compact segment', async () => {
  const requests = [];
  const response = { characters: [], scenes: [{ id: 's1', name: '空场', description: '' }], looks: [], segments: [{ title: '一段', summary: '空场', duration: 30, shots: Array.from({ length: 9 }, (_, index) => ({ sceneId: 's1', scene: '空场', action: '静止', camera: '远景', dialogue: '', characterIds: [], duration: index === 8 ? 6 : 3 })) }] };
  const p = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    requests.push(options.body);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] };
  } });
  const result = await p.analyze({ novel: '长篇。'.repeat(12000), duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.ok(requests.length >= 4);
  assert.ok(requests.every(body => body.max_tokens === 12000));
  assert.ok(requests.every(body => JSON.parse(body.messages[1].content).maxSegments === 1));
  assert.equal(result.segments.length, requests.length);
});

test('analysis repairs a compact response with empty shot objects once', async () => {
  let calls = 0;
  const complete = { characters: [], scenes: [{ id: 's1', name: '空场', description: '' }], looks: [], segments: [{ title: '一段', summary: '空场', duration: 30, shots: nineShots() }] };
  const requests = [];
  const p = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    calls++;
    requests.push(options.body);
    if (calls === 1) return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...complete, segments: [{ ...complete.segments[0], shots: Array.from({ length: 9 }, () => ({})) }] }) } }] };
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ segments: complete.segments }) } }] };
  } });
  const result = await p.analyze({ novel: '空场里，林晚停下脚步。', duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.equal(calls, 2);
  assert.equal(result.segments[0].shots.length, 9);
  const repairInput = JSON.parse(requests[1].messages[1].content);
  assert.match(requests[1].messages[0].content, /只输出JSON对象/);
  assert.match(requests[1].messages[0].content, /受约束影视化补全/);
  assert.match(requests[1].messages[0].content, /起始状态.*可见动作\/反应.*结果状态/);
  assert.equal(repairInput.novelChunk, '空场里，林晚停下脚步。');
  assert.equal(repairInput.allowedScenes[0].id, 's1');
  assert.deepEqual(repairInput.originalSegments[0].shots[0], {});
});

test('analysis uses a source-bound visual completion after structural repair still fails', async () => {
  let calls = 0;
  const valid = { characters: [], scenes: [{ id: 's1', name: '旧仓库', description: '夜晚' }], looks: [], segments: [{ title: '停下', summary: '主角在旧仓库停下', duration: 9, shots: Array.from({ length: 3 }, (_, index) => ({ sceneId: 's1', scene: '旧仓库', action: ['门口的身影停住', '手掌离开门把，身体回望', '仓库内恢复安静'][index], camera: ['远景', '中景', '静物近景'][index], movementId: `move-${index + 1}`, movementPlan: '保持动作轴和焦点连续。', transitionPlan: '', dialogue: '', narration: '', backgroundActors: '', characterIds: [], duration: 3 })) }] };
  const requests = [];
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    calls += 1;
    requests.push(options.body);
    if (calls < 3) {
      const invalid = structuredClone(valid);
      invalid.segments[0].shots = Array.from({ length: 2 }, () => ({ sceneId: 's1', scene: '旧仓库', action: '停下', camera: '中景', characterIds: [], duration: 4.5 }));
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls === 1 ? invalid : { segments: invalid.segments }) } }] };
    }
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ segments: valid.segments }) } }] };
  } });
  const result = await provider.analyze({ novel: '主角走到旧仓库门口，停下脚步。', duration: 30, durationMode: 'auto', generationMode: 'segment-board', style: '电影', aspectRatio: '9:16' });
  assert.equal(calls, 3);
  assert.equal(result.segments[0].shots.length, 3);
  assert.match(requests[2].messages[0].content, /最后一次受约束视觉补全/);
  assert.match(requests[2].messages[0].content, /禁止新增人物、地点、时间线、道具功能、冲突结果、对白、旁白或群众行为/);
  assert.equal(JSON.parse(requests[2].messages[1].content).completionMode, 'source-bound-visual-completion');
});

test('analysis repairs an unknown shot scene using the chunk source and allowed scene catalog', async () => {
  let calls = 0;
  const response = { characters: [], scenes: [{ id: 'office', name: '办公室', description: '白天' }], looks: [], segments: [{ title: '一段', summary: '窗边', duration: 30, shots: nineShots({ sceneId: 'missing', scene: '窗边' }) }] };
  const p = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async () => {
    calls++;
    const data = calls === 1 ? response : { segments: [{ ...response.segments[0], shots: nineShots({ sceneId: 'office', scene: '办公室' }) }] };
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] };
  } });
  const result = await p.analyze({ novel: '林晚走进办公室，窗外下着雨。', duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.equal(calls, 2);
  assert.ok(result.segments[0].shots.every(shot => shot.sceneId === result.scenes[0].id));
});

test('analysis never pads an invalid correction with placeholder shots', async () => {
  let calls = 0;
  const valid = { characters: [], scenes: [{ id: 's1', name: '空场', description: '' }], looks: [], segments: [{ title: '一段', summary: '空场', duration: 30, shots: nineShots() }] };
  const p = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async () => {
    calls++;
    const shots = Array.from({ length: 8 }, () => ({}));
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(calls === 1 ? { ...valid, segments: [{ ...valid.segments[0], shots }] } : { segments: [{ ...valid.segments[0], shots }] }) } }] };
  } });
  await assert.rejects(p.analyze({ novel: '原文', duration: 30 }), error => error.code === 'ANALYSIS_INVALID' && /9/.test(error.message));
  assert.equal(calls, 3);
});

test('analysis retries an invalid top-level response once with the novel chunk', async () => {
  let calls = 0;
  const complete = { characters: [], scenes: [{ id: 's1', name: '空场', description: '' }], looks: [], segments: [{ title: '一段', summary: '空场', duration: 30, shots: nineShots() }] };
  const requests = [];
  const p = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    calls++;
    requests.push(options.body);
    const content = calls === 1 ? '{"characters":[]}' : JSON.stringify(complete);
    return { choices: [{ finish_reason: 'stop', message: { content } }] };
  } });
  const result = await p.analyze({ novel: '空场。', duration: 30 });
  assert.equal(calls, 2);
  assert.equal(result.segments.length, 1);
  assert.match(requests[1].messages[0].content, /characters、scenes、looks、segments/);
  assert.equal(JSON.parse(requests[1].messages[1].content).novelChunk, '空场。');
});

test('automatic duration recommendation preserves mixed 15 and 30 second segments and asks the model to judge pacing',async()=>{
  let request;
  const response={characters:[],scenes:[{id:'bookstore',name:'书店',description:'室内'}],looks:[],segments:[15,30].map(duration=>({title:duration===15?'快速蒙太奇':'对话展开',summary:'本段剧情',duration,shots:Array.from({length:9},(_,index)=>({sceneId:'bookstore',scene:'书店',action:'看向窗外',camera:'近景',dialogue:'',characterIds:[],duration:index===8?duration/5:duration/10}))}))};
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async(_url,options)=>{request=options.body;return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]};}});
  const result=await p.analyze({novel:'风吹动树叶。随后两个人在书店展开长谈。',duration:30,durationMode:'auto',style:'电影',aspectRatio:'9:16'});
  assert.deepEqual(result.segments.map(segment=>segment.duration),[15,30]);
  const input=JSON.parse(request.messages[1].content);
  assert.equal(input.segmentDuration,'recommend-15-or-30');
  assert.equal(input.outputSchema.segments[0].duration,'15|30');
  assert.match(request.messages[0].content,/台词/);
  assert.match(request.messages[0].content,/快切/);
  assert.match(request.messages[0].content,/同一作品/);
});

test('narrative mode and dialogue evidence are included, with narration kept separate', async () => {
  let request;
  const shots = nineShots({ sceneId: 'room', scene: '室内' });
  shots[0] = { ...shots[0], dialogue: '你终于来了。', narration: '雨声停在门外。', movementId: 'move-71', movementPlan: '焦点从门外转到角色眼睛。', transitionPlan: '承接环境空镜的横摇，焦点转入人物。' };
  const response = { characters: [], scenes: [{ id: 'room', name: '室内', description: '夜晚' }], looks: [], segments: [{ title: '重逢', summary: '人物在室内重逢', duration: 30, shots }] };
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => { request = options.body; return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] }; } });
  const result = await provider.analyze({ novel: '甲：你终于来了。\n雨声停在门外。', duration: 30, style: '纪录片', aspectRatio: '16:9', narrativeMode: 'narrator' });
  const input = JSON.parse(request.messages[1].content);
  assert.match(request.messages[0].content, /旁白视角/);
  assert.match(request.messages[0].content, /dialogue/);
  assert.match(JSON.parse(request.messages[1].content).movementCatalog, /move-71/);
  assert.deepEqual(input.dialogueEvidence, [{ speaker: '甲', text: '你终于来了。' }]);
  assert.equal(result.segments[0].shots[0].dialogue, '你终于来了。');
  assert.equal(result.segments[0].shots[0].narration, '雨声停在门外。');
  assert.equal(result.segments[0].shots[0].movementId, 'move-71');
  assert.match(result.segments[0].shots[0].transitionPlan, /横摇/);
});

test('analysis removes duplicate generated dialogue and keeps novel shots free of invented narration', async () => {
  const shots = nineShots({ sceneId: 'room' });
  shots[0] = { ...shots[0], dialogue: '你终于来了。', narration: '镜头缓缓推进。' };
  shots[1] = { ...shots[1], dialogue: '你终于来了。', narration: '雨声在门外回响。' };
  const state = prepareAnalysisChunk({
    characters: [],
    scenes: [{ id: 'room', name: '室内', description: '夜晚' }],
    looks: [],
    segments: [{ title: '重逢', summary: '人物重逢', duration: 30, shots }],
  }, emptyAnalysisState(), { duration: 30, durationMode: 'fixed', generationMode: 'legacy-shot', sourceType: 'novel', narrativeMode: 'auto' });
  assert.equal(state.segments[0].shots[0].dialogue, '你终于来了。');
  assert.equal(state.segments[0].shots[1].dialogue, '');
  assert.equal(state.segments[0].shots.every(shot => !shot.narration), true);
});

test('segment video prompts omit placeholder prose from every visual field', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-placeholder-prompt-')); t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 320, height: 568, channels: 3, background: '#17243f' } }).png().toBuffer();
  const requests = [];
  const provider = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { id: 'placeholder-task', status: 'queued' }; },
  });
  const project = { id: 'placeholder-project', generationMode: 'segment-board', durationMode: 'auto', aspectRatio: '9:16', style: '电影', characters: [], scenes: [{ id: 's1', name: '原文未描述，待确认', description: '待确认创作设定' }], looks: [] };
  const image = await provider.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  const segment = { id: 'seg1', number: 1, title: '测试', summary: '原文未描述，待确认', duration: 9, storyboardImage: image, shots: Array.from({ length: 3 }, (_, index) => ({ id: `shot-${index + 1}`, number: index + 1, sceneId: 's1', scene: '原文未提供', action: '待确认分镜', camera: '依据本段摘要补充', movementPlan: '待确认创作设定', transitionPlan: '', dialogue: '', narration: '', backgroundActors: '原文未描述，待确认', characterIds: [], duration: 3, image, approved: true, version: 1, imageVersion: 1 })) };
  await provider.submitSegmentVideo(project, segment, 'placeholder-business');
  const prompt = requests[0].content[0].text;
  assert.doesNotMatch(prompt, /原文未描述|原文未提供|待确认创作设定|待确认分镜|依据本段摘要补充/);
});

test('analysis repairs a response that drops every explicit dialogue line', async () => {
  let calls = 0;
  const makeResponse = dialogue => {
    const shots = nineShots({ sceneId: 'room', scene: '室内' });
    shots[0] = { ...shots[0], dialogue };
    return { characters: [], scenes: [{ id: 'room', name: '室内', description: '夜晚' }], looks: [], segments: [{ title: '重逢', summary: '人物在室内重逢', duration: 30, shots }] };
  };
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    calls += 1;
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(makeResponse(calls === 1 ? '' : '你终于来了。')) } }] };
  } });
  const result = await provider.analyze({ novel: '甲：你终于来了。', duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.equal(calls, 2);
  assert.equal(result.segments[0].shots[0].dialogue, '你终于来了。');
});

test('duplicate provider character IDs cannot silently reassign all shots to a different person',async()=>{
  const response={characters:[{id:'same',name:'沈青',aliases:[],appearance:'黑发',evidence:''},{id:'same',name:'苏明',aliases:[],appearance:'白衣',evidence:''}],segments:[{title:'重逢',shots:[{characterIds:['same']}]}]};
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]})});
  await assert.rejects(p.analyze({novel:'沈青和苏明重逢。',duration:30}),e=>e.code==='ANALYSIS_INVALID'&&e.definitive===true&&e.message.includes('人物 ID'));
});

test('analysis merges repeated character IDs by unique names and normalizes object references',async()=>{
  const response={characters:[
    {id:'same',name:'沈青',aliases:['阿青'],appearance:'黑发',evidence:'沈青'},
    {id:'same',name:'沈青',aliases:['阿青'],appearance:'黑发',evidence:'阿青'}
  ],scenes:[{id:'s1',name:'雨巷',description:'夜雨'}],looks:[{id:'l1',sceneId:'s1',characterId:'same',name:'风衣',appearance:'深色风衣'}],segments:[{title:'重逢',summary:'见面',duration:30,shots:Array.from({length:9},(_,i)=>({sceneId:'s1',scene:'雨巷',action:'回望',camera:'近景',dialogue:'',characterIds:[i===0?{name:'阿青'}:'same'],duration:i===8?6:3}))}]};
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]})});
  const result=await p.analyze({novel:'沈青。'.repeat(10),duration:30,style:'电影',aspectRatio:'9:16'});
  assert.equal(result.characters.length,1);assert.equal(result.scenes.length,1);assert.equal(result.looks.length,1);
  assert.ok(result.segments[0].shots.every(shot=>shot.characterIds[0]===result.characters[0].id));
});

test('analysis forks a scene when a later chunk changes wardrobe under the same local scene ID',async()=>{
  let index=0;
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async()=>{
    index++;
    const second=index===2;
    const response={characters:[{id:'hero',name:'林晚',aliases:[],appearance:'短发',evidence:'林晚'}],scenes:[{id:'s1',name:'旧剧场',description:second?'第二天':'第一天'}],looks:[{id:'look',sceneId:'s1',characterId:'hero',name:second?'白衬衫':'风衣',appearance:second?'白衬衫':'米色风衣'}],segments:[{title:second?'第二天':'第一天',summary:'本段',duration:30,shots:Array.from({length:9},(_,i)=>({sceneId:'s1',scene:'旧剧场',action:'站立',camera:'中景',dialogue:'',characterIds:['hero'],duration:i===8?6:3}))}]};
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]};
  }});
  const result=await p.analyze({novel:'林晚。'.repeat(10000),duration:30,style:'电影',aspectRatio:'9:16'});
  assert.equal(result.scenes.length,2);assert.equal(result.looks.length,2);assert.notEqual(result.segments[0].shots[0].sceneId,result.segments[1].shots[0].sceneId);assert.equal(result.looks[1].appearance,'白衬衫');
});

test('analysis forks all actors before applying a later multi-actor wardrobe change',async()=>{
  let index=0;
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async()=>{
    index++;
    const second=index===2;
    const response={characters:[{id:'a',name:'何一',aliases:[],appearance:'短发',evidence:'何一'},{id:'b',name:'苏二',aliases:[],appearance:'长发',evidence:'苏二'}],scenes:[{id:'s1',name:'仓库',description:second?'夜晚':'白天'}],looks:second?[
      {id:'b-look',sceneId:'s1',characterId:'b',name:'白衬衫',appearance:'白衬衫'},
      {id:'a-look',sceneId:'s1',characterId:'a',name:'红大衣',appearance:'红色大衣'}
    ]:[{id:'a-look',sceneId:'s1',characterId:'a',name:'蓝风衣',appearance:'蓝色风衣'},{id:'b-look',sceneId:'s1',characterId:'b',name:'白衬衫',appearance:'白衬衫'}],segments:[{title:'一段',summary:'本段',duration:30,shots:Array.from({length:9},(_,i)=>({sceneId:'s1',scene:'仓库',action:'对视',camera:'中景',dialogue:'',characterIds:['a','b'],duration:i===8?6:3}))}]};
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]};
  }});
  const result=await p.analyze({novel:'何一和苏二。'.repeat(5000),duration:30,style:'电影',aspectRatio:'9:16'});
  assert.equal(result.scenes.length,2);assert.equal(result.looks.filter(look=>look.sceneId===result.segments[1].shots[0].sceneId).length,2);
  assert.ok(result.looks.some(look=>look.appearance==='红色大衣'&&look.sceneId===result.segments[1].shots[0].sceneId));
  assert.ok(result.looks.some(look=>look.appearance==='白衬衫'&&look.sceneId===result.segments[1].shots[0].sceneId));
});

test('analysis never merges a canonical character ID with a conflicting new name',async()=>{
  let index=0;let canonical;
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async()=>{
    index++;
    const response={characters:[{id:index===1?'hero':canonical,name:index===1?'何一':'苏二',aliases:[],appearance:'短发',evidence:index===1?'何一':'苏二'}],scenes:[{id:'s1',name:'室内',description:'同一场'}],looks:[{id:'l1',sceneId:'s1',characterId:index===1?'hero':canonical,name:'日常',appearance:'日常服'}],segments:[{title:'一段',summary:'本段',duration:30,shots:Array.from({length:9},(_,i)=>({sceneId:'s1',scene:'室内',action:'站立',camera:'中景',dialogue:'',characterIds:[index===1?'hero':canonical],duration:i===8?6:3}))}]};
    if(index===1)canonical='hero';
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]};
  }});
  await assert.rejects(p.analyze({novel:'何一和苏二。'.repeat(5000),duration:30,style:'电影',aspectRatio:'9:16'}),e=>e.code==='ANALYSIS_INVALID'&&e.message.includes('人物 ID'));
});

test('analysis accepts explicit empty characterIds for an empty room',async()=>{
  const response={characters:[],scenes:[{id:'s1',name:'空房间',description:'安静'}],looks:[],segments:[{title:'空镜',summary:'空房间',duration:30,shots:Array.from({length:9},(_,i)=>({sceneId:'s1',scene:'空房间',action:'静止',camera:'远景',dialogue:'',characterIds:[],duration:i===8?6:3}))}]};
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]})});
  const result=await p.analyze({novel:'空房间。'.repeat(10),duration:30,style:'电影',aspectRatio:'9:16'});
  assert.ok(result.segments[0].shots.every(shot=>Array.isArray(shot.characterIds)&&shot.characterIds.length===0));
});

test('news analysis keeps an empty cast and carries source type and evidence guidance', async () => {
  const requests = [];
  const response = { characters: [], scenes: [{ id: 'timeline', name: '事件时间线', description: '报道中的时间与地点' }], looks: [], segments: [{ title: '事件经过', summary: '按报道顺序展示事件节点', duration: 30, shots: nineShots({ sceneId: 'timeline', scene: '事件时间线' }).map((shot, index) => ({ ...shot, action: `展示原文事件节点 ${index + 1}`, sourceEvidence: '报道：事件发生在周一，机构发布了公告。' })) }] };
  const p = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => { requests.push(options.body); return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] }; } });
  const result = await p.analyze({ novel: '新闻报道：事件发生在周一，机构发布了公告。', sourceType: 'news', duration: 30, style: '新闻纪实', aspectRatio: '16:9' });
  assert.deepEqual(result.characters, []);
  assert.equal(result.segments[0].shots[0].sourceEvidence.includes('报道'), true);
  assert.match(requests[0].messages[0].content, /当前内容类型：新闻/);
  assert.match(requests[0].messages[0].content, /仅使用原文事实/);
  assert.equal(JSON.parse(requests[0].messages[1].content).aspectRatio, '16:9');
});

test('MiniMax H3 uses the official multimodal reference request when character references are present', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-minimax-h3-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];
  const p=createProviders({mediaRoot:root,getSettings:()=>({minimaxKey:'private-minimax-key',videoModel:'MiniMax-H3'}),requestJson:async(url,options)=>{
    calls.push({url,...options});
    return calls.length===1 ? {task_id:'424010985738629'} : {task:{id:'424010985738629',model:'MiniMax-H3',status:'succeeded',content:{url:'https://video.example/h3.mp4'}}};
  }});
  const project={id:'p1',style:'电影',aspectRatio:'9:16',characters:[]};
  const png=await sharp({create:{width:256,height:512,channels:3,background:'blue'}}).png().toBuffer();
  const image=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const characterReference=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  project.characters=[{id:'lin',name:'林晚',appearance:'黑色短发、米色风衣',reference:characterReference,approved:true}];
  const shot={image,approved:true,duration:2,trimStart:0,action:'回头',scene:'雨巷',camera:'推进',characterIds:['lin']};
  const submitted=await p.submitVideo(project,shot,'business_1');
  assert.equal(submitted.id,'424010985738629');
  assert.equal(calls[0].url,'https://api.minimax.cn/v2/video_generation');
  assert.equal(calls[0].body.model,'MiniMax-H3');
  assert.equal(calls[0].body.resolution,'2K');
  assert.equal(calls[0].body.duration,4);
  assert.equal(calls[0].body.ratio,'adaptive');
  assert.equal(calls[0].body.content[0].type,'text');
  assert.equal(calls[0].body.content[0].text.endsWith('与参考素材完全一致'),true);
  assert.match(calls[0].body.content[0].text,/字幕/);
  assert.match(calls[0].body.content[0].text,/对白.*声音元数据|audio.*metadata/i);
  assert.match(calls[0].body.content[0].text,/禁止随机路人对白、群众闲聊/);
  assert.match(calls[0].body.content[0].text,/dialogue 字段明确写出的台词/);
  assert.equal(calls[0].body.content[1].type,'image_url');
  assert.equal(calls[0].body.content[1].role,'reference_image');
  assert.equal(calls[0].body.content[2].role,'reference_image');
  assert.equal(calls[0].body.content.length,3);
  assert.ok(calls[0].body.content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(Object.hasOwn(calls[0].body,'prompt'),false);
  const polled=await p.pollVideo('424010985738629');
  assert.equal(polled.status,'completed');
  assert.equal(polled.url,'https://video.example/h3.mp4');
  assert.equal(calls[1].url,'https://api.minimax.cn/v2/query/video_generation/424010985738629');
  assert.equal(calls[0].headers.Authorization,'Bearer private-minimax-key');
});

test('Xiongmao MiniMax H3 uploads ordered references and polls its task contract', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-xiongmao-h3-')); t.after(() => rm(root, { recursive: true, force: true }));
  const jsonCalls = [];
  const uploadCalls = [];
  const p = createProviders({
    mediaRoot: root,
    getSettings: () => ({ xiongmaoMinimaxH3Key: 'private-xiongmao-key', videoModel: 'xiongmao-minimaxh3' }),
    requestMultipartJson: async (url, options) => {
      uploadCalls.push({ url, options });
      return { url: `https://cdn.example/reference-${uploadCalls.length}.png` };
    },
    requestJson: async (url, options) => {
      jsonCalls.push({ url, options });
      if (jsonCalls.length === 1) return { task_id: 'xiongmao-task-1', status: 'pending' };
      if (jsonCalls.length === 2) return { task_id: 'xiongmao-task-1', status: 'pending' };
      if (jsonCalls.length === 3) return { task_id: 'xiongmao-task-1', status: 'processing', progress: 42 };
      return { task_id: 'xiongmao-task-1', status: 'completed', is_final: true, output_url: 'https://cdn.example/video.mp4' };
    },
  });
  const project = { id: 'p1', style: '电影', aspectRatio: '9:16', characters: [] };
  const png = await sharp({ create: { width: 256, height: 512, channels: 3, background: 'blue' } }).png().toBuffer();
  const image = await p.importImage(project, `data:image/png;base64,${png.toString('base64')}`);
  const characterReference = await p.importImage(project, `data:image/png;base64,${png.toString('base64')}`);
  project.characters = [{ id: 'lin', name: '林晚', appearance: '黑色短发、米色风衣', reference: characterReference, approved: true }];
  const shot = { image, approved: true, duration: 2, trimStart: 0, action: '回头', scene: '雨巷', camera: '推进', characterIds: ['lin'] };
  const submitted = await p.submitVideo(project, shot, 'business_xiongmao');
  assert.equal(submitted.id, 'xiongmao-task-1');
  assert.equal(uploadCalls.length, 2);
  assert.ok(uploadCalls.every(call => call.url === 'https://panda.token6688.com/v1/files'));
  assert.ok(uploadCalls.every(call => call.options.headers.Authorization === 'Bearer private-xiongmao-key'));
  assert.equal(jsonCalls[0].url, 'https://panda.token6688.com/v1/videos/generations');
  assert.equal(jsonCalls[0].options.body.model, 'minimax-h3');
  assert.equal(jsonCalls[0].options.body.mode, 'reference');
  assert.equal(jsonCalls[0].options.body.duration, 4);
  assert.equal(jsonCalls[0].options.body.resolution, '2k');
  assert.equal(jsonCalls[0].options.body.aspect_ratio, '9:16');
  assert.equal(jsonCalls[0].options.body.client_request_id, 'business_xiongmao');
  assert.deepEqual(jsonCalls[0].options.body.images, ['https://cdn.example/reference-1.png', 'https://cdn.example/reference-2.png']);
  assert.match(jsonCalls[0].options.body.prompt, /图片输入顺序固定/);
  assert.equal(JSON.stringify(jsonCalls[0].options.body).includes('private-xiongmao-key'), false);
  assert.equal((await p.pollVideo('xiongmao-task-1')).status, 'queued');
  assert.equal((await p.pollVideo('xiongmao-task-1')).status, 'running');
  const completed = await p.pollVideo('xiongmao-task-1');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.url, 'https://cdn.example/video.mp4');
  assert.equal(jsonCalls[1].url, 'https://panda.token6688.com/v1/tasks/xiongmao-task-1');
  assert.equal(jsonCalls[2].url, 'https://panda.token6688.com/v1/tasks/xiongmao-task-1');
});

test('Xiongmao only completes final tasks and accepts documented result URL variants', async () => {
  const responses = [
    { status: 'processing', output_url: 'https://cdn.example/intermediate.mp4', progress: 60 },
    { status: 'completed', is_final: true, result: { videos: [{ url: 'https://cdn.example/result.mp4' }] } },
    { status: 'completed', is_final: true, result_url: 'https://cdn.example/legacy-result.mp4' },
  ];
  const p = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ xiongmaoMinimaxH3Key: 'private-xiongmao-key', videoModel: 'xiongmao-minimaxh3' }),
    requestJson: async () => responses.shift(),
  });
  const processing = await p.pollVideo('xiongmao-variant-task');
  assert.equal(processing.status, 'running');
  assert.equal(processing.url, undefined);
  const nested = await p.pollVideo('xiongmao-variant-task');
  assert.equal(nested.status, 'completed');
  assert.equal(nested.url, 'https://cdn.example/result.mp4');
  const legacy = await p.pollVideo('xiongmao-variant-task');
  assert.equal(legacy.status, 'completed');
  assert.equal(legacy.url, 'https://cdn.example/legacy-result.mp4');
});

test('Xiongmao Seedance official variants map suffixes to quality values', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-xiongmao-seedance-')); t.after(() => rm(root, { recursive: true, force: true }));
  const submittedBodies = [];
  const p = createProviders({
    mediaRoot: root,
    getSettings: () => ({ xiongmaoMinimaxH3Key: 'private-xiongmao-key', videoModel: 'xiongmao-seedance-2-0-official-fast' }),
    requestMultipartJson: async (_url, options) => ({ url: `https://cdn.example/reference-${options.file.filename}` }),
    requestJson: async (url, options) => {
      if (url.endsWith('/v1/videos/generations')) {
        submittedBodies.push(options.body);
        return { task_id: 'seedance-task-1', status: 'pending' };
      }
      return { task_id: 'seedance-task-1', status: 'completed', is_final: true, output_url: 'https://cdn.example/seedance.mp4' };
    },
  });
  const project = { id: 'p1', style: '电影', aspectRatio: '16:9', characters: [] };
  const png = await sharp({ create: { width: 256, height: 512, channels: 3, background: 'blue' } }).png().toBuffer();
  const image = await p.importImage(project, `data:image/png;base64,${png.toString('base64')}`);
  const shot = { image, approved: true, duration: 6, trimStart: 0, action: '回头', scene: '雨巷', camera: '推进', characterIds: [] };
  const submitted = await p.submitVideo(project, shot, 'business_seedance', 'xiongmao-seedance-2-0-official-fast', '720p');
  assert.equal(submitted.id, 'seedance-task-1');
  assert.equal(submittedBodies[0].model, 'seedance-2-0-official');
  assert.equal(submittedBodies[0].quality, 'fast');
  assert.equal(submittedBodies[0].resolution, '720p');
  assert.equal(submittedBodies[0].duration, 6);
  assert.equal(submittedBodies[0].mode, 'first-frame');
  assert.equal(submittedBodies[0].client_request_id, 'business_seedance');
  assert.equal(JSON.stringify(submittedBodies[0]).includes('private-xiongmao-key'), false);
  assert.equal((await p.pollVideo('seedance-task-1', 'xiongmao-seedance-2-0-official-fast')).status, 'completed');
  for (const [model, quality] of [
    ['xiongmao-seedance-2-0-official', '标准'],
    ['xiongmao-seedance-2-0-official-mini', 'mini'],
    ['xiongmao-seedance-2-0-promo', '标准'],
    ['xiongmao-seedance-2-0-promo-fast', 'fast'],
    ['xiongmao-seedance-2-0-promo-mini', 'mini'],
    ['xiongmao-seedance-2-0-special', '高清'],
  ]) {
    await p.submitVideo(project, shot, `business_${model}`, model, '480p');
  }
  assert.deepEqual(submittedBodies.slice(1).map(body => [body.model, body.quality]), [
    ['seedance-2-0-official', '标准'],
    ['seedance-2-0-official', 'mini'],
    ['seedance-2-0-promo', '标准'],
    ['seedance-2-0-promo', 'fast'],
    ['seedance-2-0-promo', 'mini'],
    ['seedance-2-0-special', '高清'],
  ]);
  assert.equal(submittedBodies.at(-1).mode, 'reference');
});

test('Xiongmao Seedance rejects unsupported quality resolutions before submission', async () => {
  const p = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ xiongmaoMinimaxH3Key: 'private-xiongmao-key', videoModel: 'xiongmao-seedance-2-0-official-fast' }), requestJson: async () => { throw new Error('must not submit'); } });
  const project = { id: 'p1', style: '电影', aspectRatio: '16:9', characters: [] };
  const shot = { image: 'missing', approved: true, duration: 6, trimStart: 0, action: '回头', scene: '雨巷', camera: '推进', characterIds: [] };
  await assert.rejects(p.submitVideo(project, shot, 'business_seedance', 'xiongmao-seedance-2-0-official-fast', '4k'), error => error.code === 'VIDEO_RESOLUTION_UNSUPPORTED');
});

test('Ark Seedance uses the official contents task contract and video_url polling', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-ark-seedance-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];
  const p=createProviders({mediaRoot:root,getSettings:()=>({arkKey:'private-ark-key',videoModel:'doubao-seedance-2-5'}),requestJson:async(url,options)=>{
    calls.push({url,...options});
    return calls.length===1 ? {id:'cgt_ark_1',status:'queued'} : {id:'cgt_ark_1',status:'succeeded',video_url:'https://video.example/ark.mp4'};
  }});
  const project={id:'p1',style:'电影',aspectRatio:'9:16',characters:[]};
  const png=await sharp({create:{width:256,height:512,channels:3,background:'blue'}}).png().toBuffer();
  const image=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const characterReference=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  project.characters=[{id:'lin',name:'林晚',appearance:'黑色短发、米色风衣',reference:characterReference,approved:true}];
  const shot={image,approved:true,duration:20,trimStart:0,action:'回头',scene:'雨巷',camera:'推进',characterIds:['lin']};
  const submitted=await p.submitVideo(project,shot,'business_ark');
  assert.equal(submitted.id,'cgt_ark_1');
  assert.equal(calls[0].url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
  assert.equal(calls[0].body.model,'doubao-seedance-2-5');
  assert.equal(calls[0].body.duration,20);
  assert.equal(calls[0].body.ratio,'adaptive');
  assert.equal(calls[0].body.content[1].type,'image_url');
  assert.equal(calls[0].body.content[1].role,'first_frame');
  assert.equal(calls[0].body.content[2].role,'reference_image');
  assert.equal(calls[0].body.content.length,3);
  assert.equal(calls[0].body.content[0].text.endsWith('与参考素材完全一致'),true);
  assert.ok(calls[0].body.content[1].image_url.url.startsWith('data:image/png;base64,'));
  assert.equal(JSON.stringify(calls[0].body).includes('private-ark-key'),false);
  const polled=await p.pollVideo('cgt_ark_1');
  assert.equal(polled.status,'completed');
  assert.equal(polled.url,'https://video.example/ark.mp4');
  assert.equal(calls[1].url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt_ark_1');
  assert.equal(calls[1].headers.Authorization,'Bearer private-ark-key');
});

test('explicit ten-episode scripts keep one or more segments per episode instead of collapsing to two', async () => {
  const requests = [];
  const episodeText = Array.from({ length: 10 }, (_, index) => `第${index + 1}集：转折${index + 1}\n${'这一集的事件和证据。'.repeat(420)}`).join('\n');
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    requests.push(options.body);
    const input = JSON.parse(options.body.messages[1].content);
    const numbers = input.expectedEpisodeNumbers?.length ? input.expectedEpisodeNumbers : [1];
    const response = { characters: [], scenes: [{ id: 'episode-scene', name: '故事场景', description: '原文场景' }], looks: [], segments: numbers.flatMap(number => Array.from({ length: 2 }, (_, index) => ({ episodeNumber: number, episodeTitle: `转折${number}`, title: `第${number}集片段${index + 1}`, summary: `第${number}集剧情`, duration: 30, shots: nineShots({ sceneId: 'episode-scene', scene: '故事场景' }) }))) };
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] };
  } });
  const result = await provider.analyze({ novel: episodeText, duration: 30, style: '电影', aspectRatio: '9:16' });
  const episodeNumbers = new Set(result.segments.map(segment => segment.episodeNumber));
  assert.ok(requests.length > 2);
  assert.deepEqual([...episodeNumbers].sort((a, b) => a - b), Array.from({ length: 10 }, (_, index) => index + 1));
  assert.ok(result.segments.length >= 10);
});

test('markdown episode headings are detected alongside directory entries', () => {
  const novel = [
    '# 十集脚本',
    '**第1集《开端》：**目录摘要',
    '# 第1集 开端',
    '正文',
    '**第2集《转折》：**目录摘要',
    '## 第2集 转折',
    '正文',
    '第3集《收束》：目录摘要',
    '# 第3集 收束',
  ].join('\n');
  const plan = extractEpisodePlan(novel);
  assert.deepEqual(plan.map(item => item.number), [1, 2, 3]);
  assert.deepEqual(plan.map(item => item.title), ['开端', '转折', '收束']);
});

test('directory-only preface is context for the first episode instead of a storyboard chunk', async () => {
  const requests = [];
  const novel = [
    '目录', '**第1集《开端》：目录摘要**', '**第2集《转折》：目录摘要**', '**第3集《收束》：目录摘要**',
    '# 第1集 开端', '第一集正文', '# 第2集 转折', '第二集正文', '# 第3集 收束', '第三集正文',
  ].join('\n');
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    const input = JSON.parse(options.body.messages[1].content);
    requests.push(input);
    const number = input.expectedEpisodeNumbers?.[0];
    const segment = { title: number ? `第${number}集` : '前言', summary: '正文', duration: 30, shots: nineShots() };
    if (number) segment.episodeNumber = number;
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ characters: [], scenes: [{ id: 's1', name: '场景', description: '' }], looks: [], segments: [segment] }) } }] };
  } });
  await provider.analyze({ novel, duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.deepEqual(requests[0].expectedEpisodeNumbers, [1]);
  assert.match(requests[0].sourcePreamble, /目录/);
  assert.deepEqual(requests.map(input => input.expectedEpisodeNumbers), [[1], [2], [3]]);
});

test('structured script prefaces are context for the first episode, not storyboard chunks', async () => {
  const requests = [];
  let totalChunks;
  const novel = [
    '# 第一季55集完整剧本',
    '## 第一季定位',
    `主线与人物关系说明：${'主角从宗门离开后经营灵膳馆，逐步揭开供料垄断并与伙伴合作。'.repeat(45)}`,
    '## 人物、修行与能力规则',
    `江游是年轻厨子，阿桃是自主选择跟随的护山神兽。${'角色设定和世界规则只供后续剧情保持一致。'.repeat(12)}`,
    '## 第一季阶段路线',
    '前十集摆脱冤屈并开馆，中段建立团队与商路，结尾救下灵兽并开启新目标。',
    '## 五十五集目录',
    '**第1集《开张》：**目录摘要',
    '# 第1集 开张',
    '## 场1 兽院 日 外',
    '江游端起砂锅，阿桃主动跑到他身边。',
  ].join('\n');
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      const input = JSON.parse(options.body.messages[1].content);
      requests.push(input);
      const number = input.expectedEpisodeNumbers?.[0];
      const segment = { title: '开张', summary: '江游与阿桃同行', duration: 30, shots: nineShots() };
      if (number) segment.episodeNumber = number;
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        characters: [], scenes: [{ id: 's1', name: '兽院', description: '' }], looks: [], segments: [segment],
      }) } }] };
    },
  });

  await provider.analyze({
    novel,
    duration: 30,
    style: '电影',
    aspectRatio: '9:16',
  }, undefined, { onProgress: progress => { totalChunks = progress.totalChunks; } });

  assert.equal(totalChunks, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].expectedEpisodeNumbers, [1]);
  assert.match(requests[0].sourcePreamble, /人物、修行与能力规则/);
  assert.match(requests[0].novelChunk, /^# 第1集 开张/);
});

test('episode hints do not discard source content outside numbered episodes', async () => {
  let requestInput;
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      requestInput = JSON.parse(options.body.messages[1].content);
      const shots = nineShots({ sceneId: 'source-scene', scene: '原文场景' });
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        characters: [],
        scenes: [{ id: 'source-scene', name: '原文场景', description: '完整原文' }],
        looks: [],
        segments: [
          ...Array.from({ length: 4 }, (_, index) => ({ episodeNumber: 1, episodeTitle: '第一集', title: `第一集正文${index + 1}`, summary: '编号剧集内容', duration: 30, shots })),
          { title: '前言与附录', summary: '不属于编号剧集的原文内容', duration: 30, shots },
        ],
      }) } }] };
    },
  });
  const result = await provider.analyze({
    novel: '# 第1集 第一集\n剧集正文\n\n# 创作说明\n这是额外内容。',
    duration: 30,
    style: '电影',
    aspectRatio: '9:16',
  });
  assert.equal(result.segments.length, 5);
  assert.equal(result.segments[4].episodeNumber, undefined);
  assert.ok(requestInput.maxSegments >= 2);
  assert.match(requestInput.episodeAnalysisRule, /完整分析/);
  assert.match(requestInput.novelChunk, /这是额外内容/);
});

test('episode analysis keeps explicit episode boundaries in separate chunks', async () => {
  const requests = [];
  const novel = `第1集：开端\n${'甲'.repeat(3400)}\n第2集：转折\n${'乙'.repeat(1000)}`;
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    const input = JSON.parse(options.body.messages[1].content);
    requests.push(input);
    const numbers = input.expectedEpisodeNumbers?.length ? input.expectedEpisodeNumbers : [1];
    const segments = numbers.flatMap(number => Array.from({ length: 4 }, (_, index) => ({
      episodeNumber: number,
      episodeTitle: number === 1 ? '开端' : '转折',
      title: `第${number}集片段${index + 1}`,
      summary: `第${number}集剧情`,
      duration: 30,
      shots: Array.from({ length: 3 }, (_, index) => ({ sceneId: 'episode-scene', scene: '故事场景', action: `动作${index + 1}`, camera: '中景', dialogue: '', characterIds: [], duration: 10 }))
    })));
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ characters: [], scenes: [{ id: 'episode-scene', name: '故事场景', description: '原文场景' }], looks: [], segments }) } }] };
  } });
  await provider.analyze({ novel, duration: 30, style: '电影', aspectRatio: '9:16', generationMode: 'segment-board' });
  assert.ok(requests.every(input => input.expectedEpisodeNumbers?.join(',') !== '1,2'));
});

test('episode continuation chunks keep the latest active episode number', async () => {
  const requests = [];
  const novel = `第1集：开端\n${'甲'.repeat(3400)}\n第2集：转折\n${'乙'.repeat(3400)}`;
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    const input = JSON.parse(options.body.messages[1].content);
    requests.push(input);
    const numbers = input.expectedEpisodeNumbers?.length ? input.expectedEpisodeNumbers : [1];
    const segments = numbers.flatMap(number => Array.from({ length: 4 }, (_, index) => ({ episodeNumber: number, episodeTitle: number === 1 ? '开端' : '转折', title: `第${number}集片段${index + 1}`, summary: '剧情', duration: 30, shots: nineShots({ sceneId: 'episode-scene', scene: '故事场景' }) })));
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ characters: [], scenes: [{ id: 'episode-scene', name: '故事场景', description: '原文场景' }], looks: [], segments }) } }] };
  } });
  await provider.analyze({ novel, duration: 30, style: '电影', aspectRatio: '9:16', generationMode: 'segment-board' });
  assert.ok(requests.some(input => input.chunk > 2 && input.expectedEpisodeNumbers?.join(',') === '2'));
  assert.ok(requests.every(input => !(input.chunk > 2 && input.expectedEpisodeNumbers?.includes(1))));
});

test('analysis resumes an uncertain correction without resubmitting the analyzed chunk', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-correction-resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, 'media');
  const project = { id: 'correction-resume', novel: '原文内容', duration: 30, style: '电影', aspectRatio: '9:16' };
  const complete = { characters: [], scenes: [{ id: 's1', name: '空场', description: '' }], looks: [], segments: [{ title: '一段', summary: '空场', duration: 30, shots: nineShots() }] };
  let firstCalls = 0;
  const initial = createProviders({ mediaRoot, getSettings: () => ({ llmKey: 'key' }), requestJson: async () => {
    firstCalls += 1;
    if (firstCalls === 1) {
      const invalid = structuredClone(complete);
      invalid.segments[0].shots[0].camera = '';
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(invalid) } }] };
    }
    const error = new Error('network timeout'); error.code = 'NETWORK_TIMEOUT'; error.safe = true; throw error;
  } });
  await assert.rejects(initial.analyze(project, 'first-attempt'), error => error.code === 'NETWORK_TIMEOUT');
  assert.equal(firstCalls, 2);

  const resumedBodies = [];
  const resumed = createProviders({ mediaRoot, getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    resumedBodies.push(options.body);
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(complete) } }] };
  } });
  const result = await resumed.analyze(project, 'retry-attempt', { retryUncertain: true });
  assert.equal(resumedBodies.length, 1);
  assert.match(resumedBodies[0].messages[0].content, /只输出JSON对象/);
  assert.equal(result.segments.length, 1);
});

test('retired video model settings cannot submit or poll through a provider', async () => {
  let calls = 0;
  const p = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ minimaxKey: 'private-minimax-key', videoModel: 'seedance-2' }),
    requestJson: async () => { calls += 1; return { id: 'should-not-run' }; },
  });
  await assert.rejects(p.pollVideo('retired-task'), error => error.code === 'MODEL_UNSUPPORTED');
  await assert.rejects(p.submitVideo({ aspectRatio: '9:16' }, { approved: true, image: 'missing', duration: 4, trimStart: 0, action: '走', scene: '街道', camera: '中景' }, 'retired-business'), error => error.code === 'MODEL_UNSUPPORTED');
  assert.equal(calls, 0);
});

test('Ark Seedance 2.0 enforces the documented 4-15 second range', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-ark-seedance-2-0-')); t.after(()=>rm(root,{recursive:true,force:true}));
  let calls=0;
  const p=createProviders({mediaRoot:root,getSettings:()=>({arkKey:'key',videoModel:'doubao-seedance-2-0-pro'}),requestJson:async()=>{calls++;return {id:'ark_2',status:'queued'};}});
  const project={id:'p1',style:'电影',aspectRatio:'9:16'};
  const png=await sharp({create:{width:256,height:512,channels:3,background:'black'}}).png().toBuffer();
  const image=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(p.submitVideo(project,{image,approved:true,duration:16,trimStart:0,action:'走',scene:'街',camera:'中景'},'ark_too_long'),/15/);
  assert.equal(calls,0);
});

test('Ark Seedance 1.0 uses its documented image-video bounds', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-ark-seedance-1-0-')); t.after(()=>rm(root,{recursive:true,force:true}));
  let payload;
  const p=createProviders({mediaRoot:root,getSettings:()=>({arkKey:'key',videoModel:'doubao-seedance-1-0-pro-250528'}),requestJson:async(_url,options)=>{payload=options.body;return {id:'ark_1',status:'queued'};}});
  const project={id:'p1',style:'电影',aspectRatio:'9:16'};
  const png=await sharp({create:{width:256,height:455,channels:3,background:'blue'}}).png().toBuffer();
  const image=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  await p.submitVideo(project,{image,approved:true,duration:0.5,trimStart:0,action:'走',scene:'街',camera:'中景'},'ark_1');
  assert.equal(payload.resolution,'1080p');
  assert.equal(payload.ratio,'9:16');
  assert.equal(payload.duration,2);
  assert.equal(Object.hasOwn(payload,'generate_audio'),false);
  await assert.rejects(p.submitVideo(project,{image,approved:true,duration:13,trimStart:0,action:'走',scene:'街',camera:'中景'},'ark_1_long'),/12/);
});

test('Ark video tasks use only the Ark credential namespace', async () => {
  let calls=0;
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({minimaxKey:'minimax-only',videoModel:'doubao-seedance-2-5'}),requestJson:async()=>{calls++;return {id:'should-not-run'};}});
  await assert.rejects(p.pollVideo('ark_task'),error=>error.code==='NOT_CONFIGURED'&&error.message.includes('火山方舟'));
  assert.equal(calls,0);
});

test('MiniMax H3-Max uses reference-only multimodal content when character references are present', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-minimax-max-')); t.after(()=>rm(root,{recursive:true,force:true}));
  let payload;
  const p=createProviders({mediaRoot:root,getSettings:()=>({minimaxKey:'private-minimax-key',videoModel:'MiniMax-H3-Max'}),requestJson:async(_url,options)=>{payload=options.body;return {task_id:'max_1'};}});
  const project={id:'p1',style:'电影',aspectRatio:'9:16',characters:[]};
  const png=await sharp({create:{width:256,height:512,channels:3,background:'green'}}).png().toBuffer();
  const image=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const characterReference=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  project.characters=[{id:'lin',name:'林晚',appearance:'黑色短发、米色风衣',reference:characterReference,approved:true}];
  await p.submitVideo(project,{image,approved:true,duration:1,trimStart:0,action:'走',scene:'街道',camera:'跟拍',characterIds:['lin']},'business_2');
  assert.equal(payload.model,'MiniMax-H3-Max');
  assert.equal(payload.resolution,'768P');
  assert.equal(payload.duration,5);
  assert.deepEqual(payload.extra,{prompt_expansion_mode:'disabled'});
  assert.equal(payload.ratio,'adaptive');
  assert.equal(payload.content[1].role,'reference_image');
  assert.equal(payload.content[2].role,'reference_image');
  assert.equal(payload.content.length,3);
});

test('MiniMax failed and cancelled tasks do not expose provider error text or URLs', async () => {
  const responses=[
    {task:{id:'failed_1',status:'failed',error:{code:'1026',message:'signed https://private.example/result.mp4'}}},
    {task:{id:'cancelled_1',status:'cancelled'}}
  ];
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({minimaxKey:'private-minimax-key',videoModel:'MiniMax-H3'}),requestJson:async()=>responses.shift()});
  const failed=await p.pollVideo('failed_1');
  assert.equal(failed.status,'failed');
  assert.equal(failed.url,undefined);
  assert.equal(failed.error.includes('private.example'),false);
  const cancelled=await p.pollVideo('cancelled_1');
  assert.equal(cancelled.status,'failed');
  assert.equal(cancelled.url,undefined);
});

test('MiniMax H3 submits the approved still as a first frame using the official content contract', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-minimax-h3-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];
  const p=createProviders({mediaRoot:root,getSettings:()=>({minimaxKey:'key',videoModel:'minimax-h3'}),requestJson:async(url,options)=>{calls.push({url,...options});return {task_id:'mm_task_1',status:'queued'};}});
  const project={id:'p1',style:'电影',aspectRatio:'9:16'};
  const png=await sharp({create:{width:256,height:455,channels:3,background:'blue'}}).png().toBuffer();
  const image=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const shot={image,approved:true,duration:2.3,trimStart:0,action:'回头',scene:'街道',camera:'近景'};
  const result=await p.submitVideo(project,shot,'business_1');
  assert.equal(result.id,'mm_task_1');
  assert.equal(calls[0].url,'https://api.minimax.cn/v2/video_generation');
  assert.equal(calls[0].body.model,'MiniMax-H3');
  assert.equal(calls[0].body.resolution,'2K');
  assert.equal(calls[0].body.duration,4);
  assert.equal(calls[0].body.ratio,'adaptive');
  assert.equal(calls[0].body.content[0].type,'text');
  assert.ok(calls[0].body.content[0].text.includes('唯一的视觉事实'));
  assert.equal(calls[0].body.content[1].role,'first_frame');
  assert.equal(calls[0].body.content[1].image_url.url.startsWith('data:image/png;base64,'),true);
  assert.equal(JSON.stringify(calls[0].body).includes('key'),false);
});

test('MiniMax H3-Max uses 768P and enforces its five second minimum', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-minimax-max-')); t.after(()=>rm(root,{recursive:true,force:true}));
  let payload;
  const p=createProviders({mediaRoot:root,getSettings:()=>({minimaxKey:'key',videoModel:'minimax-h3-max'}),requestJson:async(_url,options)=>{payload=options.body;return {task_id:'mm_task_max',status:'queued'};}});
  const project={id:'p1',style:'电影',aspectRatio:'9:16'};
  const png=await sharp({create:{width:256,height:455,channels:3,background:'green'}}).png().toBuffer();
  const image=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  await p.submitVideo(project,{image,approved:true,duration:1,trimStart:0,action:'走',scene:'街',camera:'跟拍'},'business_max');
  assert.equal(payload.model,'MiniMax-H3-Max');
  assert.equal(payload.resolution,'768P');
  assert.equal(payload.duration,5);
  assert.equal(payload.ratio,'adaptive');
  assert.equal(payload.content[1].role,'first_frame');
  assert.equal(payload.content.length,2);
});

test('MiniMax query maps official states and consumes the short lived content URL', async () => {
  const fixtures=[
    {task_id:'mm',status:'running'},
    {task_id:'mm',status:'succeeded',content:{url:'https://signed.example/video.mp4'}},
    {task_id:'mm',status:'failed',error:{code:1026,message:'private-secret'}}
  ];
  const urls=[];const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({minimaxKey:'key',videoModel:'minimax-h3'}),requestJson:async(url)=>{urls.push(url);return fixtures.shift();}});
  assert.equal((await p.pollVideo('mm')).status,'running');
  const completed=await p.pollVideo('mm');assert.equal(completed.status,'completed');assert.equal(completed.url,'https://signed.example/video.mp4');
  const failed=await p.pollVideo('mm');assert.equal(failed.status,'failed');assert.equal(failed.error.includes('private-secret'),false);
  assert.ok(urls.every(url=>url==='https://api.minimax.cn/v2/query/video_generation/mm'));
});

test('MiniMax is gated by its own key and never falls back to Ark credentials', async () => {
  let calls=0;const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({arkKey:'ark-only',videoModel:'minimax-h3'}),requestJson:async()=>{calls++;return {task_id:'should-not-run'};}});
  await assert.rejects(p.pollVideo('mm'),error=>error.code==='NOT_CONFIGURED'&&error.message.includes('MiniMax'));
  assert.equal(calls,0);
});

test('unknown video outcomes are not retried and errors never echo upstream secrets', async () => {
  let count=0;
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({minimaxKey:'secret',videoModel:'MiniMax-H3'}),requestJson:async()=>{count++; throw Error('Bearer secret https://private?key=secret');}});
  await assert.rejects(p.pollVideo('business_1'),e=>!e.message.includes('secret'));
  assert.equal(count,1);
});

test('Grsai shot generation keeps character facts in text without uploading character images', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-grsai-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];let downloadCalls=0;
  const imageBytes=await sharp({create:{width:256,height:256,channels:3,background:'orange'}}).png().toBuffer();
  const p=createProviders({mediaRoot:path.join(root,'media'),getSettings:()=>({grsaiKey:'private-key',imageModel:'nano-banana-pro'}),requestJson:async(url,options)=>{calls.push({url,...options});return {id:'img_1',status:'succeeded',results:[{url:'https://public.example/image.png'}]};},download:async()=>{downloadCalls++;return imageBytes;}});
  const project={id:'p',style:'电影',aspectRatio:'9:16',characters:[]};
  const reference=await p.importImage(project,`data:image/png;base64,${imageBytes.toString('base64')}`);
  project.characters=[{id:'b',name:'乙',appearance:'白衣',approved:true,reference},{id:'a',name:'甲',appearance:'黑衣',approved:true,reference}];
  const shot={characterIds:['a','b'],scene:'雨夜',action:'相望',camera:'中景'};
  const result=await p.generateShot(project,shot,'business_image');
  assert.ok(result.startsWith('/media/p/'));assert.equal(calls.length,1);assert.equal(downloadCalls,1);
  const body=calls[0].body;
  assert.equal(calls[0].url,'https://grsai.dakka.com.cn/v1/api/generate');
  assert.equal(body.model,'nano-banana-pro');assert.equal(body.imageSize,'1K');assert.equal(body.replyType,'json');
  assert.equal(body.images.length,0);assert.match(body.prompt,/甲/);assert.match(body.prompt,/乙/);assert.match(body.prompt,/黑衣|白衣/);
  assert.match(body.prompt,/audio.*metadata|声音.*元数据/i);
  assert.match(body.prompt,/subtitle|字幕/i);
  assert.match(body.prompt,/speech bubble|对白框|气泡/i);
  assert.equal(JSON.stringify(body).includes('private-key'),false);
  assert.equal(await p.recoverImage(project,'business_image'),result);assert.equal(calls.length,1);assert.equal(downloadCalls,1);
  await assert.rejects(p.generateShot({...project,characters:project.characters.map(c=>({...c,approved:false}))},shot,'blocked'),e=>e.code==='CHARACTER_NOT_APPROVED'&&e.definitive);
  assert.equal(calls.length,1);
});

test('async Grsai image generation persists the provider task and polls the documented result endpoint', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-grsai-async-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];let submitted;
  const imageBytes=await sharp({create:{width:256,height:256,channels:3,background:'orange'}}).png().toBuffer();
  const p=createProviders({
    mediaRoot:path.join(root,'media'),
    imagePollIntervalMs:1,
    imagePollTimeoutMs:100,
    getSettings:()=>({grsaiKey:'private-key',imageModel:'gpt-image-2.5'}),
    requestJson:async(url,options)=>{
      calls.push({url,...options});
      if(options?.method==='POST')return {id:'grsai-image-1',status:'running',progress:8};
      return {id:'grsai-image-1',status:'succeeded',progress:100,results:[{url:'https://public.example/image.png'}]};
    },
    download:async()=>imageBytes,
  });
  const result=await p.generateCharacter({id:'p',style:'电影',aspectRatio:'9:16'},{name:'林遥',appearance:'黑发'},'async-business',{
    async:true,
    onSubmitted:async value=>{submitted=value;},
  });
  assert.ok(result.startsWith('/media/p/'));
  assert.deepEqual(submitted,{id:'grsai-image-1',status:'running',progress:8});
  assert.equal(calls[0].url,'https://grsai.dakka.com.cn/v1/api/generate');
  assert.equal(calls[0].body.replyType,'async');
  assert.equal(calls[1].url,'https://grsai.dakka.com.cn/v1/api/result?id=grsai-image-1');
  assert.equal(calls[1].method,'GET');
});

test('character identity prompts keep animal subjects non-human instead of forcing a human body', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-grsai-subject-shape-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];
  const imageBytes=await sharp({create:{width:256,height:256,channels:3,background:'white'}}).png().toBuffer();
  const p=createProviders({
    mediaRoot:path.join(root,'media'),
    getSettings:()=>({grsaiKey:'private-key',imageModel:'gpt-image-2.5'}),
    requestJson:async(url,options)=>{calls.push({url,...options});return {id:'animal-image',status:'succeeded',results:[{url:'https://public.example/animal.png'}]};},
    download:async()=>imageBytes,
  });
  const project={id:'animal-project',style:'电影质感',aspectRatio:'9:16'};
  await p.generateCharacter(project,{name:'阿桃',appearance:'猫大的白毛小兽，小金角，灰蓝长尾，四足行走。',evidence:'它用前爪拨开门缝。'},'animal-business');
  const prompt=calls[0].body.prompt;
  assert.match(prompt,/Selected subject form: non-human creature/);
  assert.match(prompt,/keep its natural head and anatomy/);
  assert.match(prompt,/never turn it into a human or humanoid body/);
  assert.doesNotMatch(prompt,/Selected subject form: human\./);
});

test('character identity prompts convert occupation notes and keep a beast-related chef human', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-grsai-human-role-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const calls=[];
  const imageBytes=await sharp({create:{width:256,height:256,channels:3,background:'white'}}).png().toBuffer();
  const p=createProviders({
    mediaRoot:path.join(root,'media'),
    getSettings:()=>({grsaiKey:'private-key',imageModel:'gpt-image-2.5'}),
    requestJson:async(url,options)=>{calls.push({url,...options});return {id:'human-role-image',status:'succeeded',results:[{url:'https://public.example/human-role.png'}]};},
    download:async()=>imageBytes,
  });
  const project={id:'human-role-project',title:'修仙后厨',novel:'灵兽宗门的后厨',style:'电影质感',aspectRatio:'9:16'};
  await p.generateCharacter(project,{name:'御兽总厨',appearance:'精通灵兽膳食，负责宗门灵膳。',evidence:'他在后厨为灵兽准备灵膳。'},'human-role-business');
  const prompt=calls[0].body.prompt;
  assert.match(prompt,/Selected subject form: human/);
  assert.match(prompt,/occupation.*not animal anatomy/i);
  assert.match(prompt,/Source evidence for internal interpretation only/);
  assert.match(prompt,/never copy the source sentence/i);
  assert.doesNotMatch(prompt,/Selected subject form: non-human creature/);
});

test('image prompts honor the selected 2D, 3D or photorealistic medium', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-visual-style-')); t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 256, height: 256, channels: 3, background: 'white' } }).png().toBuffer();
  for (const item of [
    { visualStyle: '2d-animation', include: /2D 动画|二维动画/, exclude: /采用真人电影与写实摄影媒介/ },
    { visualStyle: '3d-animation', include: /3D 动画|三维动画/, exclude: /采用真人电影与写实摄影媒介/ },
    { visualStyle: 'photorealistic', include: /仿真人 \/ 写实电影|真人电影与写实摄影/, exclude: /二维动画\/插画媒介/ },
  ]) {
    const calls = [];
    const provider = createProviders({
      mediaRoot: path.join(root, item.visualStyle),
      getSettings: () => ({ grsaiKey: 'fixture-key', imageModel: 'gpt-image-2.5' }),
      requestJson: async (_url, options) => { calls.push(options.body); return { id: `style-${item.visualStyle}`, status: 'succeeded', results: [{ url: 'https://public.example/style.png' }] }; },
      download: async () => imageBytes,
    });
    await provider.generateCharacter({ id: item.visualStyle, title: '测试', style: '冷色电影感', visualStyle: item.visualStyle, aspectRatio: '9:16' }, { name: '角色', appearance: '黑发' }, `style-${item.visualStyle}`);
    assert.match(calls[0].prompt, item.include);
    assert.doesNotMatch(calls[0].prompt, item.exclude);
    assert.match(calls[0].prompt, /用户补充风格：冷色电影感/);
  }
});

test('successful image receipt recovers failed download without another billable POST', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-recover-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let requests=0;let downloads=0;
  const png=await sharp({create:{width:256,height:256,channels:3,background:'green'}}).png().toBuffer();
  const p=createProviders({mediaRoot:path.join(root,'media'),getSettings:()=>({grsaiKey:'key'}),requestJson:async()=>{requests++;return {id:'img_1',status:'succeeded',results:[{url:'https://public.example/image.png'}]};},download:async()=>{downloads++;if(downloads===1)throw Error('download failed');return png;}});
  const project={id:'p',style:'电影',aspectRatio:'9:16'};
  await assert.rejects(p.generateCharacter(project,{name:'角色',appearance:'黑发'},'same_business'),e=>e.code==='RESULT_DOWNLOAD_FAILED'&&!e.definitive);
  const recovered=await p.recoverImage(project,'same_business');assert.ok(recovered.startsWith('/media/p/'));assert.equal(requests,1);assert.equal(downloads,2);
});

test('SF image configuration keeps the GPT 2.5 default, Sunburst ID, VIP pixels and Nano size while preserving reference images',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-image-models-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=await sharp({create:{width:256,height:256,channels:3,background:'purple'}}).png().toBuffer();
  const cases=[
    {model:undefined,expectedModel:'gpt-image-2.5',aspect:'9:16',expectedAspect:'16:9',code:0},
    {model:'gpt-image-2.5-sunburst',expectedModel:'gpt-image-2.5-sunburst',aspect:'16:9',expectedAspect:'16:9',code:'200'},
    {model:'gpt-image-2-vip',expectedModel:'gpt-image-2-vip',aspect:'9:16',expectedAspect:'1280x720',code:200},
    {model:'gpt-image-2-vip',expectedModel:'gpt-image-2-vip',aspect:'16:9',expectedAspect:'1280x720',code:'0'},
    {model:'nano-banana-pro',expectedModel:'nano-banana-pro',aspect:'9:16',expectedAspect:'16:9',imageSize:'1K',code:0},
  ];
  for(const [index,item] of cases.entries()){
    let payload;let calls=0;
    const providers=createProviders({mediaRoot:path.join(root,'media'),getSettings:()=>({grsaiKey:'fixture-key',...(item.model?{imageModel:item.model}:{})}),requestJson:async(url,options)=>{
      calls++;assert.equal(url,'https://grsai.dakka.com.cn/v1/api/generate');payload=options.body;
      return {code:item.code,data:{id:`image-${index}`,status:'succeeded',results:[{url:'https://public.example/result.png'}]}};
    },download:async()=>bytes});
    const project={id:`model-${index}`,style:'电影',aspectRatio:item.aspect};
    const reference=await providers.importImage(project,`data:image/png;base64,${bytes.toString('base64')}`);
    const result=await providers.generateCharacter(project,{name:'林遥',appearance:'蓝衣黑发',reference},`model-job-${index}`);
    assert.ok(result.startsWith(`/media/${project.id}/`));assert.equal(calls,1);
    assert.equal(payload.model,item.expectedModel);assert.equal(payload.aspectRatio,item.expectedAspect);assert.equal(payload.replyType,'json');
    assert.equal(payload.imageSize,item.imageSize);assert.equal(payload.images.length,1);assert.ok(payload.images[0].startsWith('data:image/png;base64,'));
    assert.match(payload.prompt,/Image 1 is the reference source of truth/);
    assert.equal(JSON.stringify(payload).includes('fixture-key'),false);
  }
});

test('explicit Grsai wrapper rejection never downloads a misleading nested success or leaks provider text',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-image-rejected-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let calls=0;let downloads=0;
  const p=createProviders({mediaRoot:path.join(root,'media'),getSettings:()=>({grsaiKey:'fixture-key'}),requestJson:async()=>{calls++;return {code:400,msg:'Bearer private-secret',data:{id:'image-x',status:'succeeded',results:[{url:'https://public.example/result.png'}]}};},download:async()=>{downloads++;throw Error('must not download');}});
  await assert.rejects(p.generateCharacter({id:'p',style:'电影',aspectRatio:'9:16'},{name:'林遥',appearance:'黑发'},'rejected-job'),error=>error.code==='PROVIDER_REJECTED'&&error.definitive===true&&!error.message.includes('private-secret'));
  assert.equal(calls,1);assert.equal(downloads,0);
});

test('Grsai data result URL completes without an invented success status while explicit nested failures take precedence',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-image-response-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=await sharp({create:{width:256,height:256,channels:3,background:'blue'}}).png().toBuffer();
  const responses=[{data:{results:[{url:'https://public.example/result.png'}]}},{code:0,data:{id:'failed-image',status:'failed',results:[{url:'https://public.example/result.png'}]}}];
  let calls=0;let downloads=0;
  const providers=createProviders({mediaRoot:path.join(root,'media'),getSettings:()=>({grsaiKey:'fixture-key'}),requestJson:async()=>{calls++;return responses.shift();},download:async()=>{downloads++;return bytes;}});
  const project={id:'p',style:'电影',aspectRatio:'9:16'};
  const output=await providers.generateCharacter(project,{name:'人物',appearance:'黑发'},'result-only');
  assert.ok(output.startsWith('/media/p/'));
  await assert.rejects(providers.generateCharacter(project,{name:'人物',appearance:'黑发'},'failed-image'),e=>e.code==='PROVIDER_REJECTED'&&e.definitive);
  assert.equal(calls,2);assert.equal(downloads,1);
});

test('Grsai pending or unrecognized status does not become success merely because a URL is present',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-image-unknown-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let calls=0;let downloads=0;
  const p=createProviders({mediaRoot:path.join(root,'media'),getSettings:()=>({grsaiKey:'fixture-key'}),requestJson:async()=>({code:0,data:{id:`unknown-${++calls}`,status:calls===1?'running':'unexpected_state',results:[{url:'https://public.example/partial.png'}]}}),download:async()=>{downloads++;throw Error('must not download an incomplete image');}});
  const project={id:'p',style:'电影',aspectRatio:'9:16'};
  for(const businessId of ['pending-task','unrecognized-task']){
    await assert.rejects(p.generateCharacter(project,{name:'人物',appearance:'黑发'},businessId),error=>error.code==='SUBMISSION_UNKNOWN'&&!error.definitive);
    await assert.rejects(p.recoverImage(project,businessId),error=>error.code==='SUBMISSION_UNKNOWN'&&!error.definitive);
  }
  assert.equal(calls,2);assert.equal(downloads,0);
});

test('MiniMax video query recognizes explicit states and sanitizes failed results',async()=>{
  const fixtures=[{task_id:'task',status:'queued',progress:2},{task_id:'task',status:'running',progress:50},{task_id:'task',status:'failed',error:'key=private-secret'},{task_id:'task',status:'succeeded',content:{url:'https://example.com/output.mp4'}},{task_id:'task',status:'succeeded',content:{}},{task_id:'task',status:'surprise'}];
  const urls=[];const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({minimaxKey:'key',videoModel:'MiniMax-H3'}),requestJson:async url=>{urls.push(url);return fixtures.shift();}});
  assert.equal((await p.pollVideo('task')).status,'queued');assert.equal((await p.pollVideo('task')).status,'running');
  assert.equal((await p.pollVideo('task')).error.includes('secret'),false);assert.equal((await p.pollVideo('task')).url,'https://example.com/output.mp4');
  await assert.rejects(p.pollVideo('task'),/MP4/);await assert.rejects(p.pollVideo('task'),/无法确认/);
  assert.ok(urls.every(url=>url==='https://api.minimax.cn/v2/query/video_generation/task'));
});

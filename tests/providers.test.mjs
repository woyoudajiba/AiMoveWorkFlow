import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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
  assert.throws(()=>splitNovel('文'.repeat(300001)),/300000/);
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

test('analysis extracts markdown dialogue evidence and preserves every line', async () => {
  const requests = [];
  const response = {
    characters: [{ id: 'hero', name: '沈观辞', role: 'protagonist', aliases: [], appearance: '青年男性，黑发', evidence: '沈观辞站在山门前。' }],
    scenes: [{ id: 'gate', name: '宗门山门', description: '白日山门广场' }],
    looks: [{ id: 'gate-look', sceneId: 'gate', characterId: 'hero', name: '宗门弟子服', appearance: '统一青灰宗门制服' }],
    assets: [{ id: 'sect-uniform', name: '宗门制服', kind: 'costume', description: '青灰色统一制式长袍，所有宗门弟子保持同款同色', evidence: '弟子们穿着统一宗门制服。' }],
    segments: [{ title: '山门对峙', summary: '沈观辞与长老对话', episodeNumber: 1, duration: 15, shots: Array.from({ length: 3 }, (_, index) => ({
      sceneId: 'gate', scene: '宗门山门', action: index === 0 ? '弟子列队守在山门两侧' : '沈观辞抬眼回应', camera: index === 0 ? '大全景' : '中近景', dialogue: index === 1 ? '你终于来了。' : index === 2 ? '我本就该来。' : '', characterIds: ['hero'], assetIds: ['sect-uniform'], duration: 5,
    })) }],
  };
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    requests.push(JSON.parse(options.body.messages[1].content));
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] };
  } });
  const result = await provider.analyze({ novel: '# 第1集 山门\n**沈观辞：**你终于来了。\n**长老：**我本就该来。', duration: 15, durationMode: 'auto', generationMode: 'segment-board', style: '仙侠电影', aspectRatio: '9:16' });
  assert.deepEqual(requests[0].dialogueEvidence, [
    { speaker: '沈观辞', text: '你终于来了。' },
    { speaker: '长老', text: '我本就该来。' },
  ]);
  assert.deepEqual(result.segments[0].shots.map(shot => shot.dialogue).filter(Boolean), ['你终于来了。', '我本就该来。']);
});

test('script production annotations are not treated as missing dialogue', async () => {
  let calls = 0;
  const response = {
    characters: [{ id: 'hero', name: '沈砚', role: 'protagonist', aliases: [], appearance: '青年男性', evidence: '沈砚走上石阶。' }],
    scenes: [{ id: 'stage', name: '演武台', description: '日间石台' }],
    looks: [],
    segments: [{ title: '演武台对峙', summary: '沈砚与陆玄对峙', episodeNumber: 1, duration: 15, shots: [
      { sceneId: 'stage', scene: '演武台', action: '弟子列队', camera: '全景', dialogue: '少宗主筑基成功！', characterIds: ['hero'], duration: 5 },
      { sceneId: 'stage', scene: '演武台', action: '沈砚举起契纸', camera: '中景', dialogue: '借我的灵根，今天该还了。', characterIds: ['hero'], duration: 5 },
      { sceneId: 'stage', scene: '演武台', action: '沈砚收起账簿', camera: '近景', dialogue: '收。', characterIds: ['hero'], duration: 5 },
    ] }],
  };
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      calls++;
      const input = JSON.parse(options.body.messages[1].content);
      assert.deepEqual(input.dialogueEvidence, [
        { speaker: '报喜弟子', text: '少宗主筑基成功！' },
        { speaker: '沈砚', text: '借我的灵根，今天该还了。' },
        { speaker: '沈砚', text: '收。' },
      ]);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] };
    },
  });
  const result = await provider.analyze({
    novel: '# 第1集\n## 场1 演武台 日 外\n**人物：**沈砚、陆玄。\n**报喜弟子：**少宗主筑基成功！\n**短闪回：**十岁的沈杏躺在床上。\n**沈砚：**借我的灵根，今天该还了。\n**账簿特写：**借方陆玄。\n**沈砚：**收。\n**连续性：**左手持簿。\n**节拍：**0—35 秒。\n**本集爽点：**夺回灵根。\n**下集钩子：**宗门旧债。',
    duration: 15,
    durationMode: 'auto',
    generationMode: 'segment-board',
    style: '仙侠电影',
    aspectRatio: '16:9',
  });
  assert.equal(calls, 1);
  assert.equal(result.segments[0].shots.length, 3);
});

test('analysis repair keeps a partially restored dialogue candidate for the next attempt', async () => {
  const lineOne = '先把账册带走。';
  const lineTwo = '工钱一文不能少。';
  const envelope = data => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] });
  const base = {
    characters: [],
    scenes: [{ id: 'room', name: '账房', description: '黄昏室内' }],
    looks: [],
    segments: [{ title: '抢救账册', summary: '两句对白', episodeNumber: 1, duration: 15, shots: [
      { sceneId: 'room', scene: '账房', action: '沈砚拿起账册', camera: '中景', dialogue: '', characterIds: [], duration: 5 },
      { sceneId: 'room', scene: '账房', action: '顾小满护住账册', camera: '近景', dialogue: '', characterIds: [], duration: 5 },
      { sceneId: 'room', scene: '账房', action: '火光照亮桌面', camera: '特写', dialogue: '', characterIds: [], duration: 5 },
    ] }],
  };
  const requests = [];
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      const input = JSON.parse(options.body.messages[1].content);
      requests.push(input);
      if (!input.repairAttempt) return envelope(base);
      const repaired = structuredClone(input.originalSegments);
      const shots = repaired[0].shots;
      const hasFirstLine = shots.some(shot => shot.dialogue === lineOne);
      if (!hasFirstLine) shots[0].dialogue = lineOne;
      else shots[1].dialogue = lineTwo;
      return envelope({ segments: repaired });
    },
  });
  const result = await provider.analyze({
    novel: '# 第1集\n## 场1 账房 黄昏 内\n**沈砚：**先把账册带走。\n**顾小满：**工钱一文不能少。',
    duration: 15,
    durationMode: 'auto',
    generationMode: 'segment-board',
    style: '仙侠电影',
    aspectRatio: '16:9',
  });
  assert.deepEqual(result.segments[0].shots.map(shot => shot.dialogue).filter(Boolean), [lineOne, lineTwo]);
  assert.equal(requests.filter(input => input.repairAttempt).length, 2);
});

test('dialogue evidence ignores narrative sentences that contain an internal colon', async () => {
  const requests = [];
  const response = {
    characters: [],
    scenes: [{ id: 'room', name: '账房', description: '黄昏室内' }],
    looks: [],
    segments: [{ title: '账册证据', summary: '对白与账册', episodeNumber: 1, duration: 15, shots: [
      { sceneId: 'room', scene: '账房', action: '陆玄抬头', camera: '中景', dialogue: '你敢动宗门账房！', characterIds: [], duration: 5 },
      { sceneId: 'room', scene: '账房', action: '沈砚灭火', camera: '近景', dialogue: '我来灭火。你拿的是什么？', characterIds: [], duration: 5 },
      { sceneId: 'room', scene: '账房', action: '账页摊开', camera: '特写', dialogue: '', characterIds: [], duration: 5 },
    ] }],
  };
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      requests.push(JSON.parse(options.body.messages[1].content));
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] };
    },
  });
  await provider.analyze({
    novel: '# 第1集\n## 场1 账房 黄昏 内\n**陆玄：**你敢动宗门账房！\n**沈砚：**我来灭火。你拿的是什么？\n她指的是“灵髓收入”。沈砚把账页翻到最新一笔：昨日，青云宗向商会出售灵髓一瓶。',
    duration: 15,
    durationMode: 'auto',
    generationMode: 'segment-board',
    style: '仙侠电影',
    aspectRatio: '16:9',
  });
  assert.deepEqual(requests[0].dialogueEvidence, [
    { speaker: '陆玄', text: '你敢动宗门账房！' },
    { speaker: '沈砚', text: '我来灭火。你拿的是什么？' },
  ]);
});

test('scene-look repair creates a new scene only when the candidate carries a wardrobe boundary', async () => {
  const requests = [];
  const shots = nineShots({ sceneId: 's2', scene: '院子', characterIds: ['hero'] });
  const conflicting = {
    characters: [{ id: 'hero', name: '林晚', aliases: [], role: 'protagonist', appearance: '短发', evidence: '林晚' }],
    scenes: [{ id: 's1', name: '院子', description: '白天' }],
    looks: [
      { id: 'look-day', sceneId: 's1', characterId: 'hero', name: '蓝衣', appearance: '蓝色外衣' },
      { id: 'look-night', sceneId: 's1', characterId: 'hero', name: '红衣', appearance: '红色外衣' },
    ],
    segments: [{ title: '夜间转场', summary: '换装后继续', duration: 30, shots: nineShots({ sceneId: 's1', scene: '院子', characterIds: ['hero'] }) }],
  };
  const repaired = {
    ...conflicting,
    scenes: [
      { id: 's1', name: '院子', description: '白天' },
      { id: 's2', name: '院子', description: '夜晚换装后' },
    ],
    looks: [
      conflicting.looks[0],
      { ...conflicting.looks[1], sceneId: 's2' },
    ],
    segments: [{ ...conflicting.segments[0], shots }],
  };
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      requests.push(options.body.messages[0].content);
      const input = JSON.parse(options.body.messages[1].content);
      return input.repairAttempt
        ? { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(repaired) } }] }
        : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(conflicting) } }] };
    },
  });
  const result = await provider.analyze({
    novel: '# 第1集\n## 场1 院子 白天 外\n林晚穿蓝色外衣。\n## 场2 院子 夜晚 外\n林晚换上红色外衣。',
    duration: 30,
    style: '电影',
    aspectRatio: '16:9',
  });
  assert.equal(result.scenes.length, 2);
  assert.equal(result.looks.length, 2);
  assert.match(requests[1], /每个（sceneId，characterId）只能保留一个造型/);
});

test('analysis creates continuity assets and maps the same uniform to every relevant shot', async () => {
  const response = {
    characters: [{ id: 'disciple-a', name: '弟子甲', role: 'extra', aliases: [], appearance: '年轻男性', evidence: '弟子甲站在队列中。' }, { id: 'disciple-b', name: '弟子乙', role: 'extra', aliases: [], appearance: '年轻女性', evidence: '弟子乙站在队列中。' }],
    scenes: [{ id: 'gate', name: '宗门广场', description: '白日，山门前广场' }],
    looks: [{ id: 'look-a', sceneId: 'gate', characterId: 'disciple-a', name: '统一制服', appearance: '青灰色宗门制服' }, { id: 'look-b', sceneId: 'gate', characterId: 'disciple-b', name: '统一制服', appearance: '青灰色宗门制服' }],
    assets: [{ id: 'uniform', name: '宗门制服', kind: 'costume', description: '青灰色统一制式制服，弟子之间不可改变颜色和款式', evidence: '所有弟子穿着统一制服。' }],
    segments: [{ title: '队列', summary: '弟子列队', episodeNumber: 1, duration: 15, shots: Array.from({ length: 3 }, () => ({ sceneId: 'gate', scene: '宗门广场', action: '弟子列队', camera: '全景', dialogue: '', characterIds: ['disciple-a', 'disciple-b'], assetIds: ['uniform'], duration: 5 })) }],
  };
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] }) });
  const result = await provider.analyze({ novel: '# 第1集\n所有弟子穿着统一制服。', duration: 15, durationMode: 'auto', generationMode: 'segment-board', style: '仙侠电影', aspectRatio: '9:16' });
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].name, '宗门制服');
  assert.equal(result.assets[0].kind, 'costume');
  assert.ok(result.segments[0].shots.every(shot => shot.assetIds.length === 1 && shot.assetIds[0] === result.assets[0].id));
});

test('segment-board analysis prompt and validation cap legacy projects at fifteen seconds', async () => {
  const requests = [];
  const response = {
    characters: [],
    scenes: [{ id: 's1', name: '空场', description: '' }],
    looks: [],
    segments: [{ title: '一段', summary: '空场', duration: 15, shots: Array.from({ length: 3 }, (_, index) => ({
      sceneId: 's1', scene: '空场', action: `动作${index + 1}`, camera: '中景', dialogue: '', characterIds: [], duration: 5,
    })) }],
  };
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      requests.push(options.body);
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] };
    },
  });
  const result = await provider.analyze({ novel: '空场。', duration: 30, durationMode: 'fixed', generationMode: 'segment-board', style: '电影', aspectRatio: '9:16' });
  assert.equal(result.segments[0].duration, 15);
  assert.match(requests[0].messages[0].content, /绝对不能|不超过 15 秒|不超过15秒/);
  assert.match(requests[0].messages[1].content, /3-15 seconds|3 到 15/);
});

test('analysis isolates a cross-chunk character ID drift instead of stopping the book', async () => {
  let calls = 0;
  const responseFor = character => ({
    characters: character ? [{ id: 'c1', name: character, aliases: [], role: 'supporting', appearance: '黑发', evidence: character }] : [],
    scenes: [{ id: 'room', name: '房间', description: '室内' }],
    looks: character ? [{ id: `look-${character === '甲' ? 'a' : 'b'}`, sceneId: 'room', characterId: 'c1', name: '日常造型', appearance: '深色衣物' }] : [],
    segments: [{ title: `片段${calls}`, summary: '房间内发生事件', duration: 30, shots: nineShots({ sceneId: 'room', scene: '房间', characterIds: character ? ['c1'] : [] }) }],
  });
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async () => {
      calls += 1;
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(responseFor(calls === 1 ? '甲' : calls === 2 ? '乙' : null)) } }] };
    },
  });
  const result = await provider.analyze({ novel: '连续剧情。\n'.repeat(12000), duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.ok(calls > 2);
  assert.ok(result.characters.some(character => character.name === '甲'));
  assert.ok(result.characters.some(character => character.name === '乙'));
  assert.notEqual(result.characters.find(character => character.name === '甲').id, result.characters.find(character => character.name === '乙').id);
  assert.ok(result.segments[1].shots[0].characterIds.includes(result.characters.find(character => character.name === '乙').id));
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

test('episode duration above the recommendation is returned as a warning without failing analysis', async () => {
  const complete = {
    characters: [],
    scenes: [{ id: 's1', name: '空场', description: '' }],
    looks: [],
    segments: Array.from({ length: 8 }, (_, index) => ({
      episodeNumber: 55,
      episodeTitle: '完整内容',
      title: `片段${index + 1}`,
      summary: '保留原文剧情',
      duration: 30,
      shots: nineShots(),
    })),
  };
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(complete) } }] }),
  });
  const result = await provider.analyze({ novel: '第55集：完整剧情。', duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.equal(result.segments.length, 8);
  assert.equal(result.analysisWarnings?.[0]?.episodeNumber, 55);
  assert.equal(result.analysisWarnings?.[0]?.totalDuration, 240);
  assert.equal(result.analysisWarnings?.[0]?.maximumDuration, 120);
});

test('analysis rescales a finite shot timing estimate instead of stopping on total drift', async () => {
  const response = {
    characters: [],
    scenes: [{ id: 's1', name: '山门', description: '白天' }],
    looks: [],
    segments: [{ title: '动作', summary: '动作段', duration: 15, shots: Array.from({ length: 3 }, (_, index) => ({
      sceneId: 's1', scene: '山门', action: `动作${index + 1}`, camera: '中景', dialogue: '', characterIds: [], duration: 13,
    })) }],
  };
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] }),
  });
  const result = await provider.analyze({ novel: '主角在山门停下。', duration: 15, durationMode: 'auto', generationMode: 'segment-board', style: '电影', aspectRatio: '9:16' });
  assert.equal(result.segments[0].shots.reduce((sum, shot) => sum + shot.duration, 0), 15);
  assert.ok(result.segments[0].shots.every(shot => shot.duration > 0.1 && shot.duration <= 15));
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
  assert.equal(calls, 4);
});

test('analysis gives the current block one final field-focused repair before stopping', async () => {
  let calls = 0;
  const valid = { characters: [], scenes: [{ id: 's1', name: '空场', description: '' }], looks: [], segments: [{ title: '一段', summary: '空场', duration: 30, shots: nineShots() }] };
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    calls++;
    if (calls < 4) {
      const invalid = calls === 1 ? { ...valid, segments: [{ ...valid.segments[0], shots: Array.from({ length: 8 }, () => ({ sceneId: 's1', scene: '空场', action: '停下', camera: '中景', characterIds: [], duration: 3 })) }] } : { segments: [{ ...valid.segments[0], shots: Array.from({ length: 8 }, () => ({ sceneId: 's1', scene: '空场', action: '停下', camera: '中景', characterIds: [], duration: 3 })) }] };
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(invalid) } }] };
    }
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ segments: valid.segments }) } }] };
  } });
  const result = await provider.analyze({ novel: '空场。', duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.equal(calls, 4);
  assert.equal(result.segments[0].shots.length, 9);
});

test('analysis infers a missing episode number when a chunk belongs to one episode', async () => {
  const response = { characters: [], scenes: [{ id: 's1', name: '庭院', description: '白天' }], looks: [], segments: [{ title: '相遇', summary: '庭院相遇', duration: 30, shots: nineShots({ sceneId: 's1', scene: '庭院' }) }] };
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] }) });
  const result = await provider.analyze({ novel: '# 第1集\n\n林晚走进庭院。', duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.equal(result.segments[0].episodeNumber, 1);
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

test('new segment-board duration recommendation stays within fifteen seconds and asks the model to judge pacing',async()=>{
  let request;
  const response={characters:[],scenes:[{id:'bookstore',name:'书店',description:'室内'}],looks:[],segments:[15,12].map(duration=>({title:duration===15?'快速蒙太奇':'对话展开',summary:'本段剧情',duration,shots:Array.from({length:9},(_,index)=>({sceneId:'bookstore',scene:'书店',action:'看向窗外',camera:'近景',dialogue:'',characterIds:[],duration:index===8?duration/5:duration/10}))}))};
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async(_url,options)=>{request=options.body;return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]};}});
  const result=await p.analyze({novel:'风吹动树叶。随后两个人在书店展开长谈。',duration:15,durationMode:'auto',generationMode:'segment-board',style:'电影',aspectRatio:'9:16'});
  assert.deepEqual(result.segments.map(segment=>segment.duration),[15,12]);
  const input=JSON.parse(request.messages[1].content);
  assert.equal(input.segmentDuration,'recommend-up-to-15');
  assert.equal(input.outputSchema.segments[0].duration,'3-15');
  assert.match(request.messages[0].content,/台词/);
  assert.match(request.messages[0].content,/快切/);
  assert.match(request.messages[0].content,/片段级整板模式/);
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

test('segment video prompts bind each dialogue line to its speaking character and reference label', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-dialogue-speaker-binding-')); t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 320, height: 568, channels: 3, background: '#17243f' } }).png().toBuffer();
  const requests = [];
  const provider = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { task_id: 'dialogue-speaker-task', status: 'queued' }; },
  });
  const project = {
    id: 'dialogue-speaker-project',
    novel: '林晚：你来了。\n陈默：我一直在等。',
    generationMode: 'segment-board', videoMode: 'storyboard', durationMode: 'auto', aspectRatio: '9:16', style: '电影',
    characters: [
      { id: 'lin', name: '林晚', aliases: [], appearance: '黑发', reference: null, approved: false, version: 1 },
      { id: 'chen', name: '陈默', aliases: [], appearance: '短发', reference: null, approved: false, version: 1 },
    ],
    scenes: [{ id: 's1', name: '雨巷', description: '夜晚' }], looks: [], assets: [],
  };
  const image = await provider.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  project.characters[0].reference = image;
  project.characters[1].reference = image;
  const segment = {
    id: 'speaker-segment', number: 1, title: '重逢', summary: '两人重逢', duration: 6, storyboardImage: image,
    shots: [
      { id: 'shot-1', number: 1, sceneId: 's1', scene: '雨巷', action: '林晚抬眼看向陈默', camera: '中近景', dialogue: '你来了。', characterIds: ['lin', 'chen'], duration: 3, image },
      { id: 'shot-2', number: 2, sceneId: 's1', scene: '雨巷', action: '陈默向前一步', camera: '近景', dialogue: '我一直在等。', characterIds: ['lin', 'chen'], duration: 3, image },
    ],
  };
  await provider.submitSegmentVideo(project, segment, 'dialogue-speaker-business');
  const prompt = requests[0].content[0].text;
  assert.match(prompt, /镜头\s*1[^\n]*林晚[^\n]*你来了/);
  assert.match(prompt, /镜头\s*2[^\n]*陈默[^\n]*我一直在等/);
  assert.match(prompt, /角色「林晚」/);
  assert.match(prompt, /角色「陈默」/);
});

test('source dialogue evidence corrects a stale reversed speaker binding before video submission', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-dialogue-speaker-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 320, height: 568, channels: 3, background: '#263238' } }).png().toBuffer();
  const requests = [];
  const provider = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { task_id: 'dialogue-source-task', status: 'queued' }; },
  });
  const project = {
    id: 'dialogue-source-project', novel: '林晚：你来了。', generationMode: 'segment-board', videoMode: 'storyboard',
    durationMode: 'auto', aspectRatio: '9:16', style: '电影',
    characters: [
      { id: 'lin', name: '林晚', aliases: [], appearance: '黑发' },
      { id: 'chen', name: '陈默', aliases: [], appearance: '短发' },
    ], scenes: [{ id: 's1', name: '雨巷', description: '夜晚' }], looks: [], assets: [],
  };
  const image = await provider.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  const segment = {
    id: 'speaker-source-segment', number: 1, title: '重逢', summary: '两人重逢', duration: 6, storyboardImage: image,
    shots: [
      { id: 'shot-1', number: 1, sceneId: 's1', scene: '雨巷', action: '林晚抬眼', camera: '近景', dialogue: '你来了。', dialogueSpeakerId: 'chen', characterIds: ['lin', 'chen'], duration: 3, image },
      { id: 'shot-2', number: 2, sceneId: 's1', scene: '雨巷', action: '陈默沉默', camera: '中景', dialogue: '', characterIds: ['lin', 'chen'], duration: 3, image },
    ],
  };
  await provider.submitSegmentVideo(project, segment, 'dialogue-source-business');
  const prompt = requests[0].content[0].text;
  assert.match(prompt, /对白仅由角色「林晚」说出/);
  assert.doesNotMatch(prompt, /对白仅由角色「陈默」说出/);
});

test('multi-line dialogue in one shot keeps every line bound to its source speaker', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-dialogue-speaker-lines-')); t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 320, height: 568, channels: 3, background: '#263238' } }).png().toBuffer();
  const requests = [];
  const provider = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { task_id: 'dialogue-lines-task', status: 'queued' }; },
  });
  const project = {
    id: 'dialogue-lines-project',
    novel: '林晚：你来了。\n陈默：我一直在等。',
    generationMode: 'segment-board', videoMode: 'storyboard', durationMode: 'auto', aspectRatio: '9:16', style: '电影',
    characters: [
      { id: 'lin', name: '林晚', aliases: [], appearance: '黑发' },
      { id: 'chen', name: '陈默', aliases: [], appearance: '短发' },
    ],
    scenes: [{ id: 's1', name: '雨巷', description: '夜晚' }], looks: [], assets: [],
  };
  const image = await provider.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  project.characters[0].reference = image;
  project.characters[1].reference = image;
  const segment = {
    id: 'speaker-lines-segment', number: 1, title: '重逢', summary: '两人重逢', duration: 6, storyboardImage: image,
    shots: [{
      id: 'shot-1', number: 1, sceneId: 's1', scene: '雨巷', action: '两人对视', camera: '中近景',
      dialogue: '林晚：你来了。\n陈默：我一直在等。', characterIds: ['lin', 'chen'], duration: 6, image,
    }],
  };
  await provider.submitSegmentVideo(project, segment, 'dialogue-lines-business');
  const prompt = requests[0].content[0].text;
  assert.match(prompt, /对白仅由角色「林晚」说出[：:]“?你来了/);
  assert.match(prompt, /对白仅由角色「陈默」说出[：:]“?我一直在等/);
});

test('background dialogue stays an off-screen crowd voice instead of using a foreground character', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-dialogue-background-')); t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 320, height: 568, channels: 3, background: '#263238' } }).png().toBuffer();
  const requests = [];
  const provider = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { task_id: 'dialogue-background-task', status: 'queued' }; },
  });
  const project = {
    id: 'dialogue-background-project', novel: '报喜弟子：少宗主筑基成功。',
    generationMode: 'segment-board', videoMode: 'storyboard', durationMode: 'auto', aspectRatio: '9:16', style: '电影',
    characters: [
      { id: 'lin', name: '林晚', aliases: [], appearance: '黑发' },
      { id: 'chen', name: '陈默', aliases: [], appearance: '短发' },
    ], scenes: [{ id: 's1', name: '演武台', description: '白日' }], looks: [], assets: [],
  };
  const image = await provider.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  project.characters[0].reference = image;
  project.characters[1].reference = image;
  const segment = {
    id: 'dialogue-background-segment', number: 1, title: '筑基', summary: '演武台', duration: 4, storyboardImage: image,
    shots: [{ id: 'shot-1', number: 1, sceneId: 's1', scene: '演武台', action: '两人站在台上', camera: '远景',
      dialogue: '报喜弟子：少宗主筑基成功。', backgroundActors: '数名弟子在两侧行礼', characterIds: ['lin', 'chen'], duration: 4, image }],
  };
  await provider.submitSegmentVideo(project, segment, 'dialogue-background-business');
  const prompt = requests[0].content[0].text;
  assert.match(prompt, /群众\/画外角色「报喜弟子」作为环境声/);
  assert.match(prompt, /不得给画面中的人物开口/);
  assert.doesNotMatch(prompt, /对白仅由角色「林晚」说出/);
  assert.doesNotMatch(prompt, /对白仅由角色「陈默」说出/);
});

test('multi-character dialogue without a reliable speaker is blocked before any paid video request', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-dialogue-speaker-required-')); t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 320, height: 568, channels: 3, background: '#37474f' } }).png().toBuffer();
  const requests = [];
  const provider = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { task_id: 'must-not-submit', status: 'queued' }; },
  });
  const project = {
    id: 'dialogue-required-project', novel: '雨夜里两人对视。', generationMode: 'segment-board', videoMode: 'storyboard',
    durationMode: 'auto', aspectRatio: '9:16', style: '电影',
    characters: [{ id: 'lin', name: '林晚', aliases: [], appearance: '黑发' }, { id: 'chen', name: '陈默', aliases: [], appearance: '短发' }],
    scenes: [{ id: 's1', name: '雨巷', description: '夜晚' }], looks: [], assets: [],
  };
  const image = await provider.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  const segment = {
    id: 'speaker-required-segment', number: 1, title: '待核对', summary: '两人对话', duration: 6, storyboardImage: image,
    shots: [
      { id: 'shot-1', number: 1, sceneId: 's1', scene: '雨巷', action: '两人对视', camera: '近景', dialogue: '你到底是谁？', characterIds: ['lin', 'chen'], duration: 3, image },
      { id: 'shot-2', number: 2, sceneId: 's1', scene: '雨巷', action: '两人沉默', camera: '中景', dialogue: '', characterIds: ['lin', 'chen'], duration: 3, image },
    ],
  };
  await assert.rejects(provider.submitSegmentVideo(project, segment, 'dialogue-required-business'), error => error.code === 'DIALOGUE_SPEAKER_REQUIRED');
  assert.equal(requests.length, 0);
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

test('analysis restores source dialogue after bounded model repairs still omit it', async () => {
  let calls = 0;
  const response = () => {
    const shots = nineShots({ sceneId: 'room', scene: '室内' });
    return { characters: [], scenes: [{ id: 'room', name: '室内', description: '夜晚' }], looks: [], segments: [{ title: '重逢', summary: '人物在室内重逢', duration: 30, shots }] };
  };
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async () => { calls += 1; return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response()) } }] }; },
  });
  const result = await provider.analyze({ novel: '甲：你终于来了。\n乙：我一直在等你。', duration: 30, style: '电影', aspectRatio: '9:16' });
  assert.equal(calls, 4, 'initial analysis plus the bounded repair attempts should be enough');
  assert.deepEqual(result.segments[0].shots.map(shot => shot.dialogue).filter(Boolean), ['你终于来了。', '我一直在等你。']);
});

test('duplicate provider character IDs cannot silently reassign all shots to a different person',async()=>{
  const response={characters:[{id:'same',name:'沈青',aliases:[],appearance:'黑发',evidence:''},{id:'same',name:'苏明',aliases:[],appearance:'白衣',evidence:''}],scenes:[{id:'s1',name:'室内',description:''}],looks:[],segments:[{title:'重逢',duration:30,shots:nineShots({sceneId:'s1',scene:'室内',characterIds:['same']})}]};
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

test('analysis keeps a canonical character ID and isolates a conflicting new name',async()=>{
  let index=0;let canonical;
  const p=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmKey:'key'}),requestJson:async()=>{
    index++;
    const response={characters:[{id:index===1?'hero':canonical,name:index===1?'何一':'苏二',aliases:[],appearance:'短发',evidence:index===1?'何一':'苏二'}],scenes:[{id:'s1',name:'室内',description:'同一场'}],looks:[{id:'l1',sceneId:'s1',characterId:index===1?'hero':canonical,name:'日常',appearance:'日常服'}],segments:[{title:'一段',summary:'本段',duration:30,shots:Array.from({length:9},(_,i)=>({sceneId:'s1',scene:'室内',action:'站立',camera:'中景',dialogue:'',characterIds:[index===1?'hero':canonical],duration:i===8?6:3}))}]};
    if(index===1)canonical='hero';
    return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]};
  }});
  const result=await p.analyze({novel:'何一和苏二。'.repeat(5000),duration:30,style:'电影',aspectRatio:'9:16'});
  assert.equal(result.characters.length,2);
  assert.notEqual(result.characters[0].id,result.characters[1].id);
  assert.ok(result.characters.some(character=>character.name==='何一'));
  assert.ok(result.characters.some(character=>character.name==='苏二'));
});

test('segment video prompt compacts long shot fields instead of rejecting the task', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-video-prompt-budget-')); t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 320, height: 568, channels: 3, background: '#17243f' } }).png().toBuffer();
  const requests = [];
  const provider = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { id: 'compact-task', status: 'queued' }; },
  });
  const project = { id: 'compact-project', generationMode: 'segment-board', durationMode: 'auto', aspectRatio: '9:16', style: '电影', characters: [], scenes: [{ id: 's1', name: '山门', description: '宏大的山门与云海' }], looks: [] };
  const image = await provider.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  const longText = '连续动作与台词信息'.repeat(500);
  const segment = {
    id: 'seg1', number: 1, title: '长提示词', summary: '连续动作', duration: 15, storyboardImage: image,
    shots: Array.from({ length: 3 }, (_, index) => ({ id: `shot-${index + 1}`, number: index + 1, sceneId: 's1', scene: '山门', action: `${longText}${index}`, camera: '中景', movementPlan: longText, transitionPlan: '保持动作轴', dialogue: `${longText}${index}`, narration: '', backgroundActors: '', characterIds: [], duration: 5, image, approved: true, version: 1, imageVersion: 1 })),
  };
  await provider.submitSegmentVideo(project, segment, 'compact-business');
  const prompt = requests[0].content[0].text;
  assert.ok(prompt.length <= 6500, `prompt length was ${prompt.length}`);
  assert.match(prompt, /镜头 1（5\.00 秒）/);
  assert.match(prompt, /镜头 2（5\.00 秒）/);
  assert.match(prompt, /镜头 3（5\.00 秒）/);
  assert.match(prompt, /动作/);
  assert.match(prompt, /台词/);
});

test('new fifteen-second segment-board projects reject thirty-second video tasks before provider submission', async () => {
  let calls = 0;
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async () => { calls += 1; return { id: 'should-not-submit', status: 'queued' }; },
  });
  const project = { id: 'new-project', generationMode: 'segment-board', duration: 15, aspectRatio: '9:16', scenes: [], looks: [], characters: [] };
  const segment = { id: 'segment', duration: 30, storyboardImage: '/media/new-project/storyboard.png', shots: [{ number: 1, image: '/media/new-project/shot.png' }] };
  await assert.rejects(provider.submitSegmentVideo(project, segment, 'business'), error => error.code === 'INVALID_INPUT' && /15/.test(error.message));
  assert.equal(calls, 0);
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
    { status: 'failed', is_final: true, result_inconsistent: true, output_url: 'https://cdn.example/inconsistent-result.mp4' },
    { status: 'completed', is_final: true, output: { url: 'https://cdn.example/output-object.mp4' } },
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
  const inconsistent = await p.pollVideo('xiongmao-variant-task');
  assert.equal(inconsistent.status, 'completed');
  assert.equal(inconsistent.url, 'https://cdn.example/inconsistent-result.mp4');
  const outputObject = await p.pollVideo('xiongmao-variant-task');
  assert.equal(outputObject.status, 'completed');
  assert.equal(outputObject.url, 'https://cdn.example/output-object.mp4');
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

test('Xiongmao Seedance 2.5 special accepts a 30-second traditional segment with ordered references', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-xiongmao-seedance-25-traditional-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const p = createProviders({
    mediaRoot: root,
    getSettings: () => ({ xiongmaoMinimaxH3Key: 'private-xiongmao-key', videoModel: 'xiongmao-seedance-2-5-special' }),
    requestMultipartJson: async (_url, options) => ({ url: `https://cdn.example/reference-${options.file.filename}` }),
    requestJson: async (url, options) => { calls.push({ url, body: options.body }); return { task_id: 'seedance-25-traditional', status: 'pending' }; },
  });
  const project = {
    id: 'p25-traditional', style: '国风仙侠电影', aspectRatio: '9:16', generationMode: 'segment-board', videoMode: 'traditional',
    characters: [], scenes: [], looks: [], assets: [],
  };
  const png = await sharp({ create: { width: 256, height: 512, channels: 3, background: 'purple' } }).png().toBuffer();
  const sceneReference = await p.importImage(project, `data:image/png;base64,${png.toString('base64')}`);
  project.scenes = [{ id: 'scene-1', name: '宗门大殿', description: '古代仙门大殿', reference: sceneReference, referenceVersion: 1, approved: true, version: 1 }];
  const segment = {
    id: 'seg-25-traditional', number: 1, title: '突破', duration: 30, shots: [10, 10, 10].map((duration, index) => ({
      id: `shot-${index + 1}`, number: index + 1, duration, scene: '宗门大殿', sceneId: 'scene-1', action: '角色完成动作', camera: '推进', movementPlan: '沿动作轴自然切换', transitionPlan: '自然衔接', dialogue: index === 1 ? '我突破了。' : '', narration: '', characterIds: [], assetIds: [],
    })),
  };
  const submitted = await p.submitSegmentVideo(project, segment, 'business-seedance-25-traditional', 'xiongmao-seedance-2-5-special', '1080p');
  assert.equal(submitted.id, 'seedance-25-traditional');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'seedance-2-5-special');
  assert.equal(calls[0].body.duration, 30);
  assert.equal(calls[0].body.resolution, '1080p');
  assert.equal(calls[0].body.mode, 'reference');
  assert.equal(calls[0].body.images.length, 1);
  assert.match(calls[0].body.prompt, /传统多参考图模式/);
  assert.equal(JSON.stringify(calls[0].body).includes('private-xiongmao-key'), false);
});

test('Xiongmao Seedance 2.5 special allows an explicit 30-second storyboard segment and rejects other durations', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-xiongmao-seedance-25-storyboard-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const p = createProviders({
    mediaRoot: root,
    getSettings: () => ({ xiongmaoMinimaxH3Key: 'private-xiongmao-key', videoModel: 'xiongmao-seedance-2-5-special' }),
    requestMultipartJson: async (_url, options) => ({ url: `https://cdn.example/reference-${options.file.filename}` }),
    requestJson: async (url, options) => { calls.push({ url, body: options.body }); return { task_id: `seedance-25-storyboard-${calls.length}`, status: 'pending' }; },
  });
  const project = { id: 'p25-storyboard', style: '电影', aspectRatio: '16:9', generationMode: 'segment-board', videoMode: 'storyboard', characters: [], scenes: [], looks: [], assets: [] };
  const png = await sharp({ create: { width: 640, height: 360, channels: 3, background: 'teal' } }).png().toBuffer();
  const storyboard = await p.importImage(project, `data:image/png;base64,${png.toString('base64')}`);
  const images = await Promise.all([1, 2, 3].map(() => p.importImage(project, `data:image/png;base64,${png.toString('base64')}`)));
  const makeSegment = duration => ({ id: `seg-${duration}`, number: 1, title: '连续场景', duration, storyboardImage: storyboard, shots: [10, 10, duration - 20].map((shotDuration, index) => ({ id: `shot-${duration}-${index + 1}`, number: index + 1, duration: shotDuration, scene: '城门', action: '动作', camera: '中景', movementPlan: '自然运动', transitionPlan: '自然衔接', dialogue: '', narration: '', characterIds: [], assetIds: [], image: images[index] })) });
  await p.submitSegmentVideo(project, makeSegment(30), 'business-seedance-25-storyboard', 'xiongmao-seedance-2-5-special', '720p');
  assert.equal(calls[0].body.model, 'seedance-2-5-special');
  assert.equal(calls[0].body.duration, 30);
  assert.equal(calls[0].body.resolution, '720p');
  assert.equal(calls[0].body.images.length, 3);
  assert.match(calls[0].body.prompt, /明确规划的 30 秒连续场景/);
  await assert.rejects(p.submitSegmentVideo(project, makeSegment(29), 'business-seedance-25-invalid', 'xiongmao-seedance-2-5-special', '720p'), error => error.code === 'VIDEO_DURATION_UNSUPPORTED');
  assert.equal(calls.length, 1, 'invalid duration must be rejected before upload or paid submission');
});

test('Xiongmao reference upload enforces the model-specific single-image size limit before POST', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-xiongmao-image-limit-')); t.after(() => rm(root, { recursive: true, force: true }));
  let uploads = 0;
  const p = createProviders({
    mediaRoot: root,
    getSettings: () => ({ xiongmaoMinimaxH3Key: 'private-xiongmao-key', videoModel: 'xiongmao-minimaxh3' }),
    requestMultipartJson: async () => { uploads += 1; return { url: 'https://cdn.example/reference.png' }; },
    requestJson: async () => ({ task_id: 'must-not-submit', status: 'pending' }),
  });
  const project = { id: 'p-limit', style: '电影', aspectRatio: '9:16', generationMode: 'segment-board', videoMode: 'traditional', characters: [], scenes: [], looks: [], assets: [] };
  const raw = randomBytes(1800 * 1800 * 3);
  const oversizedPng = await sharp(raw, { raw: { width: 1800, height: 1800, channels: 3 } }).png().toBuffer();
  assert.ok(oversizedPng.length > 4 * 1024 * 1024);
  await mkdir(path.join(root, project.id), { recursive: true });
  await writeFile(path.join(root, project.id, 'oversized.png'), oversizedPng);
  project.scenes = [{ id: 'scene-1', name: '场景', description: '场景', reference: `/media/${project.id}/oversized.png`, referenceVersion: 1, approved: true, version: 1 }];
  const segment = { id: 'seg-limit', number: 1, title: '片段', duration: 6, shots: [{ id: 'shot-limit', number: 1, duration: 6, sceneId: 'scene-1', scene: '场景', action: '动作', camera: '中景', movementPlan: '自然运动', transitionPlan: '自然衔接', dialogue: '', narration: '', characterIds: [], assetIds: [] }] };
  await assert.rejects(p.submitSegmentVideo(project, segment, 'business-limit', 'xiongmao-minimaxh3', '768p'), error => error.code === 'IMAGE_TOO_LARGE');
  assert.equal(uploads, 0);
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

test('long multi-episode chunks keep the compact one-segment response budget', async () => {
  const requests = [];
  const episodeText = Array.from({ length: 10 }, (_, index) => `第${index + 1}集：转折${index + 1}\n${'这一集的事件和证据。'.repeat(420)}`).join('\n');
  const provider = createProviders({ mediaRoot: tmpdir(), getSettings: () => ({ llmKey: 'key' }), requestJson: async (_url, options) => {
    const input = JSON.parse(options.body.messages[1].content);
    requests.push(input);
    const number = input.expectedEpisodeNumbers?.[0] ?? 1;
    const response = {
      characters: [],
      scenes: [{ id: 'episode-scene', name: '故事场景', description: '原文场景' }],
      looks: [],
      segments: [{ episodeNumber: number, episodeTitle: `转折${number}`, title: `第${number}集片段`, summary: `第${number}集剧情`, duration: 15, shots: nineShots({ sceneId: 'episode-scene', scene: '故事场景' }).map((shot, index) => ({ ...shot, duration: index === 8 ? 3 : 1.5 })) }],
    };
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(response) } }] };
  } });
  await provider.analyze({ novel: episodeText, duration: 30, style: '电影', aspectRatio: '9:16', generationMode: 'segment-board' });
  assert.ok(requests.length > 2);
  assert.ok(requests.every(request => request.maxSegments === 1));
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

test('CRLF episode headings keep the separator outside the next analysis chunk', async () => {
  const requests = [];
  const novel = [
    '# 第一季项目定位',
    '人物和世界观说明。',
    '# 两集目录',
    '1. 开端',
    '2. 转折',
    '# 第1集 开端',
    '第一集正文。',
    '# 第2集 转折',
    '第二集正文。',
  ].join('\r\n');
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      requests.push(JSON.parse(options.body.messages[1].content));
      const number = requests.at(-1).expectedEpisodeNumbers?.[0] ?? 1;
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        characters: [],
        scenes: [{ id: 'scene', name: '场景', description: '' }],
        looks: [],
        segments: [{ title: `第${number}集`, summary: '正文', episodeNumber: number, duration: 3, shots: nineShots({ sceneId: 'scene', scene: '场景' }).map((shot, index) => ({ ...shot, duration: index === 8 ? 1.5 : 0.1875 })) }],
      }) } }] };
    },
  });
  await provider.analyze({ novel, duration: 15, durationMode: 'auto', generationMode: 'segment-board', style: '电影', aspectRatio: '16:9' });
  assert.match(requests[0].novelChunk, /^# 第1集 开端/);
  assert.deepEqual(requests.map(input => input.expectedEpisodeNumbers), [[1], [2]]);
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

test('numbered episode catalogs keep the long preface out of the first analysis block', async () => {
  const requests = [];
  const novel = [
    '# 借我灵根不还',
    '## 第一季项目定位',
    '这是人物、世界观和能力规则的长篇说明。'.repeat(20),
    '# 55集目录与阶段路线',
    '**1—10集：**青云宗还根还脉。',
    '1. 你的筑基，是借我的',
    '2. 先把欠的十万给我',
    '3. 你家的恩情，按月收费？',
    '# 第1集 你的筑基 是借我的',
    '## 场1 演武台 日 外',
    '**沈砚：**借我的灵根，今天该还了。',
    '# 第2集 先把欠的十万给我',
    '## 场1 灵库 日 内',
    '**顾小满：**我照账说的。',
  ].join('\n');
  const provider = createProviders({
    mediaRoot: tmpdir(),
    getSettings: () => ({ llmKey: 'key' }),
    requestJson: async (_url, options) => {
      const input = JSON.parse(options.body.messages[1].content);
      requests.push(input);
      const number = input.expectedEpisodeNumbers?.[0];
      const segment = {
        title: `第${number ?? 1}集`,
        summary: '正文',
        episodeNumber: number ?? 1,
        duration: 15,
        shots: nineShots({ sceneId: 'stage', scene: '演武台' }).map((shot, index) => index === 0
          ? { ...shot, dialogue: number === 1 ? '借我的灵根，今天该还了。' : '我照账说的。' }
          : shot),
      };
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ characters: [], scenes: [{ id: 'stage', name: '演武台', description: '' }], looks: [], segments: [segment] }) } }] };
    },
  });
  await provider.analyze({ novel, duration: 15, durationMode: 'auto', generationMode: 'segment-board', style: '仙侠电影', aspectRatio: '16:9' });
  assert.equal(requests.length, 2);
  assert.match(requests[0].novelChunk, /^# 第1集/);
  assert.match(requests[0].sourcePreamble, /第一季项目定位/);
  assert.deepEqual(requests.map(input => input.expectedEpisodeNumbers), [[1], [2]]);
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
      duration: 15,
      shots: Array.from({ length: 3 }, (_, index) => ({ sceneId: 'episode-scene', scene: '故事场景', action: `动作${index + 1}`, camera: '中景', dialogue: '', characterIds: [], duration: 5 }))
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
    const segments = numbers.flatMap(number => Array.from({ length: 4 }, (_, index) => ({ episodeNumber: number, episodeTitle: number === 1 ? '开端' : '转折', title: `第${number}集片段${index + 1}`, summary: '剧情', duration: 15, shots: nineShots({ sceneId: 'episode-scene', scene: '故事场景' }).map((shot, shotIndex) => ({ ...shot, duration: shotIndex === 8 ? 3 : 1.5 })) })));
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

test('removed Ark Seedance 1.0 models are rejected before provider submission', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-ark-seedance-1-0-')); t.after(()=>rm(root,{recursive:true,force:true}));
  let calls = 0;
  const p=createProviders({mediaRoot:root,getSettings:()=>({arkKey:'key',videoModel:'doubao-seedance-1-0-pro-250528'}),requestJson:async()=>{calls++;return {id:'ark_1',status:'queued'};}});
  const project={id:'p1',style:'电影',aspectRatio:'9:16'};
  const png=await sharp({create:{width:256,height:455,channels:3,background:'blue'}}).png().toBuffer();
  const image=await p.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(p.submitVideo(project,{image,approved:true,duration:0.5,trimStart:0,action:'走',scene:'街',camera:'中景'},'ark_1'),error=>error.code==='MODEL_UNSUPPORTED');
  assert.equal(calls,0);
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
  assert.equal(Object.hasOwn(body,'images'),false);assert.match(body.prompt,/甲/);assert.match(body.prompt,/乙/);assert.match(body.prompt,/黑衣|白衣/);
  assert.match(body.prompt,/audio.*metadata|声音.*元数据/i);
  assert.match(body.prompt,/subtitle|字幕/i);
  assert.match(body.prompt,/speech bubble|对白框|气泡/i);
  assert.equal(JSON.stringify(body).includes('private-key'),false);
  assert.equal(await p.recoverImage(project,'business_image'),result);assert.equal(calls.length,1);assert.equal(downloadCalls,1);
  await assert.rejects(p.generateShot({...project,characters:project.characters.map(c=>({...c,approved:false}))},shot,'blocked'),e=>e.code==='CHARACTER_NOT_APPROVED'&&e.definitive);
  assert.equal(calls.length,1);
});

test('text-only character generation omits an empty reference-image field', async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-grsai-text-only-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const imageBytes=await sharp({create:{width:256,height:256,channels:3,background:'orange'}}).png().toBuffer();
  const calls=[];
  const provider=createProviders({
    mediaRoot:path.join(root,'media'),
    getSettings:()=>({grsaiKey:'private-key',imageModel:'nano-banana-pro'}),
    requestJson:async(_url,options)=>{
      calls.push(options.body);
      if(Object.hasOwn(options.body,'images')&&options.body.images.length===0){
        return {status:'failed',error:'请上传需要作为参考的原始图片后再生成。'};
      }
      return {id:'text-only-character',status:'succeeded',results:[{url:'https://public.example/text-only-character.png'}]};
    },
    download:async()=>imageBytes,
  });
  const result=await provider.generateCharacter({id:'text-only-project',style:'电影',aspectRatio:'16:9'},{name:'江游',appearance:'黑发，青年男性'},'text-only-business');
  assert.ok(result.startsWith('/media/text-only-project/'));
  assert.equal(calls.length,1);
  assert.equal(Object.hasOwn(calls[0],'images'),false);
  assert.match(calls[0].prompt,/Use case: original character design sheet/i);
  assert.match(calls[0].prompt,/Primary request: Create one original image/i);
  assert.match(calls[0].prompt,/text-to-image generation/i);
  assert.doesNotMatch(calls[0].prompt,/identity reference|Input image|image editing|reference image|原始图片|参考图/i);
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
  assert.match(prompt,/Source evidence for visual interpretation/);
  assert.match(prompt,/Do not render field labels, dialogue, actions, repeated prose/i);
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
    assert.match(payload.prompt,/Image 1 is the identity reference for this person/);
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

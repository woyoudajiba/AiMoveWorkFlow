import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createProject, validateAnalysis } from '../server/domain.mjs';
import { resolveMediaPath } from '../server/media.mjs';
import { createProviders } from '../server/providers.mjs';
import { createService } from '../server/service.mjs';
import { listVideoOptions } from '../server/video-options.mjs';

const shots = (count = 5) => Array.from({ length: count }, (_, index) => ({
  sceneId: 's1', scene: '夜雨车站', action: `镜头 ${index + 1} 的连续动作`, camera: '中景，缓慢推进', movementId: 'move-3', movementPlan: '从中景缓慢推进至近景，保持主体在画面中心。', transitionPlan: '承接上一镜右向左视线，沿动作轴自然切换。', dialogue: '', characterIds: [], duration: 3,
}));

const analysis = (count = 5) => ({
  characters: [],
  scenes: [{ id: 's1', name: '夜雨车站', description: '夜晚，雨后的车站站台' }],
  looks: [],
  segments: [{ title: '雨夜重逢', summary: '两个人在车站重逢', duration: 15, shots: shots(count) }],
});

test('segment-board analysis accepts a model-selected shot count and rejects out-of-range counts', () => {
  const project = createProject({ title: '片段整板', novel: '雨夜重逢', duration: 15, generationMode: 'segment-board' });
  const result = validateAnalysis(analysis(5), project);
  assert.equal(result.segments[0].shots.length, 5);
  assert.equal(result.segments[0].generationMode, 'segment-board');
  assert.throws(() => validateAnalysis(analysis(2), project), /3 到 12/);
  assert.throws(() => validateAnalysis(analysis(13), project), /3 到 12/);
});

test('generateSegmentBoard makes one complete-board image request and crops every shot', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-board-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boardBytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#274d38' } }).png().toBuffer();
  const requests = [];
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ grsaiKey: 'test-key', imageModel: 'gpt-image-2.5' }),
    requestJson: async (url, options) => {
      requests.push({ url, body: options.body });
      return { status: 'succeeded', results: [{ url: 'https://example.test/board.png' }] };
    },
    download: async () => boardBytes,
  });
  const project = { id: 'segment-provider', generationMode: 'segment-board', aspectRatio: '9:16', style: '电影写实', characters: [], scenes: [{ id: 's1', name: '夜雨车站', description: '夜晚站台' }], looks: [] };
  const reference = await providers.importImage(project, `data:image/png;base64,${boardBytes.toString('base64')}`);
  project.characters = [{ id: 'lin', name: '林晚', appearance: '黑色短发、米色风衣', reference, approved: true, version: 1, referenceVersion: 1 }];
  const segment = { id: 'seg1', number: 1, title: '雨夜重逢', duration: 15, boardTemplateId: 'classic-nine', shots: shots(5).map((shot, index) => ({ ...shot, id: `shot-${index + 1}`, number: index + 1, characterIds: ['lin'], backgroundActors: index === 0 ? '车站入口有三名乘客撑伞经过' : '', ...(index === 1 ? { dialogue: '你终于来了。', narration: '雨声停在门外。' } : {}) })) };
  const result = await providers.generateSegmentBoard(project, segment, 'business-1');
  assert.equal(requests.length, 1);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /ONE coherent landscape storyboard image/);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /exactly 5 distinct numbered panels/);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /三名乘客撑伞经过/);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /场景入口：先定场/);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /夜晚站台/);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /move-3/);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /沿动作轴自然切换/);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /声音元数据/);
  assert.doesNotMatch(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /你终于来了/);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /audio.*metadata|仅声音/i);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /subtitle|字幕/i);
  assert.match(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /speech bubble|对白框|气泡/i);
  assert.match(requests[0].body.prompt, /non-graphic cinematic depiction/);
  assert.doesNotMatch(requests[0].body.prompt, /血液|鲜血|血腥|断肢|肢解|斩首|割喉|内脏|尸体|自残|自杀|强奸|裸体|色情/);
  assert.equal(requests[0].body.images.length, 1);
  assert.match(requests[0].body.prompt, /Input images: Image 1 = 林晚\s*的当前身份参考图/);
  assert.match(requests[0].body.prompt, /不得复制三视图排版/);
  assert.doesNotMatch(requests[0].body.messages?.[0]?.content ?? requests[0].body.prompt ?? '', /right-side reference area|reference area/i);
  assert.equal(result.storyboardLayout.referenceStrip, 'none');
  assert.equal(result.storyboardLayout.boardWidth, 1600);
  assert.equal(Object.keys(result.shotImages).length, 5);
  for (const url of Object.values(result.shotImages)) {
    const file = path.join(root, project.id, url.split('/').at(-1));
    assert.ok((await stat(file)).isFile());
    const metadata = await sharp(file).metadata();
    assert.equal(metadata.width, 720);
    assert.equal(metadata.height, 1280);
  }
});

test('generateSegmentBoard crops horizontal projects to 1280x720 shots', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-board-landscape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boardBytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#274d38' } }).png().toBuffer();
  const requests = [];
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ grsaiKey: 'test-key', imageModel: 'gpt-image-2.5' }),
    requestJson: async (_url, options) => { requests.push({ body: options.body }); return { status: 'succeeded', results: [{ url: 'https://example.test/board.png' }] }; },
    download: async () => boardBytes,
  });
  const project = { id: 'segment-provider-landscape', generationMode: 'segment-board', aspectRatio: '16:9', style: '新闻纪实', characters: [], scenes: [{ id: 's1', name: '数据图表', description: '横向图表' }], looks: [] };
  const segment = { id: 'seg1', number: 1, title: '结果', duration: 15, boardTemplateId: 'classic-nine', shots: shots(3).map((shot, index) => ({ id: `shot-${index + 1}`, number: index + 1, ...shot })) };
  const result = await providers.generateSegmentBoard(project, segment, 'business-landscape');
  assert.equal(Object.hasOwn(requests[0].body,'images'), false);
  assert.match(requests[0].body.prompt, /Input images: none/);
  assert.equal(result.storyboardLayout.shotAspectRatio, '16:9');
  assert.equal(result.storyboardLayout.shotWidth, 1280);
  assert.equal(result.storyboardLayout.shotHeight, 720);
  assert.equal(result.storyboardLayout.annotationFree, true);
  assert.equal(result.storyboardLayout.annotationBandRemovedRatio, 0.18);
  const metadata = await sharp(await resolveMediaPath(root, project.id, result.shotImages['shot-1'])).metadata();
  assert.equal(metadata.width, 1280);
  assert.equal(metadata.height, 720);
});

test('segment-board prefers the current scene look reference over the identity image', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-board-look-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#274d38' } }).png().toBuffer();
  const requests = [];
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ grsaiKey: 'test-key', imageModel: 'gpt-image-2.5' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { status: 'succeeded', results: [{ url: 'https://example.test/board.png' }] }; },
    download: async () => bytes,
  });
  const project = { id: 'segment-look-reference', generationMode: 'segment-board', aspectRatio: '9:16', style: '电影写实', characters: [], scenes: [{ id: 's1', name: '夜雨车站', description: '夜晚站台' }], looks: [] };
  const identity = await providers.importImage(project, `data:image/png;base64,${bytes.toString('base64')}`);
  const look = await providers.importImage(project, `data:image/png;base64,${bytes.toString('base64')}`);
  project.characters = [{ id: 'lin', name: '林晚', appearance: '黑色短发', reference: identity, approved: true, version: 1, referenceVersion: 1 }];
  project.looks = [{ id: 'look-1', sceneId: 's1', characterId: 'lin', name: '雨夜风衣', appearance: '深色风衣', reference: look, approved: true, version: 2, referenceVersion: 2 }];
  const segment = { id: 'seg1', number: 1, title: '雨夜', duration: 15, boardTemplateId: 'classic-nine', shots: shots(3).map((shot, index) => ({ ...shot, id: `shot-${index + 1}`, number: index + 1, characterIds: ['lin'] })) };
  await providers.generateSegmentBoard(project, segment, 'business-look-reference');
  assert.equal(requests[0].images.length, 1);
  assert.match(requests[0].prompt, /Image 1 = 林晚 在场景「夜雨车站」的当前妆造三视图/);
});

test('segment-board video submission uses one complete storyboard task with ordered shots', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-board-video-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#131d16' } }).png().toBuffer();
  const shotBytes = await Promise.all(['#274d38', '#365c83', '#704744'].map(background => sharp({ create: { width: 720, height: 1280, channels: 3, background } }).png().toBuffer()));
  const requests = [];
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (url, options) => {
      requests.push({ url, body: options.body });
      return { id: 'video-task-1', status: 'queued', progress: 0 };
    },
    download: async () => imageBytes,
  });
  const project = { id: 'segment-video', generationMode: 'segment-board', aspectRatio: '9:16', style: '电影写实', characters: [], scenes: [{ id: 's1', name: '夜雨车站', description: '夜晚站台' }], looks: [] };
  const image = await providers.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  const shotImages = await Promise.all(shotBytes.map(bytes => providers.importImage(project, `data:image/png;base64,${bytes.toString('base64')}`)));
  const characterReference = await providers.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  project.characters = [{ id: 'lin', name: '林晚', appearance: '黑色短发、米色风衣', reference: characterReference, approved: true }];
  const segmentShots = shots(3).map((value, index) => ({ id: `shot-${index + 1}`, number: index + 1, ...value, characterIds: ['lin'], image: shotImages[index], approved: true, version: 1, imageVersion: 1, video: null, videoVersion: null, trimStart: 0 }));
  const segment = { id: 'seg1', number: 1, title: '雨夜重逢', duration: 15, storyboardImage: image, shots: segmentShots };
  project.segments = [segment];
  const result = await providers.submitSegmentVideo(project, segment, 'business-2');
  assert.equal(result.id, 'video-task-1');
  assert.equal(requests.length, 1);
  const body = requests[0].body;
  assert.equal(body.duration, 15);
   assert.equal(body.content[1].role, 'reference_image');
   assert.equal(body.content.length, 5);
   assert.notEqual(body.content[1].image_url.url, body.content[2].image_url.url, 'the ordered shot crops must remain distinct references');
   assert.notEqual(body.content[1].image_url.url, body.content[4].image_url.url, 'the board image must not be uploaded to the video model');
   assert.equal(body.content[3].role, 'reference_image');
   assert.equal(body.content[4].role, 'reference_image');
   assert.equal(body.content[2].role, 'reference_image');
   assert.match(body.content[0].text, /完整的 15 秒竖屏 9:16视频/);
   assert.match(body.content[0].text, /编号镜头必须按 1、2、3/);
   assert.match(body.content[0].text, /不是多个独立视频/);
  assert.match(body.content[0].text, /面板数量不是视频数量/);
  assert.match(body.content[0].text, /前镜结果.*后镜起始条件/);
  assert.match(body.content[0].text, /场景入口定场/);
  assert.match(body.content[0].text, /move-3/);
  assert.match(body.content[0].text, /沿动作轴自然切换/);
   assert.match(body.content[0].text, /audio.*metadata|仅声音/i);
   assert.match(body.content[0].text, /只有对应镜头明确写出的 dialogue/);
   assert.match(body.content[0].text, /禁止随机路人对白、群众闲聊/);
  assert.match(body.content[0].text, /backgroundActors.*吆喝.*叫卖.*环境人声/);
   assert.match(body.content[0].text, /subtitle|字幕/i);
  assert.match(body.content[0].text, /故事板上的编号|标签|文字.*视频|不得.*文字/i);
  assert.match(body.content[0].text, /残留少量审核文字.*擦除|忽略/);
  assert.match(body.content[0].text, /OCR.*文字|识别文字/);
  assert.match(body.content[0].text, /不得.*朗读.*转写.*翻译.*配音/);
  assert.doesNotMatch(body.content[0].text, /原文未提供，待确认创作设定/);
  assert.equal(body.generate_audio, undefined, 'MiniMax H3 V2 has no documented generate_audio request field; prompt guidance controls unintended voices');
   assert.equal(body.content[0].text.endsWith('与参考素材完全一致'), true);
});

test('segment-board keeps provider image limits without reintroducing the text-bearing board', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-board-video-limit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const boardBytes = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#131d16' } }).png().toBuffer();
  const shotBytes = await Promise.all(Array.from({ length: 12 }, (_, index) => sharp({ create: { width: 720, height: 1280, channels: 3, background: `hsl(${index * 25}, 35%, 35%)` } }).png().toBuffer()));
  const requests = [];
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { id: 'video-task-limit', status: 'queued' }; },
  });
  const project = { id: 'segment-video-limit', generationMode: 'segment-board', aspectRatio: '9:16', style: '电影写实', characters: [], scenes: [{ id: 's1', name: '夜雨车站', description: '夜晚站台' }], looks: [] };
  const board = await providers.importImage(project, `data:image/png;base64,${boardBytes.toString('base64')}`);
  const images = await Promise.all(shotBytes.map(bytes => providers.importImage(project, `data:image/png;base64,${bytes.toString('base64')}`)));
  const segment = { id: 'seg1', number: 1, title: '长片段', duration: 15, storyboardImage: board, shots: shots(12).map((value, index) => ({ id: `shot-${index + 1}`, number: index + 1, ...value, duration: 1.25, image: images[index] })) };
  await providers.submitSegmentVideo(project, segment, 'business-limit');
  const body = requests[0];
  assert.equal(body.content.length, 2, 'MiniMax reference mode should collapse an over-limit sequence into one clean reference image');
  assert.equal(body.content[1].role, 'first_frame');
  assert.notEqual(body.content[1].image_url.url, `data:image/png;base64,${boardBytes.toString('base64')}`);
  const sequence = Buffer.from(body.content[1].image_url.url.split(',')[1], 'base64');
  const metadata = await sharp(sequence).metadata();
  assert.equal(metadata.width, 720);
  assert.equal(metadata.height, 1708);
  assert.match(body.content[0].text, /前 12 张图片依次对应镜头 1 到 12/);
});

test('boss finisher guidance appears only for an explicit finale segment', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-boss-finisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#17243f' } }).png().toBuffer();
  const prompts = [];
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => {
      prompts.push(options.body.content[0].text);
      return { id: `boss-task-${prompts.length}`, status: 'queued' };
    },
    download: async () => imageBytes,
  });
  const baseProject = { id: 'boss-project', generationMode: 'segment-board', title: '终局', style: '国风仙侠 CG', aspectRatio: '9:16', characters: [], scenes: [{ id: 's1', name: '决战天门', description: '云海、断裂石台和蓝金光尘' }], looks: [] };
  const board = await providers.importImage(baseProject, `data:image/png;base64,${imageBytes.toString('base64')}`);
  const makeSegment = (title, summary) => ({ id: `segment-${title}`, number: 1, title, summary, duration: 15, storyboardImage: board, shots: shots(3).map((shot, index) => ({ ...shot, id: `shot-${title}-${index + 1}`, number: index + 1, image: board, approved: true, version: 1, imageVersion: 1 })) });
  await providers.submitSegmentVideo(baseProject, makeSegment('最后一击', '主角决战击败魔王，落地收尾'), 'boss-business');
  assert.match(prompts.at(-1), /Boss 战收尾模式/);
  await providers.submitSegmentVideo(baseProject, makeSegment('雨夜相逢', '两个人在屋檐下交谈'), 'normal-business');
  assert.doesNotMatch(prompts.at(-1), /Boss 战收尾模式/);
});

test('boss finisher guidance is limited to the last qualifying finale segment', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-boss-frequency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const imageBytes = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#17243f' } }).png().toBuffer();
  const prompts = [];
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { prompts.push(options.body.content[0].text); return { id: `boss-frequency-${prompts.length}`, status: 'queued' }; },
    download: async () => imageBytes,
  });
  const project = { id: 'boss-frequency-project', generationMode: 'segment-board', title: '魔王终局', style: '国风仙侠 CG', aspectRatio: '9:16', characters: [], scenes: [{ id: 's1', name: '决战天门', description: '云海、断裂石台和蓝金光尘' }], looks: [] };
  const board = await providers.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  const makeSegment = (id, number, title, summary) => ({ id, number, title, summary, duration: 15, storyboardImage: board, shots: shots(3).map((shot, index) => ({ ...shot, id: `${id}-shot-${index + 1}`, number: index + 1, image: board, approved: true, version: 1, imageVersion: 1 })) });
  const early = makeSegment('early', 1, '小战收束', '主角击败魔王手下，战斗暂时结束');
  const finale = makeSegment('finale', 2, '最后一击', '主角决战击败魔王，落地收尾');
  project.segments = [early, finale];
  await providers.submitSegmentVideo(project, early, 'boss-frequency-early');
  await providers.submitSegmentVideo(project, finale, 'boss-frequency-finale');
  assert.doesNotMatch(prompts[0], /Boss 战收尾模式/);
  assert.match(prompts[1], /Boss 战收尾模式/);
});

test('segment-board video uploads character references for MiniMax and Ark', async t => {
  const cases = [
    { model: 'MiniMax-H3', keyName: 'minimaxKey', key: 'minimax-test-key', url: 'https://api.minimax.cn/v2/video_generation', result: { task_id: 'minimax-segment-task' } },
    { model: 'doubao-seedance-2-5', keyName: 'arkKey', key: 'ark-test-key', url: 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks', result: { id: 'ark-segment-task', status: 'queued' } },
  ];
  for (const item of cases) {
    const root = await mkdtemp(path.join(tmpdir(), `aiframe-segment-board-${item.model}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const requests = [];
    const imageBytes = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#274d38' } }).png().toBuffer();
    const providers = createProviders({
      mediaRoot: root,
      getSettings: () => ({ [item.keyName]: item.key, videoModel: item.model }),
      requestJson: async (url, options) => { requests.push({ url, body: options.body }); return item.result; },
      download: async () => imageBytes,
    });
    const project = { id: `segment-${item.model}`, generationMode: 'segment-board', aspectRatio: '9:16', style: '电影写实', characters: [], scenes: [{ id: 's1', name: '夜雨车站', description: '夜晚站台' }], looks: [] };
    const board = await providers.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
    const characterReference = await providers.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
    project.characters = [{ id: 'lin', name: '林晚', appearance: '黑色短发、米色风衣', reference: characterReference, approved: true }];
    const segment = { id: 'seg1', number: 1, title: '雨夜重逢', duration: 15, storyboardImage: board, shots: shots(3).map((value, index) => ({ id: `shot-${index + 1}`, number: index + 1, ...value, characterIds: ['lin'], image: board })) };
    await providers.submitSegmentVideo(project, segment, `business-${item.model}`);
    assert.equal(requests[0].url, item.url);
    const body = requests[0].body;
    assert.equal(body.content[0].text.endsWith('与参考素材完全一致'), true);
    assert.match(body.content[0].text, /OCR.*文字|识别文字/);
    assert.match(body.content[0].text, /不得.*朗读.*转写.*翻译.*配音/);
     assert.equal(body.content[1].role, item.keyName === 'minimaxKey' ? 'reference_image' : 'first_frame');
    assert.equal(body.content[2].role, 'reference_image');
    assert.equal(body.content[3].role, 'reference_image');
    assert.equal(body.content[4].role, 'reference_image');
    assert.equal(body.content.length, 5);
  }
});

test('every configured video model accepts the shared fifteen-second storyboard ceiling', async t => {
  const imageBytes = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#274d38' } }).png().toBuffer();
  const dataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`;
  for (const option of listVideoOptions()) {
    if (option.minDurationSeconds === option.maxDurationSeconds && option.minDurationSeconds !== 15) continue;
    const root = await mkdtemp(path.join(tmpdir(), `aiframe-video-model-${option.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const requests = [];
    const settings = option.provider === 'MiniMax'
      ? { minimaxKey: 'minimax-test-key' }
      : option.provider === '熊猫Ai'
        ? { xiongmaoMinimaxH3Key: 'xiongmao-test-key' }
        : { arkKey: 'ark-test-key' };
    const providers = createProviders({
      mediaRoot: root,
      getSettings: () => ({ ...settings, videoModel: option.id }),
      requestJson: async (url, request) => {
        requests.push({ url, body: request.body });
        return option.provider === '火山方舟'
          ? { id: `task-${option.id}`, status: 'queued' }
          : { task_id: `task-${option.id}`, status: 'queued' };
      },
      requestMultipartJson: async () => ({ url: 'https://cdn.example/reference.png' }),
    });
    const project = {
      id: `model-${option.id}`,
      generationMode: 'segment-board',
      aspectRatio: '9:16',
      style: '电影写实',
      characters: [],
      scenes: [{ id: 's1', name: '夜雨车站', description: '夜晚站台' }],
      looks: [],
    };
    const image = await providers.importImage(project, dataUrl);
    const segment = {
      id: 'seg1', number: 1, title: '雨夜重逢', duration: 15, storyboardImage: image,
      shots: shots(3).map((shot, index) => ({ ...shot, id: `shot-${index + 1}`, number: index + 1, duration: 5, image })),
    };
    await providers.submitSegmentVideo(project, segment, `business-${option.id.replace(/[^A-Za-z0-9_-]/g, '-')}`);
    const videoRequest = requests.at(-1);
    assert.ok(videoRequest, `${option.id} should submit a video task`);
    assert.equal(videoRequest.body.duration, 15, `${option.id} must receive a fifteen-second task`);
  }
});

test('Ark leaves generated audio to prompt guidance for both dialogue and crowd scenes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-audio-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const imageBytes = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#274d38' } }).png().toBuffer();
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ arkKey: 'ark-test-key', videoModel: 'doubao-seedance-2-5' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { id: `ark-audio-${requests.length}`, status: 'queued' }; },
    download: async () => imageBytes,
  });
  const project = { id: 'segment-audio-intent', generationMode: 'segment-board', aspectRatio: '9:16', style: '电影写实', characters: [], scenes: [{ id: 's1', name: '集市', description: '人群往来' }], looks: [] };
  const board = await providers.importImage(project, `data:image/png;base64,${imageBytes.toString('base64')}`);
  const makeSegment = (dialogue, backgroundActors) => ({ id: `seg-${requests.length}`, number: 1, title: '集市', duration: 15, storyboardImage: board, shots: shots(3).map((value, index) => ({ ...value, id: `shot-${requests.length}-${index}`, number: index + 1, image: board, dialogue: index === 0 ? dialogue : '', backgroundActors: index === 0 ? backgroundActors : '' })) });
  await providers.submitSegmentVideo(project, makeSegment('', '摊贩大声吆喝，路人回应叫卖声'), 'audio-crowd');
  assert.equal(Object.hasOwn(requests[0], 'generate_audio'), false);
  assert.match(requests[0].content[0].text, /摊贩大声吆喝.*路人回应叫卖声/);
  assert.match(requests[0].content[0].text, /backgroundActors 明确写出吆喝、叫卖/);
  await providers.submitSegmentVideo(project, makeSegment('', '三名路人安静经过'), 'audio-silent');
  assert.equal(Object.hasOwn(requests[1], 'generate_audio'), false);
  assert.match(requests[1].content[0].text, /三名路人安静经过/);
  assert.match(requests[1].content[0].text, /否则群众不发声/);
});

test('segment-board accepts a content-sized duration shorter than the 15 second preset', async () => {
  const { validateSegment } = await import('../server/domain.mjs');
  const segment = { duration: 8, shots: shots(3).map((shot, index) => ({ ...shot, duration: index === 2 ? 2 : 3 })) };
  assert.equal(validateSegment(segment, { generationMode: 'segment-board' }), segment);
});

test('service completes one storyboard job and leaves the board and cropped shots awaiting review', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-board-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let boardCalls = 0;
  const providers = {
    analyze: async () => analysis(5),
    generateSegmentBoard: async (project, segment) => ({
      storyboardImage: `/media/${project.id}/board-${++boardCalls}.png`,
      storyboardLayout: { columns: 3, rows: 2 },
      shotImages: Object.fromEntries(segment.shots.map(shot => [shot.id, `/media/${project.id}/${shot.id}.png`])),
    }),
  };
  const service = await createService({ dataDir: root, providers, pollIntervalMs: 1 });
  t.after(() => service.close());
  const created = await service.create({ title: '整板服务', novel: '雨夜重逢', duration: 15, generationMode: 'segment-board' });
  await service.analyze(created.id);
  let project = await waitFor(service, created.id, value => value.segments.length === 1 && value.jobs.at(-1)?.status === 'completed');
  const segment = project.segments[0];
  await service.segmentAction(project.id, segment.id, 'generate-images');
  project = await waitFor(service, project.id, value => value.jobs.some(job => job.kind === 'storyboard' && job.status === 'completed'));
  assert.equal(project.jobs.filter(job => job.kind === 'storyboard').length, 1);
  assert.equal(project.jobs.filter(job => job.kind === 'image').length, 0);
  assert.ok(project.segments[0].storyboardImage);
  assert.equal(project.segments[0].storyboardApproved, false);
  assert.equal(project.segments[0].shots.length, 5);
  assert.ok(project.segments[0].shots.every(shot => shot.image && shot.imageVersion === shot.version && shot.approved === false));
  const jobCount = project.jobs.length;
  await service.segmentAction(project.id, segment.id, 'generate-images', { reuseExisting: true });
  project = await service.get(project.id);
  assert.equal(project.jobs.length, jobCount);
  await service.segmentAction(project.id, segment.id, 'generate-images');
  project = await waitFor(service, project.id, value => value.jobs.filter(job => job.kind === 'storyboard' && job.status === 'completed').length === 2);
  assert.equal(boardCalls, 2);
  assert.equal(project.segments[0].storyboardImage, `/media/${project.id}/board-2.png`);
  assert.equal(project.segments[0].storyboardApproved, false);
});

test('segment-board creates one complete segment-video job and one ledger record', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-video-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providers = {
    analyze: async () => analysis(5),
    generateSegmentBoard: async (project, segment) => ({
      storyboardImage: `/media/${project.id}/board.png`,
      storyboardLayout: { columns: 3, rows: 2 },
      shotImages: Object.fromEntries(segment.shots.map(shot => [shot.id, `/media/${project.id}/${shot.id}.png`]))
    }),
     getVideoModel: () => 'MiniMax-H3',
    submitSegmentVideo: async () => ({ id: 'segment-video-task', status: 'queued' }),
    pollVideo: async () => ({ id: 'segment-video-task', status: 'completed', url: 'https://example.test/segment.mp4', duration: 15 }),
    downloadVideo: async project => `/media/${project.id}/segment.mp4`
  };
  const service = await createService({ dataDir: root, providers, pollIntervalMs: 1 });
  t.after(() => service.close());
  const created = await service.create({ title: '完整片段视频', novel: '雨夜重逢', duration: 15, generationMode: 'segment-board' });
  await service.analyze(created.id);
  let project = await waitFor(service, created.id, value => value.segments.length === 1 && value.jobs.at(-1)?.status === 'completed');
  const segment = project.segments[0];
  await service.segmentAction(project.id, segment.id, 'generate-images');
  project = await waitFor(service, project.id, value => value.jobs.some(job => job.kind === 'storyboard' && job.status === 'completed'));
  await service.segmentAction(project.id, segment.id, 'approve');
  project = await service.segmentAction(project.id, segment.id, 'generate-videos');
  assert.equal(project.jobs.filter(job => job.kind === 'segment-video').length, 1);
  assert.equal(project.jobs.filter(job => job.kind === 'video').length, 0);
  project = await waitFor(service, project.id, value => value.jobs.some(job => job.kind === 'segment-video' && job.status === 'completed'));
  assert.ok(project.segments[0].video);
  assert.equal(project.segments[0].videoVersion, project.jobs.find(job => job.kind === 'segment-video')?.inputVersion);
  assert.equal(project.segments[0].shots.every(shot => shot.video === null), true);
  const ledger = await service.ledger();
  assert.equal(ledger.filter(record => record.recordType === 'segment-video').length, 1);

  const regenerated = await service.segmentAction(project.id, segment.id, 'generate-videos', { reuseExisting: false });
  assert.equal(regenerated.jobs.filter(job => job.kind === 'segment-video').length, 2);
  project = await waitFor(service, project.id, value => value.jobs.filter(job => job.kind === 'segment-video' && job.status === 'completed').length === 2);
  const versionedLedger = await service.ledger();
  assert.equal(versionedLedger.filter(record => record.recordType === 'segment-video').length, 2);
});

test('traditional mode submits one segment video with scene, current look and prop references', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-traditional-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = await sharp({ create: { width: 720, height: 1280, channels: 3, background: '#274d38' } }).png().toBuffer();
  const requests = [];
  const providers = createProviders({
    mediaRoot: root,
    getSettings: () => ({ minimaxKey: 'test-key', videoModel: 'MiniMax-H3' }),
    requestJson: async (_url, options) => { requests.push(options.body); return { task_id: 'traditional-task', status: 'queued' }; },
    download: async () => bytes,
  });
  const project = {
    id: 'traditional-provider', generationMode: 'segment-board', videoMode: 'traditional', aspectRatio: '9:16',
    style: '电影写实', sourceType: 'script', visualStyle: 'photorealistic', characters: [], scenes: [], looks: [], assets: [],
  };
  const reference = async () => providers.importImage(project, `data:image/png;base64,${bytes.toString('base64')}`);
  const [sceneOne, sceneTwo, linIdentity, linRain, linNight, meiLook, sword] = await Promise.all([
    reference(), reference(), reference(), reference(), reference(), reference(), reference(),
  ]);
  project.characters = [
    { id: 'lin', name: '林晚', appearance: '黑发，清瘦', reference: linIdentity, approved: true, version: 1, referenceVersion: 1 },
    { id: 'mei', name: '梅姨', appearance: '银发，沉稳', reference: linIdentity, approved: true, version: 1, referenceVersion: 1 },
  ];
  project.scenes = [
    { id: 's1', name: '雨夜车站', description: '夜晚站台', reference: sceneOne, approved: true, version: 1, referenceVersion: 1 },
    { id: 's2', name: '清晨巷口', description: '清晨巷口', reference: sceneTwo, approved: true, version: 1, referenceVersion: 1 },
  ];
  project.looks = [
    { id: 'look-lin-rain', sceneId: 's1', characterId: 'lin', name: '雨夜风衣', appearance: '深色风衣', reference: linRain, approved: true, version: 1, referenceVersion: 1 },
    { id: 'look-lin-night', sceneId: 's2', characterId: 'lin', name: '清晨便装', appearance: '浅色便装', reference: linNight, approved: true, version: 1, referenceVersion: 1 },
    { id: 'look-mei-night', sceneId: 's2', characterId: 'mei', name: '清晨长衫', appearance: '灰色长衫', reference: meiLook, approved: true, version: 1, referenceVersion: 1 },
  ];
  project.assets = [{ id: 'sword', name: '旧剑', kind: 'weapon', description: '有缺口的长剑', reference: sword, approved: true, version: 1, referenceVersion: 1 }];
  const segment = {
    id: 'seg-traditional', number: 1, title: '巷口交锋', duration: 15,
    shots: [
      { ...shots(1)[0], id: 'shot-1', number: 1, sceneId: 's1', characterIds: ['lin'], assetIds: ['sword'], duration: 5 },
      { ...shots(1)[0], id: 'shot-2', number: 2, sceneId: 's2', characterIds: ['lin', 'mei'], assetIds: [], duration: 5 },
      { ...shots(1)[0], id: 'shot-3', number: 3, sceneId: 's2', characterIds: ['mei'], assetIds: [], duration: 5 },
    ],
  };
  await providers.submitSegmentVideo(project, segment, 'traditional-business');
  assert.equal(requests.length, 1);
  const body = requests[0];
  const prompt = body.content[0].text;
  const imageInputs = body.content.filter(item => item.type === 'image_url');
  assert.equal(imageInputs.length, 6, 'two scene references, three scene-specific looks and one prop must be submitted');
  assert.ok(imageInputs.every(item => item.role === 'reference_image'));
  assert.match(prompt, /传统多参考图模式/);
  assert.doesNotMatch(prompt, /九宫格/);
  assert.match(prompt, /镜头 1/);
  assert.match(prompt, /对白（仅声音）/);

  const xiongmaoRequests = [];
  const xiongmao = createProviders({
    mediaRoot: root,
    getSettings: () => ({ xiongmaoMinimaxH3Key: 'test-key', videoModel: 'xiongmao-minimaxh3' }),
    requestJson: async (_url, options) => { xiongmaoRequests.push(options.body); return { task_id: 'traditional-xiongmao-task', status: 'queued' }; },
    requestMultipartJson: async () => ({ url: 'https://example.test/reference.png' }),
  });
  await xiongmao.submitSegmentVideo(project, { ...segment, shots: segment.shots.slice(0, 1) }, 'traditional-xiongmao-business');
  assert.equal(xiongmaoRequests[0].mode, 'reference', 'traditional mode must never treat its scene reference as a first frame');

  project.scenes[0].approved = false;
  await assert.rejects(
    providers.submitSegmentVideo(project, segment, 'traditional-missing-scene'),
    error => error.code === 'SCENE_NOT_APPROVED',
  );
  assert.equal(requests.length, 1, 'missing scene approval must stop before another provider request');
});

test('traditional mode creates one segment-video job without storyboard generation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-traditional-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const traditionalAnalysis = {
    characters: [{ id: 'lin', name: '林晚', role: 'protagonist', aliases: [], appearance: '黑发，清瘦', evidence: '林晚走进雨夜车站' }],
    scenes: [{ id: 's1', name: '雨夜车站', description: '夜晚站台' }],
    looks: [{ id: 'look-1', sceneId: 's1', characterId: 'lin', name: '雨夜风衣', appearance: '深色风衣' }],
    segments: [{ title: '雨夜重逢', summary: '林晚在车站重逢', duration: 15, shots: shots(3).map((shot, index) => ({ ...shot, duration: 5, characterIds: ['lin'], sceneId: 's1', dialogue: index === 1 ? '你终于来了。' : '' })) }],
  };
  let submitCalls = 0;
  const providers = {
    analyze: async () => structuredClone(traditionalAnalysis),
    getVideoModel: () => 'MiniMax-H3',
    importImage: async project => `/media/${project.id}/reference-${Math.random().toString(16).slice(2)}.png`,
    submitSegmentVideo: async project => { submitCalls += 1; assert.equal(project.videoMode, 'traditional'); assert.equal(project.segments[0].storyboardImage, null); return { id: 'traditional-service-task', status: 'queued' }; },
    pollVideo: async () => ({ id: 'traditional-service-task', status: 'completed', url: 'https://example.test/traditional.mp4', duration: 15 }),
    downloadVideo: async project => `/media/${project.id}/traditional.mp4`,
  };
  const service = await createService({ dataDir: root, providers, pollIntervalMs: 1 });
  t.after(() => service.close());
  const created = await service.create({ title: '传统模式服务', novel: '雨夜重逢', duration: 15, generationMode: 'segment-board', videoMode: 'traditional' });
  assert.equal(created.videoMode, 'traditional');
  await service.analyze(created.id);
  let project = await waitFor(service, created.id, value => value.jobs.at(-1)?.status === 'completed');
  const segment = project.segments[0];
  assert.equal(segment.storyboardImage, null);
  assert.equal(project.jobs.some(job => job.kind === 'storyboard'), false);
  const character = project.characters[0];
  await service.characterAction(project.id, character.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  await service.characterAction(project.id, character.id, 'approve');
  const scene = project.scenes[0];
  await service.sceneAction(project.id, scene.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  await service.sceneAction(project.id, scene.id, 'approve');
  const look = project.looks[0];
  await service.lookAction(project.id, look.id, 'upload', { dataUrl: 'data:image/png;base64,AA==' });
  await service.lookAction(project.id, look.id, 'approve');
  project = await service.segmentAction(project.id, segment.id, 'approve');
  project = await service.segmentAction(project.id, segment.id, 'generate-videos');
  assert.equal(project.jobs.filter(job => job.kind === 'segment-video').length, 1);
  assert.equal(project.jobs.filter(job => job.kind === 'video').length, 0);
  project = await waitFor(service, project.id, value => value.jobs.some(job => job.kind === 'segment-video' && job.status === 'completed'));
  assert.equal(submitCalls, 1);
  assert.ok(project.segments[0].video);
});

test('segment video model minimums are rejected before a task is queued', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-segment-video-minimum-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let submitCalls = 0;
  const shortAnalysis = {
    characters: [],
    scenes: [{ id: 's1', name: '夜雨车站', description: '夜晚站台' }],
    looks: [],
    segments: [{ title: '短片段', summary: '三秒节奏片段', duration: 3, shots: shots(3).map(shot => ({ ...shot, duration: 1 })) }],
  };
  const providers = {
    analyze: async () => structuredClone(shortAnalysis),
    generateSegmentBoard: async (project, segment) => ({
      storyboardImage: `/media/${project.id}/board.png`,
      storyboardLayout: { columns: 3, rows: 1 },
      shotImages: Object.fromEntries(segment.shots.map(shot => [shot.id, `/media/${project.id}/${shot.id}.png`])),
    }),
    getVideoModel: () => 'MiniMax-H3',
    submitSegmentVideo: async () => { submitCalls += 1; return { id: 'should-not-submit', status: 'queued' }; },
    pollVideo: async () => ({ id: 'should-not-submit', status: 'completed', url: 'https://example.test/should-not-submit.mp4' }),
    downloadVideo: async project => `/media/${project.id}/segment.mp4`,
  };
  const service = await createService({ dataDir: root, providers, pollIntervalMs: 1 });
  t.after(() => service.close());
  const created = await service.create({ title: '最小时长校验', novel: '短片段', duration: 15, generationMode: 'segment-board' });
  await service.analyze(created.id);
  let project = await waitFor(service, created.id, value => value.jobs.at(-1)?.status === 'completed');
  const segment = project.segments[0];
  await service.segmentAction(project.id, segment.id, 'generate-images');
  project = await waitFor(service, project.id, value => value.jobs.some(job => job.kind === 'storyboard' && job.status === 'completed'));
  await service.segmentAction(project.id, segment.id, 'approve');
  await assert.rejects(
    service.segmentAction(project.id, segment.id, 'generate-videos', { videoModel: 'MiniMax-H3' }),
    error => error.code === 'VIDEO_DURATION_UNSUPPORTED' && /4 到 15 秒/.test(error.message),
  );
  project = await service.get(project.id);
  assert.equal(project.jobs.some(job => job.kind === 'segment-video'), false);
  assert.equal(submitCalls, 0);
});

async function waitFor(service, id, predicate) {
  for (let i = 0; i < 100; i += 1) {
    const project = await service.get(id);
    if (predicate(project)) return project;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('片段整板任务未在限定时间内完成');
}

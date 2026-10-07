import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateAnalysis, validateSegment, updateShotFields } from '../server/domain.mjs';

function analysis(duration = 30) {
  return { characters: [{ id: 'hero', name: '林遥', role: 'protagonist', aliases: [], appearance: '蓝色外套', evidence: '林遥走进书店。' }], segments: [{ title: '归来', summary: '重逢', duration, shots: Array.from({ length: 9 }, (_, i) => ({ scene: '书店', action: '抬头', camera: '近景', dialogue: '', characterIds: ['hero'], duration: i === 8 ? duration - 8 * 3 : 3 })) }] };
}

test('analysis requires exactly nine shots, valid character references and exact segment duration', () => {
  const project = createProject({ title: '作品', novel: '正文', duration: 30 });
  const result = validateAnalysis(analysis(), project);
  assert.equal(result.segments[0].shots.length, 9);
  assert.equal(result.segments[0].shots.reduce((n, s) => n + s.duration, 0), 30);
  assert.throws(() => validateAnalysis({ ...analysis(), segments: [{ ...analysis().segments[0], shots: analysis().segments[0].shots.slice(1) }] }, project), /9/);
  const unknown = analysis(); unknown.segments[0].shots[0].characterIds = ['missing'];
  assert.throws(() => validateAnalysis(unknown, project), /角色/);
  const wrong = analysis(); wrong.segments[0].shots[0].duration = 2;
  assert.throws(() => validateAnalysis(wrong, project), /时长/);
});

test('input validation rejects structural and unsafe values; flexible edits are checked at approval', () => {
  assert.throws(() => createProject({ title: '', novel: 'text' }), /标题/);
  assert.throws(() => createProject({ title: 'x', duration: 22 }), /15|30/);
  const project = createProject({ title: 'x', novel: '正文' });
  Object.assign(project, validateAnalysis(analysis(), project));
  const shot = project.segments[0].shots[0];
  assert.throws(() => updateShotFields(shot, { duration: 16 }, project.characters), /时长/);
  assert.throws(() => updateShotFields(shot, { characterIds: ['unknown'] }, project.characters), /角色/);
  updateShotFields(shot, { duration: 2 }, project.characters);
  assert.throws(() => validateSegment(project.segments[0]), /时长/);
});

test('visual media style is an explicit project constraint with legacy photorealistic fallback', () => {
  const legacy = createProject({ title: '旧项目', novel: '正文' });
  assert.equal(legacy.visualStyle, 'photorealistic');
  assert.equal(createProject({ title: '二维', novel: '正文', visualStyle: '2d-animation' }).visualStyle, '2d-animation');
  assert.equal(createProject({ title: '三维', novel: '正文', visualStyle: '3d-animation' }).visualStyle, '3d-animation');
  assert.throws(() => createProject({ title: '未知', novel: '正文', visualStyle: 'comic' }), /视觉媒介/);
});

test('universal content projects accept landscape output and evidence-backed empty casts', () => {
  const project = createProject({ title: '研究报告视频', novel: '研究显示，样本在三个月内下降。', sourceType: 'paper', aspectRatio: '16:9', generationMode: 'segment-board', duration: 15 });
  const input = {
    characters: [],
    scenes: [{ id: 'chart', name: '数据图表', description: '论文结果图，时间轴为三个月' }],
    looks: [],
    segments: [{
      title: '结果变化', summary: '展示样本变化', duration: 15,
      shots: Array.from({ length: 3 }, (_, index) => ({
        sceneId: 'chart', scene: '数据图表', action: `显示第 ${index + 1} 个时间点`, camera: '横向全景', dialogue: '', characterIds: [],
        sourceEvidence: '研究显示，样本在三个月内下降。', duration: 5,
      })),
    }],
  };
  const result = validateAnalysis(input, project);
  assert.equal(project.sourceType, 'paper');
  assert.equal(project.aspectRatio, '16:9');
  assert.deepEqual(result.characters, []);
  assert.ok(result.segments[0].shots.every(shot => shot.characterIds.length === 0 && shot.sourceEvidence.includes('样本')));
});

test('a storyboard cannot approve more character references than the image provider accepts', () => {
  const characters = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}` }));
  const shot = { scene: '', action: '', camera: '', dialogue: '', duration: 3, trimStart: 0, characterIds: [] };
  assert.throws(() => updateShotFields(shot, { characterIds: characters.map(c => c.id) }, characters), /9|角色/);
  updateShotFields(shot, { characterIds: characters.slice(0, 9).map(c => c.id) }, characters);
  assert.equal(shot.characterIds.length, 9);
});

test('automatic duration accepts mixed 15 and 30 second segments while fixed mode rejects them', () => {
  const short = analysis(15).segments[0];
  short.shots = short.shots.map((shot, index) => ({ ...shot, duration: index === 8 ? 3 : 1.5 }));
  const mixed = { ...analysis(), segments: [short, analysis(30).segments[0]] };
  const auto = createProject({ title: '自动节奏', novel: '正文', durationMode: 'auto' });
  assert.equal(auto.durationMode, 'auto');
  assert.deepEqual(validateAnalysis(mixed, auto).segments.map(s => s.duration), [15, 30]);
  const fixed = createProject({ title: '固定节奏', novel: '正文', duration: 30 });
  assert.equal(fixed.durationMode, 'fixed');
  assert.throws(() => validateAnalysis(mixed, fixed), /时长/);
  assert.throws(() => createProject({ title: '无效模式', durationMode: 'random' }), /时长模式/);
  const invalid = structuredClone(mixed); invalid.segments[0].duration = 20;
  assert.throws(() => validateAnalysis(invalid, auto), /15|30/);
});

test('analysis preserves scene-specific looks and rejects ambiguous or unknown references', () => {
  const project=createProject({title:'换装',novel:'正文'}),input=analysis();
  input.scenes=[{id:'day',name:'白天书店',description:'营业中'},{id:'night',name:'夜晚街头',description:'离店后'}];
  input.looks=[{id:'blue',sceneId:'day',characterId:'hero',name:'蓝外套',appearance:'蓝色外套'},{id:'red',sceneId:'night',characterId:'hero',name:'红礼服',appearance:'红色礼服'}];
  input.segments[0].shots.forEach((shot,i)=>{shot.sceneId=i<5?'day':'night';});
  const result=validateAnalysis(input,project);
  assert.equal(project.workflowVersion,2);assert.deepEqual(project.scenes,[]);assert.deepEqual(project.looks,[]);
  assert.equal(result.looks.length,2);assert.ok(result.looks.every(look=>look.reference===null&&!look.approved&&look.version===1));
  assert.deepEqual(result.segments[0].shots.map(shot=>shot.sceneId),['day','day','day','day','day','night','night','night','night']);
  const invalid=structuredClone(input);invalid.segments[0].shots[0].sceneId='unknown';
  assert.throws(()=>validateAnalysis(invalid,project),/场景/);
  const duplicate=structuredClone(input);duplicate.looks.push({...duplicate.looks[0],id:'duplicate'});
  assert.throws(()=>validateAnalysis(duplicate,project),/重复|唯一/);
  const wrong=structuredClone(input);wrong.looks[0].characterId='unknown';assert.throws(()=>validateAnalysis(wrong,project),/角色/);
});

test('analysis without new scene fields creates unapproved drafts without reusing identity portraits',()=>{
  const project=createProject({title:'兼容分析',novel:'正文'}),result=validateAnalysis(analysis(),project);
  assert.equal(result.scenes.length,1);assert.equal(result.looks.length,1);
  assert.ok(result.segments[0].shots.every(shot=>shot.sceneId===result.scenes[0].id));
  assert.equal(result.looks[0].reference,null);assert.equal(result.looks[0].approved,false);
  assert.match(result.looks[0].appearance,/待确认/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_GUIDANCE, ANALYSIS_COMPLETION_GUIDANCE, SHOT_PLANNING_GUIDANCE, SEGMENT_VIDEO_GUIDANCE, VIDEO_GUIDANCE, BOSS_FINISHER_GUIDANCE, NO_BURNED_TEXT_GUIDANCE, inferProjectWorldGuidance, inferCharacterSubjectForm, characterSubjectInstruction, IDENTITY_GUIDANCE } from '../server/prompt-guidance.mjs';

test('project world guidance locks cultivation projects away from accidental modern wardrobe', () => {
  const guidance = inferProjectWorldGuidance({ title: '逐我出宗', style: '写实电影质感', novel: '少年被逐出宗门，体内灵根觉醒，准备御剑渡劫。' });
  assert.match(guidance, /xianxia|immortal-cultivation/i);
  assert.match(guidance, /ancient Chinese|ancient-fantasy/i);
  assert.match(guidance, /T-shirts|hoodies|denim jeans|sneakers/i);
  assert.match(guidance, /explicit.*wardrobe evidence.*priority/i);
});

test('project world guidance keeps unspecified projects restrained instead of assuming modern fashion', () => {
  const guidance = inferProjectWorldGuidance({ title: '无名项目', style: '电影写实', novel: '一个人走进房间。' });
  assert.match(guidance, /does not establish a specific era/i);
  assert.match(guidance, /do not infer modern fashion/i);
});

test('project world guidance recognizes cultivation terminology beyond the word xianxia', () => {
  const guidance = inferProjectWorldGuidance({ title: '飞升之前', style: '电影写实', novel: '她在阵法中炼丹，等待渡劫飞升。' });
  assert.match(guidance, /xianxia|immortal-cultivation/i);
  assert.match(guidance, /ancient Chinese|ancient-fantasy/i);
  assert.match(guidance, /contemporary T-shirts|hoodies|denim jeans|sneakers/i);
});

test('occupation words containing beasts do not change a human subject into a creature', () => {
  const character = { name: '御兽总厨', appearance: '精通灵兽膳食，身着厨师服，双手持锅', evidence: '他在后厨为灵兽准备灵膳。' };
  assert.equal(inferCharacterSubjectForm(character), 'human');
  assert.match(characterSubjectInstruction(character), /occupation|animal anatomy/i);
  assert.match(IDENTITY_GUIDANCE, /Occupation is not anatomy/);
});

test('shot planning guidance routes scene modes and maps planning into the current shot contract', () => {
  assert.match(SHOT_PLANNING_GUIDANCE, /动作、对白对峙、混合、旁白讲解/);
  assert.match(SHOT_PLANNING_GUIDANCE, /发起.*防守\/闪避\/命中.*接触与受力/);
  assert.match(SHOT_PLANNING_GUIDANCE, /施压.*承受.*泄露或反制/);
  assert.match(SHOT_PLANNING_GUIDANCE, /资产锚点/);
  assert.match(SHOT_PLANNING_GUIDANCE, /宏大或首次进入的场景必须先定场/);
  assert.match(SHOT_PLANNING_GUIDANCE, /微动作、表情和情绪结果/);
  assert.match(SHOT_PLANNING_GUIDANCE, /duration/);
  assert.match(ANALYSIS_GUIDANCE, /每镜只描述一个时刻/);
});

test('analysis completion guidance permits only source-bound visual inference', () => {
  assert.match(ANALYSIS_COMPLETION_GUIDANCE, /最小必要推断/);
  assert.match(ANALYSIS_COMPLETION_GUIDANCE, /起始状态.*可见动作\/反应.*结果状态/);
  assert.match(ANALYSIS_COMPLETION_GUIDANCE, /禁止新增人物、地点/);
  assert.match(ANALYSIS_COMPLETION_GUIDANCE, /dialogue 和 narration 为空字符串/);
});

test('boss finisher guidance keeps impact causal and conditional', () => {
  assert.match(BOSS_FINISHER_GUIDANCE, /蓄力或起势.*闪现\/加速.*命中瞬间.*受击位移/);
  assert.match(BOSS_FINISHER_GUIDANCE, /move-45.*move-50.*move-52/);
  assert.match(BOSS_FINISHER_GUIDANCE, /含蓄的视觉冲击表现/);
});

test('video guidance turns approved shot plans into a continuous timeline', () => {
  assert.match(VIDEO_GUIDANCE, /已批准的分镜按编号整理成时间轴/);
  assert.match(VIDEO_GUIDANCE, /前镜的动作结果.*后镜的起始条件/);
  assert.match(VIDEO_GUIDANCE, /环境声、脚步、衣料/);
  assert.match(VIDEO_GUIDANCE, /dialogue 字段明确写出的台词/);
  assert.match(VIDEO_GUIDANCE, /禁止随机路人对白、群众闲聊/);
  assert.match(VIDEO_GUIDANCE, /narration 为空时禁止额外旁白/);
  assert.doesNotMatch(VIDEO_GUIDANCE, /输出 JSON/);
  assert.match(SEGMENT_VIDEO_GUIDANCE, /面板数量不是视频数量/);
  assert.match(SEGMENT_VIDEO_GUIDANCE, /不跳号、倒序、重复、分屏/);
  assert.match(SEGMENT_VIDEO_GUIDANCE, /只有对应镜头明确写出的 dialogue/);
  assert.match(SEGMENT_VIDEO_GUIDANCE, /backgroundActors.*吆喝.*叫卖.*环境人声/);
});

test('video guidance allows natural mouth movement but blocks unplanned speech', () => {
  assert.match(VIDEO_GUIDANCE, /自然.*口部|呼吸.*口部|mouth/i);
  assert.match(VIDEO_GUIDANCE, /dialogue.*为空.*禁止.*人声|空.*dialogue.*禁止.*人声/i);
  assert.match(VIDEO_GUIDANCE, /群众.*吆喝|叫卖|环境人声/);
});

test('media guidance keeps dialogue and narration out of rendered subtitles', () => {
  assert.match(NO_BURNED_TEXT_GUIDANCE, /audio.*metadata|声音.*元数据/i);
  assert.match(NO_BURNED_TEXT_GUIDANCE, /subtitle|字幕/i);
  assert.match(NO_BURNED_TEXT_GUIDANCE, /speech bubble|对白框|气泡/i);
  assert.match(VIDEO_GUIDANCE, /NO_BURNED_TEXT|字幕/);
  assert.match(SEGMENT_VIDEO_GUIDANCE, /NO_BURNED_TEXT|字幕/);
});

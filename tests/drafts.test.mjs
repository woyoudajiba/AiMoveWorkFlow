import assert from 'node:assert/strict';
import test from 'node:test';
import { DRAFT_TTL_MS, appendNovelContent, draftStorageKey, mergeDraftChanges, readDrafts, storyDraftContentConflict, writeDrafts } from '../src/drafts.ts';

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), values };
}
const story = { title: '末班灯', novel: '她在雨夜里等到末班电车，手里的信终于交给了故人。', style: '电影写实' };

test('sequel content appends after the original without changing its prefix', () => {
  const original = '第一季正文。\n\n';
  assert.equal(appendNovelContent(original, '第二季第一集。'), '第一季正文。\n第二季第一集。');
  assert.equal(appendNovelContent(original, '   '), original);
  assert.equal(appendNovelContent('', '后续内容'), '后续内容');
});

test('unsaved long text and project-scoped drafts survive a fresh read', () => {
  const local = storage();
  const draft = { ...story, novel: '长篇小说。'.repeat(20000) };
  assert.equal(writeDrafts(local, 'story', { projectA: draft, projectB: story }, 1000), 'saved');
  assert.deepEqual(readDrafts(local, 'story', 2000).drafts, { projectA: draft, projectB: story });
});

test('workflow drafts only persist editable fields, excluding media and credentials', () => {
  const local = storage();
  const shot = { scene: '雨夜车站', sceneId: 'scene-1', action: '递信', camera: '近景', dialogue: '好久不见。', characterIds: ['char-1'], duration: 2, trimStart: 0 };
  assert.equal(writeDrafts(local, 'shot', { 'projectA:shot1': { ...shot, image: 'data:image/png;base64,AAA', apiKey: 'private' } }, 1000), 'saved');
  assert.deepEqual(readDrafts(local, 'shot', 2000).drafts, { 'projectA:shot1': shot });
  assert.equal(local.values.get(draftStorageKey('shot')).includes('apiKey'), false);
  assert.equal(local.values.get(draftStorageKey('shot')).includes('base64'), false);
});

test('clearing saved drafts removes only the intended object and then the storage key', () => {
  const local = storage();
  writeDrafts(local, 'story', { projectA: story, projectB: story }, 1000);
  writeDrafts(local, 'story', { projectB: story }, 2000);
  assert.deepEqual(readDrafts(local, 'story', 3000).drafts, { projectB: story });
  writeDrafts(local, 'story', {}, 4000);
  assert.equal(local.getItem(draftStorageKey('story')), null);
});

test('unchanged old drafts expire even while another project is edited', () => {
  const local = storage();
  writeDrafts(local, 'story', { old: story, fresh: story }, 1000);
  writeDrafts(local, 'story', { old: story, fresh: { ...story, title: '新项目' } }, DRAFT_TTL_MS);
  assert.deepEqual(readDrafts(local, 'story', DRAFT_TTL_MS + 1001).drafts, { fresh: { ...story, title: '新项目' } });
});

test('malformed, outdated, oversized and sensitive draft values are safely ignored', () => {
  const local = storage();
  local.setItem(draftStorageKey('story'), '{broken');
  assert.deepEqual(readDrafts(local, 'story', 2000).drafts, {});
  local.setItem(draftStorageKey('story'), JSON.stringify({ version: 42, entries: { a: { value: story, updatedAt: 1000 } } }));
  assert.deepEqual(readDrafts(local, 'story', 2000).drafts, {});
  assert.equal(writeDrafts(local, 'story', { a: { ...story, novel: '文'.repeat(300001) } }, 2000), 'skipped');
  assert.equal(writeDrafts(local, 'story', { a: { ...story, novel: 'data:image/png;base64,AAABBB' } }, 2000), 'skipped');
  assert.equal(writeDrafts(local, 'story', { a: { ...story, novel: 'sk-testcredential12345678901234567890' } }, 2000), 'skipped');
  assert.deepEqual(readDrafts(local, 'story', 3000).drafts, {});
});

test('storage denial and quota failures do not throw or expose draft content', () => {
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('denied'); } };
  assert.deepEqual(readDrafts(denied, 'story', 1000).drafts, {});
  assert.equal(readDrafts(denied, 'story', 1000).unavailable, true);
  assert.equal(writeDrafts(denied, 'story', { a: story }, 1000), 'unavailable');
  assert.equal(writeDrafts(null, 'story', { a: story }, 1000), 'unavailable');
});

test('new-project settings and character, scene and look edits restore independently', () => {
  const local = storage();
  const fixtures = {
    import: { ...story, duration: 15, autoDuration: false },
    character: { name: '林晚', role: 'protagonist', aliases: ['晚晚'], appearance: '短发', evidence: '原文依据' },
    scene: { name: '车站', description: '雨夜' },
    look: { name: '雨夜风衣', appearance: '深色风衣，湿发' },
  };
  for (const [kind, value] of Object.entries(fixtures)) {
    assert.equal(writeDrafts(local, kind, { test: value }, 1000), 'saved');
    assert.deepEqual(readDrafts(local, kind, 2000).drafts, { test: value });
  }
});

test('existing story drafts accept the full project contract without weakening import limits', () => {
  const local = storage();
  const draft = { ...story, title: '长'.repeat(160), style: '风格'.repeat(1000) };
  assert.equal(writeDrafts(local, 'story', { projectA: draft }, 1000), 'saved');
  assert.deepEqual(readDrafts(local, 'story', 2000).drafts, { projectA: draft });
  assert.equal(writeDrafts(local, 'import', { new: { ...draft, duration: 30, autoDuration: true } }, 1000), 'skipped');
});

test('reloading and flushing restored drafts preserves expiry and does not mix projects', () => {
  const local = storage();
  const first = { name: '林晚', role: 'protagonist', aliases: [], appearance: '短发', evidence: '' };
  const second = { ...first, name: '顾川' };
  writeDrafts(local, 'character', { 'projectA:char1': first, 'projectB:char1': second }, 1000);
  const restored = readDrafts(local, 'character', 2000).drafts;
  writeDrafts(local, 'character', restored, 2000);
  writeDrafts(local, 'character', { ...restored, 'projectB:char1': { ...second, appearance: '黑色长发' } }, DRAFT_TTL_MS);
  const current = readDrafts(local, 'character', DRAFT_TTL_MS + 1001).drafts;
  assert.deepEqual(current, { 'projectB:char1': { ...second, appearance: '黑色长发' } });
});

test('an invalid paste preserves the last safe draft without storing rejected content or refreshing expiry', () => {
  const local = storage();
  writeDrafts(local, 'story', { projectA: story }, 1000);
  assert.equal(writeDrafts(local, 'story', { projectA: { ...story, novel: 'sk-testcredential12345678901234567890' } }, 2000), 'skipped');
  assert.deepEqual(readDrafts(local, 'story', 3000).drafts, { projectA: story });
  assert.equal(local.getItem(draftStorageKey('story')).includes('testcredential'), false);
  assert.equal(writeDrafts(local, 'story', { projectA: { ...story, novel: '文'.repeat(300001) } }, 4000), 'skipped');
  assert.deepEqual(readDrafts(local, 'story', 5000).drafts, { projectA: story });
  assert.deepEqual(readDrafts(local, 'story', DRAFT_TTL_MS + 1001).drafts, {});
});

test('title-only saving an analyzed project leaves unsaved novel and style conflicts recoverable', () => {
  const local = storage();
  const project = { ...story, segments: [{ id: 'analyzed' }] };
  const draft = { ...story, title: '新标题', novel: `${story.novel}这是尚未保存的结尾。`, style: '黑白胶片' };
  assert.equal(storyDraftContentConflict(project, draft), true);
  const titleSaved = { ...project, title: draft.title };
  writeDrafts(local, 'story', { projectA: draft }, 1000);
  if (!storyDraftContentConflict(titleSaved, draft)) writeDrafts(local, 'story', {}, 2000);
  assert.deepEqual(readDrafts(local, 'story', 3000).drafts, { projectA: draft });
  assert.equal(storyDraftContentConflict({ ...titleSaved, novel: draft.novel, style: draft.style }, draft), false);
  assert.equal(storyDraftContentConflict({ ...project, segments: [] }, draft), false);
});

test('independent tabs preserve drafts for different projects and different objects of one project', () => {
  const local = storage();
  const firstTab = readDrafts(local, 'story', 1000).drafts;
  const secondTab = readDrafts(local, 'story', 1000).drafts;
  writeDrafts(local, 'story', mergeDraftChanges({}, firstTab, { projectA: story }), 2000);
  writeDrafts(local, 'story', mergeDraftChanges(readDrafts(local, 'story', 3000).drafts, secondTab, { projectB: { ...story, title: '另一部作品' } }), 3000);
  assert.deepEqual(readDrafts(local, 'story', 4000).drafts, { projectA: story, projectB: { ...story, title: '另一部作品' } });
  const lookA = { name: '风衣', appearance: '深色' };
  const lookB = { name: '便服', appearance: '浅色' };
  writeDrafts(local, 'look', mergeDraftChanges({}, {}, { 'projectA:look1': lookA }), 2000);
  writeDrafts(local, 'look', mergeDraftChanges(readDrafts(local, 'look', 3000).drafts, {}, { 'projectA:look2': lookB }), 3000);
  assert.deepEqual(readDrafts(local, 'look', 4000).drafts, { 'projectA:look1': lookA, 'projectA:look2': lookB });
});

test('saving one tab removes only its changed key while untouched and newer external edits survive', () => {
  const original = { projectA: story, projectB: { ...story, title: '乙' } };
  const newer = { ...original, projectB: { ...story, title: '乙的新标题' }, projectC: { ...story, title: '丙' } };
  assert.deepEqual(mergeDraftChanges(newer, original, { projectB: original.projectB }), { projectB: newer.projectB, projectC: newer.projectC });
  assert.deepEqual(mergeDraftChanges(newer, original, original), newer);
  const edited = { ...story, title: '甲的新标题' };
  assert.deepEqual(mergeDraftChanges(newer, original, { ...original, projectA: edited }), { ...newer, projectA: edited });
});

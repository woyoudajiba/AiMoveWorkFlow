import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalProjectSync, mediaPathForCleanup } from '../src/localProjectSync.ts';

const project = {
  id: 'project-1', title: '借我灵根', novel: '原始剧本内容', style: '电影感', aspectRatio: '9:16', duration: 15,
  createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:00:00.000Z',
  characters: [{ id: 'char-1', name: '林默', role: 'protagonist', aliases: [], appearance: '黑发', evidence: '原文', reference: '/workf/media/project-1/char.png?account=abc', approved: true, version: 1 }],
  scenes: [{ id: 'scene-1', name: '宗门', description: '山门' }],
  looks: [{ id: 'look-1', sceneId: 'scene-1', characterId: 'char-1', name: '白衣', appearance: '白衣', reference: '/workf/media/project-1/look.png?account=abc', approved: true, version: 1 }],
  segments: [{ id: 'segment-1', number: 1, title: '山门', summary: '进入山门', duration: 15, storyboardImage: '/workf/media/project-1/board.png?account=abc', video: '/workf/media/project-1/seg.mp4?account=abc', videoVersion: '1', shots: [{ id: 'shot-1', number: 1, duration: 15, scene: '宗门', action: '进入', camera: '远景', dialogue: '', characterIds: ['char-1'], image: '/workf/media/project-1/shot.png?account=abc', approved: true, version: 1, trimStart: 0, video: '/workf/media/project-1/shot.mp4?account=abc', videoVersion: '1' }] }],
  exports: [{ id: 'export-1', segmentId: 'segment-1', number: 1, videoUrl: '/workf/media/project-1/export-aabbccdd/project.mp4?account=abc', gridUrl: '/workf/media/project-1/export-aabbccdd/project.jpg?account=abc', manifestUrl: '/workf/media/project-1/export-aabbccdd/manifest.json?account=abc', csvUrl: '/workf/media/project-1/export-aabbccdd/list.csv?account=abc', createdAt: '2026-10-06T00:00:00.000Z' }],
  projectExports: [], exportHistory: [], mediaHistory: [], jobs: [],
};

test('local sync keeps the four fixed folders and routes assets by type', () => {
  const plan = buildLocalProjectSync(project);
  assert.deepEqual(plan.directories, ['Actor_image', 'Story_image', 'Movie', 'Analysis']);
  assert.ok(plan.assets.some(item => item.relativePath === 'Actor_image/character-001-林默.png'));
  assert.ok(plan.assets.some(item => item.relativePath === 'Story_image/segment-001-shot-01.png'));
  assert.ok(plan.assets.some(item => item.relativePath === 'Movie/1-001.mp4'));
  assert.ok(plan.assets.some(item => item.relativePath === 'Movie/1-001（1）.mp4'));
  assert.ok(plan.assets.some(item => item.relativePath === 'Analysis/1-001-manifest.json'));
  assert.deepEqual(plan.videoUrls, [
    '/media/project-1/seg.mp4',
    '/media/project-1/shot.mp4',
    '/media/project-1/export-aabbccdd/project.mp4',
  ]);
});

test('local sync keeps the first generated segment video as the base name and suffixes regenerated versions', () => {
  const versioned = structuredClone(project);
  versioned.segments[0].episodeNumber = 1;
  versioned.segments[0].number = 4;
  versioned.segments[0].video = '/workf/media/project-1/new-segment.mp4?account=abc';
  versioned.exports = [];
  versioned.mediaHistory = [
    { recordType: 'segment-video', assetUrl: '/workf/media/project-1/old-segment.mp4?account=abc', segmentId: 'segment-1', number: 4, version: 'old' },
    { recordType: 'segment-video', assetUrl: '/workf/media/project-1/new-segment.mp4?account=abc', segmentId: 'segment-1', number: 4, version: 'new' },
  ];
  const plan = buildLocalProjectSync(versioned);
  assert.ok(plan.assets.some(item => item.url.includes('/old-segment.mp4') && item.relativePath === 'Movie/1-001.mp4'));
  assert.ok(plan.assets.some(item => item.url.includes('/new-segment.mp4') && item.relativePath === 'Movie/1-001（1）.mp4'));
});

test('cleanup path removes public base and query but never changes project identity', () => {
  assert.equal(mediaPathForCleanup('/workf/media/project-1/seg.mp4?account=abc'), '/media/project-1/seg.mp4');
  assert.equal(mediaPathForCleanup('/media/project-1/seg.mp4'), '/media/project-1/seg.mp4');
  assert.throws(() => mediaPathForCleanup('/workf/assets/project-1/seg.mp4'), /视频媒体地址/);
});

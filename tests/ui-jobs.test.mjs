import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateAnalysis } from '../server/domain.mjs';
import { SAMPLE_INPUT, SAMPLE_ANALYSIS } from '../server/sample.mjs';
import { currentProblemJobs, isCurrentJob, isSupersededAnalysis, latestCurrentJobs } from '../src/types.ts';
import { groupSegmentsByEpisode } from '../src/episode-groups.ts';

function fixture() {
  const project = createProject(SAMPLE_INPUT);
  Object.assign(project, validateAnalysis(structuredClone(SAMPLE_ANALYSIS), project));
  return project;
}
function job(id, kind, targetId, inputVersion, status = 'failed', extra = {}) {
  return { id, kind, targetId, inputVersion, status, progress: 0, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra };
}

test('editing or replacing an asset removes historical failures from current task indicators', () => {
  const project = fixture(), character = project.characters[0], look = project.looks[0], shot = project.segments[0].shots[0];
  project.jobs = [
    job('identity-old', 'character', character.id, character.version),
    job('look-old', 'look', look.id, look.version),
    job('image-old', 'image', shot.id, shot.version),
    job('video-old', 'video', shot.id, shot.version),
  ];
  character.version++; look.version++; shot.version++;
  const history = structuredClone(project.jobs);
  assert.deepEqual(currentProblemJobs(project), []);
  assert.deepEqual(latestCurrentJobs(project), []);
  assert.deepEqual(project.jobs, history, 'history remains available for inspection');
});

test('only the latest attempt for each current target and task kind affects its status', () => {
  const project = fixture(), shot = project.segments[0].shots[0];
  const imageFailure = job('image-failed', 'image', shot.id, shot.version);
  const videoFailure = job('video-failed', 'video', shot.id, shot.version);
  const retry = job('video-retry', 'video', shot.id, shot.version, 'queued');
  project.jobs = [imageFailure, videoFailure, retry];
  assert.deepEqual(latestCurrentJobs(project).map(item => item.id), ['image-failed', 'video-retry']);
  assert.deepEqual(currentProblemJobs(project).map(item => item.id), ['image-failed']);
  retry.status = 'completed';
  assert.deepEqual(currentProblemJobs(project).map(item => item.id), ['image-failed']);
});

test('a late update to an earlier attempt never replaces a newer attempt', () => {
  const project = fixture(), shot = project.segments[0].shots[0];
  project.jobs = [
    job('old-failure', 'video', shot.id, shot.version, 'failed', { updatedAt: '2026-10-01T00:02:00.000Z' }),
    job('new-complete', 'video', shot.id, shot.version, 'completed', { updatedAt: '2026-10-01T00:01:00.000Z' }),
  ];
  assert.deepEqual(latestCurrentJobs(project).map(item => item.id), ['new-complete']);
  assert.deepEqual(currentProblemJobs(project), []);
});

test('current failed, unknown and interrupted attempts remain visible', () => {
  const project = fixture(), [first, second, third] = project.segments[0].shots;
  project.jobs = [
    job('failed', 'image', first.id, first.version),
    job('unknown', 'video', second.id, second.version, 'unknown'),
    job('interrupted', 'video', third.id, third.version, 'interrupted'),
  ];
  assert.deepEqual(currentProblemJobs(project).map(item => item.id), ['failed', 'unknown', 'interrupted']);
});

test('an unresolved current paid request stays visible even if a later attempt completed', () => {
  const project = fixture(), shot = project.segments[0].shots[0];
  project.jobs = [
    job('unresolved', 'video', shot.id, shot.version, 'unknown'),
    job('interrupted', 'video', shot.id, shot.version, 'interrupted'),
    job('new-complete', 'video', shot.id, shot.version, 'completed'),
  ];
  assert.deepEqual(currentProblemJobs(project).map(item => item.id), ['unresolved']);
  shot.version++;
  assert.deepEqual(currentProblemJobs(project), [], 'an unresolved old input does not block the replacement asset');
});

test('explicitly acknowledged analysis history stays intact while only its follow-up needs attention',()=>{
  const project=fixture();
  project.jobs=[
    job('old-analysis','analyze',project.id,'source','unknown',{analysisRetryJobId:'new-analysis',analysisRetryAcceptedAt:'2026-10-04T00:00:00.000Z'}),
    job('new-analysis','analyze',project.id,'source','unknown',{analysisRetryOf:'old-analysis'}),
  ];
  const original=structuredClone(project.jobs);
  assert.deepEqual(currentProblemJobs(project).map(x=>x.id),['new-analysis']);
  assert.deepEqual(project.jobs,original);
});

test('failed analysis becomes history only after a later matching analysis completed with results', () => {
  const project = fixture();
  const failed = job('failed', 'analyze', project.id, 'source');
  const completed = job('completed', 'analyze', project.id, 'source', 'completed');
  project.jobs = [failed, completed];
  const before = structuredClone(project);
  assert.equal(isSupersededAnalysis(project, failed), true);
  assert.equal(isSupersededAnalysis(project, completed), false);
  assert.deepEqual(project, before, 'presentation must preserve the original failure and receipt history');
  project.segments = [];
  assert.equal(isSupersededAnalysis(project, failed), false, 'a success flag without usable results is insufficient');
});

test('history presentation never treats a different source, earlier success or unfinished retry as recovery', () => {
  const project = fixture();
  const failed = job('failed', 'analyze', project.id, 'source');
  const completed = job('completed', 'analyze', project.id, 'source', 'completed');
  for (const replacement of [
    { ...completed, inputVersion: 'other-source' },
    { ...completed, targetId: 'other-project' },
    { ...completed, status: 'running' },
    { ...completed, status: 'failed' },
  ]) {
    project.jobs = [failed, replacement];
    assert.equal(isSupersededAnalysis(project, failed), false);
  }
  project.jobs = [completed, failed];
  assert.equal(isSupersededAnalysis(project, failed), false);
  project.jobs = [completed];
  assert.equal(isSupersededAnalysis(project, failed), false);
});

test('unknown paid analysis and asset tasks retain their original status after a later success', () => {
  const project = fixture();
  for (const [kind, status] of [['analyze', 'unknown'], ['analyze', 'running'], ['image', 'failed']]) {
    const earlier = job('earlier', kind, project.id, 'source', status);
    project.jobs = [earlier, job('completed', kind, project.id, 'source', 'completed')];
    assert.equal(isSupersededAnalysis(project, earlier), false);
  }
  project.jobs = [job('unversioned', 'analyze', project.id, undefined), job('completed', 'analyze', project.id, undefined, 'completed')];
  assert.equal(isSupersededAnalysis(project, project.jobs[0]), false);
});

test('template changes exclude old export problems while preserving current ones', () => {
  const project = fixture(), segment = project.segments[0];
  const inputVersion = () => JSON.stringify({ templateId: segment.boardTemplateId ?? 'classic-nine', shots: segment.shots.map(shot => [shot.id, shot.version, shot.videoVersion, shot.trimStart, shot.duration]) });
  project.jobs = [job('old-export', 'export', segment.id, inputVersion())];
  segment.boardTemplateId = 'three-three';
  project.jobs.push(job('current-export', 'export', segment.id, inputVersion()));
  assert.deepEqual(currentProblemJobs(project).map(item => item.id), ['current-export']);
});

test('missing targets and unversioned asset jobs cannot become current by matching undefined', () => {
  const project = fixture();
  for (const kind of ['character', 'look', 'image', 'video']) {
    const missing = job(`missing-${kind}`, kind, 'removed-target', undefined);
    assert.equal(isCurrentJob(project, missing), false);
  }
  const shot = project.segments[0].shots[0];
  project.jobs = [job('unversioned', 'image', shot.id, undefined)];
  assert.deepEqual(currentProblemJobs(project), []);
});

test('storyboard episode groups keep numbered episodes separate and place legacy segments last', () => {
  const project = fixture();
  const first = project.segments[0];
  const second = structuredClone(first);
  second.id = 'second-segment';
  first.episodeNumber = 1;
  first.episodeTitle = '开端';
  second.episodeNumber = 2;
  second.episodeTitle = '转折';
  const legacy = structuredClone(first);
  delete legacy.episodeNumber;
  delete legacy.episodeTitle;
  const groups = groupSegmentsByEpisode([second, legacy, first]);
  assert.deepEqual(groups.map(group => group.key), ['episode:1', 'episode:2', 'unassigned']);
  assert.equal(groups[0].title, '第1集 · 开端');
  assert.deepEqual(groups[0].segments.map(segment => segment.id), [first.id]);
  assert.deepEqual(groups.at(-1).segments.map(segment => segment.id), [legacy.id]);
});

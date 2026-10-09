import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTaskNotifications, STALLED_AFTER_MS } from '../src/task-notifications.mjs';

const job = (id, kind, status, updatedAt, targetId = id) => ({ id, kind, targetId, status, updatedAt, createdAt: updatedAt, progress: 0 });
const project = jobs => ({ id: 'project-1', jobs });

test('task notifications distinguish failure, stuck, analysis completion and generation completion', () => {
  const old = project([
    job('failure', 'image', 'running', '2026-10-08T00:00:00.000Z'),
    job('stuck', 'video', 'running', '2026-10-08T00:00:00.000Z'),
    job('analysis', 'analyze', 'running', '2026-10-08T00:00:00.000Z'),
    job('generation', 'segment-video', 'running', '2026-10-08T00:00:00.000Z'),
  ]);
  const next = project([
    job('failure', 'image', 'failed', '2026-10-08T00:01:00.000Z'),
    job('stuck', 'video', 'unknown', '2026-10-08T00:01:00.000Z'),
    job('analysis', 'analyze', 'completed', '2026-10-08T00:01:00.000Z'),
    job('generation', 'segment-video', 'completed', '2026-10-08T00:01:00.000Z'),
  ]);
  const events = collectTaskNotifications(old, next, { notified: new Set() });
  assert.deepEqual(events.map(event => [event.category, event.jobId]), [
    ['failure', 'failure'],
    ['stuck', 'stuck'],
    ['completed', 'analysis'],
    ['completed', 'generation'],
  ]);
});

test('active analysis does not report a false stuck notification while the model is working', () => {
  const old = project([{ ...job('slow', 'analyze', 'running', '2026-10-08T00:00:00.000Z'), analysisProgress: { completedChunks: 2, totalChunks: 57, phase: 'analyzing', currentChunk: 3, model: 'qwen3.7-plus' } }]);
  const next = project([{ ...job('slow', 'analyze', 'running', '2026-10-08T00:00:00.000Z'), analysisProgress: { completedChunks: 2, totalChunks: 57, phase: 'analyzing', currentChunk: 3, model: 'qwen3.7-plus' } }]);
  const notified = new Set();
  const now = Date.parse('2026-10-08T00:00:00.000Z') + STALLED_AFTER_MS + 1;
  const first = collectTaskNotifications(old, next, { now, notified });
  const second = collectTaskNotifications(old, next, { now: now + 1000, notified });
  assert.deepEqual(first, []);
  assert.equal(second.length, 0);
});

test('stalled generation jobs still notify once after the threshold', () => {
  const old = project([job('slow', 'video', 'running', '2026-10-08T00:00:00.000Z')]);
  const next = project([job('slow', 'video', 'running', '2026-10-08T00:00:00.000Z')]);
  const notified = new Set();
  const now = Date.parse('2026-10-08T00:00:00.000Z') + STALLED_AFTER_MS + 1;
  const first = collectTaskNotifications(old, next, { now, notified });
  assert.equal(first.length, 1);
  assert.equal(first[0].category, 'stuck');
});

test('provider polling timestamps do not hide a task with unchanged progress', () => {
  const first = project([job('polling', 'video', 'running', '2026-10-08T00:00:00.000Z')]);
  const second = project([job('polling', 'video', 'running', '2026-10-08T00:01:00.000Z')]);
  const activityAt = new Map();
  const notified = new Set();
  collectTaskNotifications(first, second, { now: Date.parse('2026-10-08T00:01:00.000Z'), notified, activityAt });
  const stalled = collectTaskNotifications(second, project([job('polling', 'video', 'running', '2026-10-08T00:02:00.000Z')]), {
    now: Date.parse('2026-10-08T00:02:00.000Z') + STALLED_AFTER_MS + 1,
    notified,
    activityAt,
  });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].category, 'stuck');
});

test('initial project hydration does not replay historical job notifications', () => {
  const projectState = project([job('done', 'image', 'completed', '2026-10-08T00:00:00.000Z')]);
  assert.deepEqual(collectTaskNotifications(null, projectState), []);
});

test('a task returned already failed or completed is announced after the workspace is active', () => {
  const old = project([]);
  const next = project([
    job('failed-now', 'image', 'failed', '2026-10-08T00:01:00.000Z'),
    job('completed-now', 'storyboard', 'completed', '2026-10-08T00:01:00.000Z'),
  ]);
  const events = collectTaskNotifications(old, next, { notified: new Set() });
  assert.deepEqual(events.map(event => [event.category, event.jobId]), [
    ['failure', 'failed-now'],
    ['completed', 'completed-now'],
  ]);
});

test('missing or invalid timestamps do not create a false stalled notification', () => {
  const old = project([job('no-time', 'video', 'running', '')]);
  const next = project([job('no-time', 'video', 'running', '')]);
  const events = collectTaskNotifications(old, next, { now: Date.now(), notified: new Set() });
  assert.deepEqual(events, []);
});

test('batch generation emits one completion notification for many jobs', () => {
  const old = project([
    { ...job('batch-a', 'image', 'running', '2026-10-08T00:00:00.000Z'), batchId: 'batch-1', batchLabel: '批量生图' },
    { ...job('batch-b', 'image', 'running', '2026-10-08T00:00:00.000Z'), batchId: 'batch-1', batchLabel: '批量生图' },
  ]);
  const next = project([
    { ...job('batch-a', 'image', 'completed', '2026-10-08T00:01:00.000Z'), batchId: 'batch-1', batchLabel: '批量生图' },
    { ...job('batch-b', 'image', 'completed', '2026-10-08T00:01:00.000Z'), batchId: 'batch-1', batchLabel: '批量生图' },
  ]);
  const events = collectTaskNotifications(old, next, { notified: new Set() });
  assert.equal(events.length, 1);
  assert.equal(events[0].category, 'completed');
  assert.match(events[0].body, /2 项/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectCache } from '../src/project-cache.ts';

test('project detail cache keeps the most recently used projects and evicts the oldest entry', () => {
  const cache = createProjectCache(2);
  cache.set('first', { id: 'first', updatedAt: '2026-01-01T00:00:00.000Z' });
  cache.set('second', { id: 'second', updatedAt: '2026-01-02T00:00:00.000Z' });
  assert.equal(cache.get('first')?.id, 'first');
  cache.set('third', { id: 'third', updatedAt: '2026-01-03T00:00:00.000Z' });
  assert.equal(cache.get('second'), null);
  assert.equal(cache.get('first')?.id, 'first');
  assert.equal(cache.get('third')?.id, 'third');
});

test('project detail cache can invalidate one project without affecting other entries', () => {
  const cache = createProjectCache(3);
  cache.set('a', { id: 'a' });
  cache.set('b', { id: 'b' });
  cache.delete('a');
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('b')?.id, 'b');
  cache.clear();
  assert.equal(cache.get('b'), null);
});

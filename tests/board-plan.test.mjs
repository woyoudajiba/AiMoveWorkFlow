import test from 'node:test';
import assert from 'node:assert/strict';
import { planBoardPages } from '../src/board-plan.ts';

const template = (shotCapacity, lookCapacity) => ({ shotCapacity, lookCapacity });
const shots = (count, sceneId = 'station', characterIds = ['hero']) => Array.from({ length: count }, (_, index) => ({ number: index + 1, sceneId, scene: '雨夜车站', characterIds }));

test('template page plan counts the ninth shot and exact unused slots on the next page', () => {
  const plan = planBoardPages(shots(9), template(8, 1));
  assert.equal(plan.pages.length, 2);
  assert.equal(plan.continuationPages, 0);
  assert.equal(plan.emptyShotSlots, 7);
  assert.equal(plan.emptyLookSlots, 0);
  assert.deepEqual(plan.pages[1], { number: 2, shotNumbers: [9], lookCount: 1, continuation: false, emptyShotSlots: [2, 3, 4, 5, 6, 7, 8], emptyLookSlots: [] });
});

test('look continuations repeat their shots and retain every character slot, including missing look assets', () => {
  const plan = planBoardPages(shots(9, 'station', ['hero', 'friend', 'driver']), template(9, 2));
  assert.equal(plan.pages.length, 2);
  assert.equal(plan.continuationPages, 1);
  assert.equal(plan.emptyShotSlots, 0);
  assert.equal(plan.emptyLookSlots, 1);
  assert.deepEqual(plan.pages.map(page => page.lookCount), [2, 1]);
  assert.deepEqual(plan.pages[0].shotNumbers, plan.pages[1].shotNumbers);
  assert.deepEqual(plan.pages[1].emptyLookSlots, [2]);
});

test('page plan keeps a returning scene separate and orders shuffled shots by their story number', () => {
  const input = shots(9).map((shot, index) => ({ ...shot, sceneId: index >= 3 && index < 6 ? 'home' : 'station' }));
  const before = structuredClone(input);
  const plan = planBoardPages([...input].reverse(), template(9, 2));
  assert.deepEqual(plan.pages.map(page => page.shotNumbers), [[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
  assert.equal(plan.emptyShotSlots, 18);
  assert.equal(plan.emptyLookSlots, 3);
  assert.deepEqual(input, before);
});

test('page plan deduplicates actors within a shot page and leaves all look slots empty for an empty scene', () => {
  const input = shots(4);
  input[1].characterIds = ['hero', 'friend'];
  input[2].characterIds = ['friend'];
  input[3].characterIds = [];
  const plan = planBoardPages(input, template(3, 3));
  assert.deepEqual(plan.pages.map(page => page.lookCount), [2, 0]);
  assert.deepEqual(plan.pages[1].emptyLookSlots, [1, 2, 3]);
  assert.equal(plan.emptyLookSlots, 4);
});

test('legacy scenes retain consecutive grouping and an empty segment has no export pages', () => {
  const input = shots(3).map(({ sceneId, ...shot }, index) => ({ ...shot, scene: index === 1 ? '清晨家中' : '雨夜车站' }));
  assert.deepEqual(planBoardPages(input, template(9, 2)).pages.map(page => page.shotNumbers), [[1], [2], [3]]);
  assert.deepEqual(planBoardPages([], template(9, 2)), { pages: [], continuationPages: 0, emptyShotSlots: 0, emptyLookSlots: 0 });
});

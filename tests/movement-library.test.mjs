import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVEMENT_LIBRARY, movementCatalogPrompt, movementIdFromText, movementPromptLine, normalizeMovementPlan } from '../server/movement-library.mjs';

test('movement language library loads all 120 numbered entries', () => {
  assert.equal(MOVEMENT_LIBRARY.length, 120);
  assert.deepEqual(MOVEMENT_LIBRARY.map(item => item.number), Array.from({ length: 120 }, (_, index) => index + 1));
  const catalog = movementCatalogPrompt();
  assert.match(catalog, /move-1 固定机位/);
  assert.match(catalog, /move-120 航拍加穿越/);
});

test('movement plans normalize legacy shots and retain controlled ids', () => {
  const shot = normalizeMovementPlan({ number: 2, camera: '近景，缓慢推进', action: '角色抬头' }, 1);
  assert.equal(shot.movementId, 'move-2');
  assert.match(shot.movementPlan, /缓慢推入/);
  assert.match(shot.transitionPlan, /动作轴/);
  assert.equal(movementIdFromText('快速环绕主体'), 'move-28');
  assert.match(movementPromptLine(shot), /move-2/);
});

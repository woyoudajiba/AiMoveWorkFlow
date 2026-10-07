import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateVideoCostCny, listVideoOptions, resolveVideoOption } from '../server/video-options.mjs';

test('video catalog exposes the requested rates and duration limits', () => {
  const options = listVideoOptions();
  const h3 = options.find(option => option.id === 'MiniMax-H3');
  const h3Max = options.find(option => option.id === 'MiniMax-H3-Max');
  const seedance = options.find(option => option.id === 'doubao-seedance-2-5');
  const xiongmao = options.find(option => option.id === 'xiongmao-minimaxh3');
  assert.equal(h3?.maxDurationSeconds, 15);
  assert.equal(h3Max?.maxDurationSeconds, 15);
  assert.equal(seedance?.maxDurationSeconds, 30);
  assert.equal(xiongmao?.maxDurationSeconds, 15);
  assert.equal(resolveVideoOption('xiongmao-minimaxh3').videoResolution, '2k');
  assert.equal(estimateVideoCostCny('MiniMax-H3', '768P', 15), 7.5);
  assert.equal(estimateVideoCostCny('MiniMax-H3-Max', '480P', 30), 9.9);
  assert.equal(estimateVideoCostCny('doubao-seedance-2-5', '720p', 15), 22);
  assert.equal(resolveVideoOption('MiniMax-H3-Max', '480p').maxDurationSeconds, 15);
});

test('Xiongmao Seedance official variants expose quality-specific resolutions and ranges', () => {
  const options = listVideoOptions().filter(option => option.id.startsWith('xiongmao-seedance-2-0-official'));
  assert.deepEqual(options.map(option => option.id), [
    'xiongmao-seedance-2-0-official',
    'xiongmao-seedance-2-0-official-fast',
    'xiongmao-seedance-2-0-official-mini',
  ]);
  assert.deepEqual(options.map(option => option.resolutions.map(item => item.id)), [
    ['480p', '720p', '1080p', '4k'],
    ['480p', '720p'],
    ['480p', '720p'],
  ]);
  assert.deepEqual(resolveVideoOption('xiongmao-seedance-2-0-official', '480p').pricePerSecondCnyRange, { min: 0.552, max: 0.968 });
  assert.deepEqual(resolveVideoOption('xiongmao-seedance-2-0-official-fast', '720p').pricePerSecondCnyRange, { min: 0.841, max: 1.68 });
  assert.deepEqual(resolveVideoOption('xiongmao-seedance-2-0-official-mini', '480p').pricePerSecondCnyRange, { min: 0.157, max: 0.736 });
  assert.equal(resolveVideoOption('xiongmao-seedance-2-0-official').quality, '标准');
  assert.equal(resolveVideoOption('xiongmao-seedance-2-0-official-fast').quality, 'fast');
  assert.equal(resolveVideoOption('xiongmao-seedance-2-0-official-mini').quality, 'mini');
  assert.equal(estimateVideoCostCny('xiongmao-seedance-2-0-official', '480p', 4), null);
  assert.deepEqual(resolveVideoOption('xiongmao-seedance-2-0-official-fast', '720p').pricePerSecondCnyRange, { min: 0.841, max: 1.68 });
});

test('Xiongmao Seedance promo variants expose screenshot price ranges', () => {
  const options = listVideoOptions().filter(option => option.id.startsWith('xiongmao-seedance-2-0-promo'));
  assert.deepEqual(options.map(option => option.id), [
    'xiongmao-seedance-2-0-promo',
    'xiongmao-seedance-2-0-promo-fast',
    'xiongmao-seedance-2-0-promo-mini',
  ]);
  assert.deepEqual(resolveVideoOption('xiongmao-seedance-2-0-promo', '480p').pricePerSecondCnyRange, { min: 0.22, max: 1.1 });
  assert.deepEqual(resolveVideoOption('xiongmao-seedance-2-0-promo', '4k').pricePerSecondCnyRange, { min: 6.29, max: 9.76 });
  assert.deepEqual(resolveVideoOption('xiongmao-seedance-2-0-promo-fast', '1080p').pricePerSecondCnyRange, { min: 1.8, max: 1.8 });
  assert.deepEqual(resolveVideoOption('xiongmao-seedance-2-0-promo-mini', '720p').pricePerSecondCnyRange, { min: 0.345, max: 1.59 });
});

test('Xiongmao Seedance special variants are fixed 15-second options with unknown pricing', () => {
  for (const [id, quality] of [
    ['xiongmao-seedance-2-0-special', '高清'],
    ['xiongmao-seedance-2-0-special-fast', '快速'],
    ['xiongmao-seedance-2-0-special-mini', '标准'],
  ]) {
    const option = resolveVideoOption(id, '720p');
    assert.equal(option.minDurationSeconds, 15);
    assert.equal(option.maxDurationSeconds, 15);
    assert.equal(option.quality, quality);
    assert.equal(option.pricePerSecondCnyRange, null);
  }
});

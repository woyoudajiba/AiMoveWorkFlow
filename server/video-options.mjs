// The UI may display this catalog, but all task submissions must resolve
// through this module so model/resolution combinations stay server-authoritative.
const priceRange = (min, max) => ({ min, max });
const catalog = [
  {
    id: 'MiniMax-H3', label: 'MiniMax H3', provider: 'MiniMax',
    maxDurationSeconds: 15,
    resolutions: [
      { id: '768P', label: '768P', pricePerSecondCny: 0.50 },
      { id: '2K', label: '2K', pricePerSecondCny: 0.80 },
    ],
  },
  {
    id: 'MiniMax-H3-Max', label: 'MiniMax H3 Max', provider: 'MiniMax',
    maxDurationSeconds: 15,
    resolutions: [
      { id: '480P', label: '480P', pricePerSecondCny: 0.33 },
      { id: '768P', label: '768P', pricePerSecondCny: 0.50 },
    ],
  },
  {
    id: 'xiongmao-minimaxh3', label: 'MiniMax H3 · 熊猫Ai', provider: '熊猫Ai',
    maxDurationSeconds: 15,
    resolutions: [
      { id: '768p', label: '768P', pricePerSecondCny: null },
      { id: '2k', label: '2K', pricePerSecondCny: null },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-official', label: 'Seedance 2.0 官方直连 · 标准 · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-official', quality: '标准', maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.552, 0.968) },
      { id: '720p', label: '720P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(1.23, 2.08) },
      { id: '1080p', label: '1080P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(2.67, 5.19) },
      { id: '4k', label: '4K', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(7.36, 10.68) },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-official-fast', label: 'Seedance 2.0 官方直连 · Fast · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-official', quality: 'fast', maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.474, 0.990) },
      { id: '720p', label: '720P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.841, 1.68) },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-official-mini', label: 'Seedance 2.0 官方直连 · Mini · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-official', quality: 'mini', maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.157, 0.736) },
      { id: '720p', label: '720P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.338, 1.05) },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-promo', label: 'Seedance 2.0 特价按秒 · 标准 · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-promo', quality: '标准', maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.220, 1.10) },
      { id: '720p', label: '720P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.345, 3.66) },
      { id: '1080p', label: '1080P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.747, 1.02) },
      { id: '2k', label: '2K', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(1.02, 1.02) },
      { id: '4k', label: '4K', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(6.29, 9.76) },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-promo-fast', label: 'Seedance 2.0 特价按秒 · Fast · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-promo', quality: 'fast', maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.367, 0.829) },
      { id: '720p', label: '720P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.684, 1.66) },
      { id: '1080p', label: '1080P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(1.80, 1.80) },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-promo-mini', label: 'Seedance 2.0 特价按秒 · Mini · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-promo', quality: 'mini', maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.220, 0.781) },
      { id: '720p', label: '720P', pricePerSecondCny: null, pricePerSecondCnyRange: priceRange(0.345, 1.59) },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-special', label: 'Seedance 2.0 特价按次 · 高清 · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-special', quality: '高清', minDurationSeconds: 15, maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null },
      { id: '720p', label: '720P', pricePerSecondCny: null },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-special-fast', label: 'Seedance 2.0 特价按次 · Fast · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-special', quality: '快速', minDurationSeconds: 15, maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null },
      { id: '720p', label: '720P', pricePerSecondCny: null },
    ],
  },
  {
    id: 'xiongmao-seedance-2-0-special-mini', label: 'Seedance 2.0 特价按次 · Mini · 熊猫Ai', provider: '熊猫Ai',
    providerModel: 'seedance-2-0-special', quality: '标准', minDurationSeconds: 15, maxDurationSeconds: 15,
    resolutions: [
      { id: '480p', label: '480P', pricePerSecondCny: null },
      { id: '720p', label: '720P', pricePerSecondCny: null },
    ],
  },
  {
    id: 'doubao-seedance-2-5', label: 'Seedance 2.5', provider: '火山方舟',
    maxDurationSeconds: 30,
    resolutions: [
      { id: '720p', label: '720P', pricePerSecondCny: 22 / 15 },
      { id: '1080p', label: '1080P', pricePerSecondCny: 22 / 15 },
    ],
  },
  {
    id: 'doubao-seedance-2-0-pro', label: 'Seedance 2.0 普通 / Pro', provider: '火山方舟',
    maxDurationSeconds: 15,
    resolutions: [{ id: '720p', label: '720P', pricePerSecondCny: null }],
  },
  {
    id: 'doubao-seedance-2-0-fast', label: 'Seedance 2.0 Fast', provider: '火山方舟',
    maxDurationSeconds: 15,
    resolutions: [{ id: '720p', label: '720P', pricePerSecondCny: null }],
  },
  {
    id: 'doubao-seedance-2-0-mini', label: 'Seedance 2.0 Mini', provider: '火山方舟',
    maxDurationSeconds: 15,
    resolutions: [{ id: '720p', label: '720P', pricePerSecondCny: null }],
  },
  {
    id: 'doubao-seedance-1-0-pro-250528', label: 'Seedance 1.0 Pro', provider: '火山方舟',
    maxDurationSeconds: 12,
    resolutions: [{ id: '1080p', label: '1080P', pricePerSecondCny: null }],
  },
  {
    id: 'doubao-seedance-1-0-pro-fast-250528', label: 'Seedance 1.0 Pro Fast', provider: '火山方舟',
    maxDurationSeconds: 12,
    resolutions: [{ id: '1080p', label: '1080P', pricePerSecondCny: null }],
  },
];

export const VIDEO_OPTIONS = Object.freeze(catalog.map(item => Object.freeze({
  ...item,
  resolutions: Object.freeze(item.resolutions.map(resolution => Object.freeze({
    ...resolution,
    ...(resolution.pricePerSecondCnyRange ? { pricePerSecondCnyRange: Object.freeze({ ...resolution.pricePerSecondCnyRange }) } : {}),
  }))),
})));

const normalizedModel = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function findModel(model) {
  const key = normalizedModel(model);
  return VIDEO_OPTIONS.find(item => normalizedModel(item.id) === key);
}

export function listVideoOptions() {
  return VIDEO_OPTIONS.map(item => ({
    ...item,
    resolutions: item.resolutions.map(resolution => ({
      ...resolution,
      ...(resolution.pricePerSecondCnyRange ? { pricePerSecondCnyRange: { ...resolution.pricePerSecondCnyRange } } : {}),
    })),
  }));
}

export function resolveVideoOption(model, resolution) {
  const selected = findModel(model);
  if (!selected) {
    const error = new Error('视频模型不在已接入列表中。');
    error.code = 'MODEL_UNSUPPORTED'; error.status = 400; error.statusCode = 400;
    throw error;
  }
  const requested = typeof resolution === 'string' && resolution.trim() ? resolution.trim().toLowerCase() : '';
  const defaultResolution = selected.id === 'MiniMax-H3' || selected.id === 'xiongmao-minimaxh3' ? '2k' : selected.id === 'MiniMax-H3-Max' ? '768p' : selected.resolutions[0].id.toLowerCase();
  const selectedResolution = selected.resolutions.find(item => item.id.toLowerCase() === (requested || defaultResolution));
  if (!selectedResolution) {
    const error = new Error(`${selected.label} 不支持 ${resolution} 分辨率。`);
    error.code = 'VIDEO_RESOLUTION_UNSUPPORTED'; error.status = 400; error.statusCode = 400;
    throw error;
  }
  return {
    videoModel: selected.id,
    videoResolution: selectedResolution.id,
    minDurationSeconds: selected.minDurationSeconds ?? 4,
    maxDurationSeconds: selected.maxDurationSeconds,
    quality: selected.quality,
    providerModel: selected.providerModel,
    pricePerSecondCny: selectedResolution.pricePerSecondCny,
    pricePerSecondCnyRange: selectedResolution.pricePerSecondCnyRange ? { ...selectedResolution.pricePerSecondCnyRange } : null,
    label: selected.label,
    provider: selected.provider,
  };
}

export function estimateVideoCostCny(model, resolution, durationSeconds) {
  const option = resolveVideoOption(model, resolution);
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0 || option.pricePerSecondCny === null) return null;
  return Math.round(option.pricePerSecondCny * duration * 100) / 100;
}

export function estimateVideoCostRangeCny(model, resolution, durationSeconds) {
  const option = resolveVideoOption(model, resolution);
  const duration = Number(durationSeconds);
  const range = option.pricePerSecondCnyRange;
  if (!Number.isFinite(duration) || duration <= 0 || !range) return null;
  return {
    min: Math.round(range.min * duration * 100) / 100,
    max: Math.round(range.max * duration * 100) / 100,
  };
}

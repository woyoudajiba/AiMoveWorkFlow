import { readFileSync } from 'node:fs';

const sourceUrl = new URL('../docs/movement-language-library.txt', import.meta.url);
let source = '';
try { source = readFileSync(sourceUrl, 'utf8'); } catch { source = ''; }

const categoryPattern = /^\s*[^\r\n、]+、(.+?)（\d+条）\s*$/gm;
const entryPattern = /^\s*(\d+)\.\s*(.+?)（([^）]+)）\s*(?:\r?\n){1,}定义：([\s\S]*?)(?:\r?\n){1,}AI技术执行：([\s\S]*?)(?:\r?\n){1,}情绪功能：([\s\S]*?)(?:\r?\n){1,}适用场景：([\s\S]*?)(?=(?:\r?\n){2,}\s*\d+\.\s|$)/gm;
const clean = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const categories = [...source.matchAll(categoryPattern)].map(match => ({ index: match.index ?? 0, name: clean(match[1]) }));

export const MOVEMENT_LIBRARY = [...source.matchAll(entryPattern)].map(match => {
  const number = Number(match[1]);
  const category = categories.filter(item => item.index <= (match.index ?? 0)).at(-1)?.name || '基础定场与叙事运镜';
  return {
    id: `move-${number}`,
    number,
    name: clean(match[2]),
    english: clean(match[3]),
    category,
    definition: clean(match[4]),
    execution: clean(match[5]),
    emotion: clean(match[6]),
    scenes: clean(match[7])
  };
});

export const MOVEMENT_PLANNING_GUIDANCE = '运镜规划要求：每个镜头必须先从 movementCatalog 选择一个 movementId，再填写 movementPlan 和 transitionPlan。movementPlan 写清方向、速度、起止景别、焦点或特殊执行约束；transitionPlan 写清与前一镜的动作轴、视线、道具状态和切换方式。一个镜头只选一个主要运镜，复杂复合运镜只能使用库中已有条目；第一镜优先定场，后续镜头必须承接上一镜的方向和因果。movementId 只能使用 move-1 到 move-120，不得编造编号。';

const byId = new Map(MOVEMENT_LIBRARY.map(item => [item.id, item]));
const aliases = new Map(MOVEMENT_LIBRARY.flatMap(item => [
  [item.id, item.id],
  [String(item.number), item.id],
  [item.name, item.id],
  [item.english.toLowerCase(), item.id]
]));

export function movementById(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  const id = aliases.get(normalized) || aliases.get(normalized.toLowerCase());
  return id ? byId.get(id) ?? null : null;
}

export function movementIdFromText(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const exact = movementById(text);
  if (exact) return exact.id;
  const lower = text.toLowerCase();
  const match = MOVEMENT_LIBRARY.find(item => text.includes(item.name) || lower.includes(item.english.toLowerCase()));
  if (match) return match.id;
  const rules = [
    [/环绕|盘旋|orbit/i, 'move-81'],
    [/追逐|奔跑|逃跑|手持|紧迫/i, 'move-20'],
    [/俯拍|对称|正上方/i, 'move-54'],
    [/缓慢.*推|慢推/i, 'move-2'],
    [/推入|推进|靠近/i, 'move-3'],
    [/拉出|抽离|揭示环境/i, 'move-6'],
    [/横摇|横移|扫描/i, 'move-8'],
    [/纵摇|垂直|升降/i, 'move-9'],
    [/焦点|对焦|转移注意/i, 'move-71'],
    [/固定|静止|定场|空镜/i, 'move-1']
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

export function movementCatalogPrompt() {
  return MOVEMENT_LIBRARY.map(item => `- ${item.id} ${item.name}（${item.english}）｜${item.category}｜执行：${item.execution}｜适用：${item.scenes}`).join('\n');
}

export function movementLabel(value) {
  const item = movementById(value);
  return item ? `${item.name}（${item.english}，${item.id}）` : '固定机位（Static Shot，move-1）';
}

export function defaultMovementId(shot = {}) {
  return movementById(shot.movementId)?.id || movementIdFromText(`${shot.camera ?? ''} ${shot.action ?? ''}`) || 'move-1';
}

export function defaultMovementPlan(shot = {}) {
  const item = movementById(defaultMovementId(shot));
  const camera = String(shot.camera ?? '').trim() || '当前景别';
  const action = String(shot.action ?? '').trim().slice(0, 120) || '本镜动作';
  return `${item.name}：${item.execution} 本镜以${camera}呈现${action}，保持主体、视线和动作轴线连续。`;
}

export function defaultTransitionPlan(index = 0) {
  return index === 0
    ? '开场从定场或上一个片段的自然状态进入，先建立空间和主体方向。'
    : '承接上一镜的动作方向、视线和道具状态；沿同一动作轴自然切换，只有原文要求时才改变轴线。';
}

export function normalizeMovementPlan(shot = {}, index = 0) {
  const movementId = defaultMovementId(shot);
  return {
    ...shot,
    movementId,
    movementPlan: typeof shot.movementPlan === 'string' && shot.movementPlan.trim() ? shot.movementPlan.trim() : defaultMovementPlan({ ...shot, movementId }),
    transitionPlan: typeof shot.transitionPlan === 'string' && shot.transitionPlan.trim() ? shot.transitionPlan.trim() : defaultTransitionPlan(index)
  };
}

export function movementPromptLine(shot = {}) {
  const item = movementById(defaultMovementId(shot));
  const plan = String(shot.movementPlan ?? '').trim().slice(0, 260) || item?.execution || '';
  const transition = String(shot.transitionPlan ?? '').trim().slice(0, 180) || defaultTransitionPlan(Math.max(0, Number(shot.number) - 1));
  return `运镜库：${movementLabel(item?.id)}；执行计划：${plan}；镜头衔接：${transition}`;
}


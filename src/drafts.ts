import type { CharacterDraft, LookDraft, NarrativeMode, Project, SceneDraft, ShotDraft, SourceType, VisualStyle } from './types.ts';

export type StoryDraft = Pick<Project, 'title' | 'novel' | 'style'>;
export type ImportDraft = StoryDraft & { duration: 15 | 30; autoDuration: boolean; aspectRatio: '9:16' | '16:9'; sourceType: SourceType; narrativeMode: NarrativeMode; visualStyle: VisualStyle };
interface DraftTypes { story: StoryDraft; character: CharacterDraft; scene: SceneDraft; look: LookDraft; shot: ShotDraft; import: ImportDraft }
export type DraftKind = keyof DraftTypes;
export type DraftRecords<K extends DraftKind> = Record<string, DraftTypes[K]>;
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type DraftEntry<K extends DraftKind> = { value: DraftTypes[K]; updatedAt: number };
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STORAGE_LENGTH = 2_000_000;
export const draftStorageKey = (kind: DraftKind) => `aiframe-drafts-v1:${kind}`;
export const emptyImportDraft: ImportDraft = { title: '', novel: '', style: '电影写实，自然光影，细腻人物情绪', duration: 30, autoDuration: true, aspectRatio: '9:16', sourceType: 'auto', narrativeMode: 'auto', visualStyle: 'photorealistic' };
export function storyDraftContentConflict(project: Pick<Project, 'novel' | 'style' | 'segments'>, draft: StoryDraft) {
  return project.segments.length > 0 && (project.novel !== draft.novel || project.style !== draft.style);
}

export function browserDraftStorage(): DraftStorage | null {
  try { return window.localStorage; } catch { return null; }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function cleanDraft<K extends DraftKind>(kind: K, value: unknown): DraftTypes[K] | null {
  if (!record(value)) return null;
  const textFields: Record<DraftKind, Record<string, number>> = {
    story: { title: 160, novel: 120000, style: 2000 }, import: { title: 120, novel: 120000, style: 500 },
    character: { name: 100, appearance: 4000, evidence: 6000 }, scene: { name: 200, description: 4000 },
    look: { name: 200, appearance: 4000 }, shot: { scene: 2000, sceneId: 200, action: 3000, camera: 1500, movementId: 40, movementPlan: 600, transitionPlan: 400, dialogue: 3000, narration: 3000, sourceEvidence: 1200 },
  };
  const result: Record<string, unknown> = {};
  for (const [field, max] of Object.entries(textFields[kind])) {
    const optional = kind === 'shot' && (field === 'sourceEvidence' || field === 'narration');
    const movementOptional = kind === 'shot' && (field === 'movementId' || field === 'movementPlan' || field === 'transitionPlan');
    if ((optional || movementOptional) && value[field] === undefined) continue;
    const text = value[field] ?? (field === 'sceneId' ? '' : undefined);
    if (typeof text !== 'string' || text.length > max) return null;
    result[field] = text;
  }
  if (kind === 'character') {
    if (!['protagonist', 'supporting', 'extra'].includes(String(value.role))) return null;
    if (!Array.isArray(value.aliases) || value.aliases.length > 100 || value.aliases.some(alias => typeof alias !== 'string' || alias.length > 100)) return null;
    result.role = value.role; result.aliases = [...value.aliases];
  }
  if (kind === 'shot') {
    if (!Array.isArray(value.characterIds) || value.characterIds.length > 100 || value.characterIds.some(id => typeof id !== 'string' || !/^[\w-]{1,200}$/.test(id))) return null;
    if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration < 0 || value.duration > 60) return null;
    if (typeof value.trimStart !== 'number' || !Number.isFinite(value.trimStart) || value.trimStart < 0 || value.trimStart > 3600) return null;
    result.characterIds = [...value.characterIds]; result.duration = value.duration; result.trimStart = value.trimStart;
  }
  if (kind === 'import') {
    if (![15, 30].includes(Number(value.duration)) || typeof value.autoDuration !== 'boolean') return null;
    const aspectRatio = value.aspectRatio ?? '9:16';
    const sourceType = value.sourceType ?? 'auto';
    const narrativeMode = value.narrativeMode ?? 'auto';
    const visualStyle = value.visualStyle ?? 'photorealistic';
    if (!['9:16', '16:9'].includes(String(aspectRatio))) return null;
    if (!['auto', 'novel', 'script', 'article', 'paper', 'news'].includes(String(sourceType))) return null;
    if (!['auto', 'narrator', 'protagonist'].includes(String(narrativeMode))) return null;
    if (!['photorealistic', '2d-animation', '3d-animation'].includes(String(visualStyle))) return null;
    result.duration = Number(value.duration); result.autoDuration = value.autoDuration;
    // Keep pre-aspect/source drafts readable without rewriting them on load.
    if (value.aspectRatio !== undefined) result.aspectRatio = aspectRatio;
    if (value.sourceType !== undefined) result.sourceType = sourceType;
    if (value.narrativeMode !== undefined) result.narrativeMode = narrativeMode;
    if (value.visualStyle !== undefined) result.visualStyle = visualStyle;
  }
  const serialized = JSON.stringify(result);
  if (/data:[^;\s]+;base64,|\bsk-[a-z0-9_-]{20,}|\bBearer\s+[a-z0-9._-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(serialized)) return null;
  return result as DraftTypes[K];
}
function readEntries<K extends DraftKind>(storage: DraftStorage, kind: K, now: number): Record<string, DraftEntry<K>> {
  const raw = storage.getItem(draftStorageKey(kind));
  if (!raw || raw.length > MAX_STORAGE_LENGTH) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!record(parsed) || parsed.version !== 1 || !record(parsed.entries)) return {};
  const entries: Record<string, DraftEntry<K>> = {};
  for (const [key, entry] of Object.entries(parsed.entries).slice(0, 1000)) {
    if (!/^[\w:-]{1,220}$/.test(key) || !record(entry) || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt)) continue;
    if (entry.updatedAt > now || now - entry.updatedAt >= DRAFT_TTL_MS) continue;
    const value = cleanDraft(kind, entry.value);
    if (value) Object.defineProperty(entries, key, { value: { value, updatedAt: entry.updatedAt }, enumerable: true });
  }
  return entries;
}
export function readDrafts<K extends DraftKind>(storage: DraftStorage | null, kind: K, now = Date.now()): { drafts: DraftRecords<K>; unavailable: boolean } {
  try {
    if (!storage) return { drafts: {}, unavailable: true };
    const entries = readEntries(storage, kind, now);
    return { drafts: Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.value])), unavailable: false };
  } catch { return { drafts: {}, unavailable: true }; }
}
export function mergeDraftChanges<K extends DraftKind>(stored: DraftRecords<K>, before: DraftRecords<K>, after: DraftRecords<K>): DraftRecords<K> {
  const merged = { ...stored };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (!Object.hasOwn(after, key)) delete merged[key];
    else Object.defineProperty(merged, key, { value: after[key], enumerable: true, configurable: true, writable: true });
  }
  return merged;
}
export function writeDrafts<K extends DraftKind>(storage: DraftStorage | null, kind: K, drafts: DraftRecords<K>, now = Date.now()): 'saved' | 'skipped' | 'unavailable' {
  try {
    if (!storage) return 'unavailable';
    const previous = readEntries(storage, kind, now);
    const entries: Record<string, DraftEntry<K>> = {};
    let skipped = false;
    for (const [key, candidate] of Object.entries(drafts)) {
      if (!/^[\w:-]{1,220}$/.test(key)) { skipped = true; continue; }
      const value = cleanDraft(kind, candidate);
      const old = previous[key];
      if (!value) {
        skipped = true;
        if (Object.hasOwn(previous, key)) Object.defineProperty(entries, key, { value: old, enumerable: true });
        continue;
      }
      Object.defineProperty(entries, key, { value: { value, updatedAt: old && JSON.stringify(old.value) === JSON.stringify(value) ? old.updatedAt : now }, enumerable: true });
    }
    if (!Object.keys(entries).length) storage.removeItem(draftStorageKey(kind));
    else {
      const raw = JSON.stringify({ version: 1, entries });
      if (raw.length > MAX_STORAGE_LENGTH) return 'unavailable';
      storage.setItem(draftStorageKey(kind), raw);
    }
    return skipped ? 'skipped' : 'saved';
  } catch { return 'unavailable'; }
}

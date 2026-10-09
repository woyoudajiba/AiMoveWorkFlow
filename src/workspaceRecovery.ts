import type { AccountStorage } from './accountStorage';
import type { View } from './types';

export const workspaceRecoveryKey = 'aiframe-workspace-v1';
const workspaceRecoveryVersion = 1;
const workspaceRecoveryTtlMs = 30 * 24 * 60 * 60 * 1000;
const views = new Set<View>(['story', 'characters', 'assets', 'looks', 'storyboard', 'videos']);

export type WorkspaceRecovery = {
  projectId: string;
  view: Exclude<View, 'history' | 'projects'>;
  segmentId?: string;
  shotId?: string;
  characterId?: string;
  sceneId?: string;
  lookId?: string;
  savedAt: number;
};

export type WorkspaceRecoveryInput = Omit<WorkspaceRecovery, 'savedAt'> & { savedAt?: number };

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
}

function clean(value: unknown, now: number): WorkspaceRecovery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== workspaceRecoveryVersion || !id(candidate.projectId) || !views.has(candidate.view as View)) return null;
  const savedAt = candidate.savedAt;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt) || savedAt > now || now - savedAt >= workspaceRecoveryTtlMs) return null;
  const result: WorkspaceRecovery = {
    projectId: candidate.projectId,
    view: candidate.view as WorkspaceRecovery['view'],
    savedAt,
  };
  for (const key of ['segmentId', 'shotId', 'characterId', 'sceneId', 'lookId'] as const) {
    if (candidate[key] !== undefined) {
      if (!id(candidate[key])) return null;
      result[key] = candidate[key];
    }
  }
  return result;
}

export function readWorkspaceRecovery(storage: AccountStorage | null, now = Date.now()): WorkspaceRecovery | null {
  try {
    const raw = storage?.getItem(workspaceRecoveryKey);
    if (!raw || raw.length > 10_000) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return clean(parsed, now);
  } catch {
    return null;
  }
}

export function writeWorkspaceRecovery(storage: AccountStorage | null, value: WorkspaceRecoveryInput, now = Date.now()): boolean {
  try {
    if (!storage || !id(value.projectId) || !views.has(value.view)) return false;
    const candidate = { version: workspaceRecoveryVersion, ...value, savedAt: value.savedAt ?? now };
    if (!clean(candidate, now)) return false;
    storage.setItem(workspaceRecoveryKey, JSON.stringify(candidate));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspaceRecovery(storage: AccountStorage | null): void {
  try { storage?.removeItem(workspaceRecoveryKey); } catch { /* Storage can be disabled by the browser. */ }
}

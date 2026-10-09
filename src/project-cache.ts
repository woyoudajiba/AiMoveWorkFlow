export type ProjectCache<T extends { id: string }> = {
  get: (id: string) => T | null;
  set: (id: string, value: T) => void;
  delete: (id: string) => void;
  clear: () => void;
};

export function createProjectCache<T extends { id: string }>(maxEntries = 4): ProjectCache<T> {
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1;
  const entries = new Map<string, T>();
  const touch = (id: string, value: T) => {
    entries.delete(id);
    entries.set(id, value);
    while (entries.size > limit) entries.delete(entries.keys().next().value as string);
  };
  return {
    get(id) {
      const value = entries.get(id);
      if (!value) return null;
      touch(id, value);
      return value;
    },
    set(id, value) { touch(id, value); },
    delete(id) { entries.delete(id); },
    clear() { entries.clear(); },
  };
}

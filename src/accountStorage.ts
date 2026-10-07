export type AccountStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// The prefix is captured once so an old component's cleanup cannot write into a new account.
export function scopedAccountStorage(storage: AccountStorage | null, accountKey: string): AccountStorage | null {
  if (!storage || !/^[a-zA-Z0-9_-]{1,128}$/.test(accountKey)) return null;
  const prefix = `aiframe-account-v1:${accountKey}:`;
  return {
    getItem: key => storage.getItem(prefix + key),
    setItem: (key, value) => storage.setItem(prefix + key, value),
    removeItem: key => storage.removeItem(prefix + key),
  };
}

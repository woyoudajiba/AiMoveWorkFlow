import { createContext, useContext } from 'react';
import type { AccountStorage } from './accountStorage';

export type StudioUser = { id: string; username: string; displayName: string; role: string; membershipTier: string };
export type AccountContextValue = { user: StudioUser; accountKey: string; sessionId: string; storage: AccountStorage | null; logout: () => void };
export const AccountContext = createContext<AccountContextValue | null>(null);
export function useAccount() {
  const account = useContext(AccountContext);
  if (!account) throw new Error('请登录后再打开创作空间。');
  return account;
}

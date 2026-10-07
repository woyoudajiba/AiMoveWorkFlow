import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { mergeDraftChanges, readDrafts, writeDrafts, type DraftKind, type DraftRecords } from './drafts';
import { useAccount } from './accountContext';

export function useDrafts<K extends DraftKind>(kind: K) {
  const account = useAccount();
  const [storage] = useState(() => account.storage);
  const [loaded] = useState(() => readDrafts(storage, kind));
  const [drafts, setState] = useState<DraftRecords<K>>(loaded.drafts);
  const [status, setStatus] = useState<'saved' | 'pending' | 'skipped' | 'unavailable'>(loaded.unavailable ? 'unavailable' : 'saved');
  const latest = useRef(drafts);
  const persisted = useRef(drafts);
  const timer = useRef<number | undefined>(undefined);
  const recovered = useRef(new Set(Object.keys(loaded.drafts)));
  const needsSave = useRef(false);
  const lastResult = useRef<'saved' | 'skipped' | 'unavailable'>(loaded.unavailable ? 'unavailable' : 'saved');
  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (needsSave.current) {
      const stored = readDrafts(storage, kind);
      lastResult.current = stored.unavailable ? 'unavailable' : writeDrafts(storage, kind, mergeDraftChanges<K>(stored.drafts, persisted.current, latest.current));
      needsSave.current = lastResult.current !== 'saved';
      if (!needsSave.current) persisted.current = latest.current;
    }
    return lastResult.current;
  }, [kind, storage]);
  const setDrafts = useCallback((update: SetStateAction<DraftRecords<K>>) => {
    const next = typeof update === 'function' ? update(latest.current) : update;
    if (next === latest.current) return;
    latest.current = next;
    needsSave.current = true;
    setState(next); setStatus('pending');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus(flush()), 250);
  }, [flush]);
  useEffect(() => {
    const save = () => setStatus(flush());
    const hidden = () => { if (document.hidden) save(); };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', hidden);
      flush();
    };
  }, [flush]);
  return [drafts, setDrafts, { status, recoveredKeys: Object.keys(drafts).filter(key => recovered.current.has(key)) }] as const;
}

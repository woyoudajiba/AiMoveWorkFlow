import { useCallback, useEffect, useState } from 'react';
import { FolderInput, RefreshCw } from 'lucide-react';
import { api, readableError } from './api';
import { useAccount } from './accountContext';
import { Modal, Spinner } from './components';

type LegacyState = { available: boolean; count: number; claimed: boolean };
export function LegacyImport({ onImported }: { onImported: () => Promise<void> }) {
  const { user } = useAccount();
  const [legacy, setLegacy] = useState<LegacyState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try { setLegacy(await api<LegacyState>('/api/auth/legacy', 'GET', undefined, signal)); }
    catch (failure) { if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(readableError(failure)); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function importLegacy() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const next = await api<{ imported: number }>('/api/auth/legacy', 'POST', { confirm: true });
      setOpen(false); setLegacy({ available: false, count: 0, claimed: true });
      setResult('已导入 ' + next.imported + ' 个旧版作品。请重新配置模型，并核实未完成任务。');
      await onImported();
    } catch (failure) { setError(readableError(failure)); }
    finally { setBusy(false); }
  }
  if (!legacy?.available && !error && !result) return null;
  return <>
    <div className="legacy-banner" role="status"><FolderInput size={17} /><span>{result || (legacy?.available ? '发现 ' + legacy.count + ' 个旧版本本机作品，可导入当前账号。' : '旧版本作品状态暂时无法读取。')}</span>{legacy?.available ? <button className="text-button" onClick={() => { setError(''); setOpen(true); }}>查看并导入</button> : error ? <button className="text-button" onClick={() => void load()}><RefreshCw size={14} />重试</button> : <button className="text-button" onClick={() => setResult('')}>知道了</button>}</div>
    {open && <Modal title="导入旧版本本机作品" subtitle={'归属账号：' + (user.displayName || user.username)} close={() => { if (!busy) setOpen(false); }}>
      <div className="legacy-confirm"><p>将这台电脑上的 {legacy?.count || 0} 个旧作品复制到当前账号，原文件保留。</p><ul><li>导入后归属于当前账号，其他账号无法再次导入。</li><li>旧模型密钥不会复制，请在“模型连接”中重新配置。</li><li>未完成任务需要核实状态，不会自动重新提交付费生成。</li></ul><p>请确认这些作品属于你，再继续导入。</p></div>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <div className="modal-footer"><button className="button secondary" disabled={busy} onClick={() => setOpen(false)}>取消</button><button className="button primary" disabled={busy} onClick={() => void importLegacy()}>{busy ? <Spinner /> : <FolderInput size={16} />}{busy ? '正在导入' : '确认导入当前账号'}</button></div>
    </Modal>}
  </>;
}

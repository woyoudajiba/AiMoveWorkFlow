import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Film, LockKeyhole, RefreshCw, ShieldCheck, UserRound, WifiOff } from 'lucide-react';
import App from './App';
import { api, ApiError, readableError, setApiSession, subscribeAuthFailure } from './api';
import { AccountContext, type StudioUser } from './accountContext';
import { scopedAccountStorage } from './accountStorage';
import { browserDraftStorage } from './drafts';
import { Spinner } from './components';
import './auth.css';

type AuthStatus = { authenticated: boolean; user: StudioUser | null; expiresAt: string | null; rememberAvailable: boolean; remembered: boolean; sessionId: string | null; accountKey: string | null };
const signedOut: AuthStatus = { authenticated: false, user: null, expiresAt: null, rememberAvailable: false, remembered: false, sessionId: null, accountKey: null };
type Phase = 'checking' | 'login' | 'ready' | 'unavailable';
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export default function AuthGate() {
  const [status, setStatus] = useState<AuthStatus>(signedOut);
  const [phase, setPhase] = useState<Phase>('checking');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [informational, setInformational] = useState(false);
  const version = useRef(0);
  const active = useRef<AuthStatus | null>(null);
  const checking = useRef<number | null>(null);

  const leave = useCallback((message: string, unavailable = false, info = false) => {
    version.current++; checking.current = null; active.current = null; setApiSession(null);
    setStatus(previous => ({ ...previous, authenticated: false, user: null, sessionId: null, accountKey: null }));
    setPassword(''); setError(message); setInformational(info); setBusy(false); setPhase(unavailable ? 'unavailable' : 'login');
  }, []);
  const accept = useCallback((next: AuthStatus) => {
    if (next.authenticated && (!next.user?.id || !next.user.username || !next.sessionId || !next.accountKey || !/^[a-zA-Z0-9_-]{1,128}$/.test(next.accountKey))) {
      throw new ApiError('账号信息暂时无法确认，请重试。', 503, 'AUTH_UNAVAILABLE');
    }
    if (next.authenticated && active.current && (next.accountKey !== active.current.accountKey || next.user?.id !== active.current.user?.id)) {
      leave('账号已在其他窗口切换。请点击“重新确认登录状态”，确认本机当前账号。'); return;
    }
    const wasSignedIn = !!active.current;
    active.current = next.authenticated ? next : null;
    setApiSession(next.authenticated ? next.sessionId : null);
    setStatus(next); setPhase(next.authenticated ? 'ready' : 'login');
    setInformational(false);
    setRemember(next.rememberAvailable && next.remembered);
    setError(!next.authenticated && wasSignedIn ? '登录已失效，请重新登录。草稿仍保存在原账号下。' : '');
  }, [leave]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (checking.current !== null) return;
    const request = ++version.current;
    checking.current = request;
    try {
      const timeout = AbortSignal.timeout(30000);
      const next = await api<AuthStatus>('/api/auth/status', 'GET', undefined, signal ? AbortSignal.any([signal, timeout]) : timeout);
      if (request === version.current) accept(next);
    } catch (failure) {
      if (request !== version.current || aborted(failure)) return;
      const unauthenticated = failure instanceof ApiError && [401, 403].includes(failure.status);
      const transient = failure instanceof ApiError && (failure.code === 'AUTH_UNAVAILABLE' || failure.code === 'LOCAL_UNAVAILABLE' || failure.status >= 500);
      if (failure instanceof ApiError && failure.code === 'SESSION_CHANGED' && active.current) {
        setApiSession(null);
        setInformational(true);
        setError('登录状态已变化，正在重新确认当前账号。');
        // Retry after releasing the in-flight guard. The retry has no stale
        // X-Studio-Session header and lets the server issue the new local ID.
        if (checking.current === request) checking.current = null;
        void refresh();
        return;
      }
      if (transient && active.current) {
        // Keep the current account and mounted workspace during a temporary
        // TDL/network outage. The next interval or visibility check retries it.
        setInformational(true);
        setPhase('ready');
        return;
      }
      leave(readableError(failure), !unauthenticated);
    } finally { if (checking.current === request) checking.current = null; }
  }, [accept, leave]);

  useEffect(() => subscribeAuthFailure(failure => {
    if (failure.code === 'SESSION_CHANGED' && active.current) {
      // A restarted service rotates the local session ID. Re-check the
      // account before unmounting the workspace; only a real account switch
      // should send the user back to the login screen.
      setInformational(true);
      setError('登录状态已变化，正在重新确认当前账号。');
      void refresh();
      return;
    }
    leave(readableError(failure), failure.code === 'AUTH_UNAVAILABLE');
  }), [leave, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { controller.abort(); checking.current = null; version.current++; };
  }, [refresh]);
  useEffect(() => {
    if (phase !== 'ready') return;
    const timer = window.setInterval(() => { void refresh(); }, 30000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [phase, refresh]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !username.trim() || !password) return;
    const request = ++version.current;
    const credentials = { username: username.trim(), password, remember: remember && status.rememberAvailable };
    setPassword(''); setBusy(true); setError(''); setInformational(false);
    try {
      const next = await api<AuthStatus>('/api/auth/login', 'POST', credentials, AbortSignal.timeout(30000));
      if (request === version.current) {
        if (!next.authenticated) throw new ApiError('登录未完成，请重新输入密码。', 401, 'AUTH_REQUIRED');
        accept(next);
      }
    } catch (failure) {
      if (request === version.current && !aborted(failure)) setError(readableError(failure));
    } finally {
      credentials.password = '';
      if (request === version.current) setBusy(false);
    }
  }
  const logout = useCallback(async () => {
    const request = ++version.current;
    setBusy(true); setPhase('checking'); setPassword(''); setError('');
    try {
      await api('/api/auth/logout', 'POST', {}, AbortSignal.timeout(30000));
      if (request === version.current) leave('已退出登录。作品与草稿保留在原账号下。', false, true);
    } catch {
      if (request === version.current) leave('已关闭此窗口的工作台，但暂时无法确认账号已退出。请恢复连接后重新登录。');
    }
  }, [leave]);
  const account = useMemo(() => status.user && status.accountKey ? {
    user: status.user, accountKey: status.accountKey, sessionId: status.sessionId || '',
    storage: scopedAccountStorage(browserDraftStorage(), status.accountKey),
    logout: () => { void logout(); },
  } : null, [status.user, status.accountKey, logout]);

  if (phase === 'ready' && account && status.sessionId) return <AccountContext.Provider value={account}><App key={status.sessionId} /></AccountContext.Provider>;
  return <main className="auth-shell">
    <section className="auth-story" aria-label="映序短剧工作台">
      <div className="brand auth-brand"><span className="brand-mark"><Film size={30} strokeWidth={1.5} /></span><span className="brand-name">映序<span>AI FRAME</span></span></div>
      <div className="auth-story-copy"><span className="eyebrow">EVERY STORY DESERVES A SCREEN</span><h1>故事入场，<br />让想象成为影像<span>。</span></h1><p>从小说、人物到分镜与成片，<br />在属于你的创作空间里，接续每一个灵感。</p></div>
      <div className="auth-story-footer"><span className="status-dot" />云端保存作品 · 分镜人工审核 · 网页与客户端同一工作区</div>
    </section>
    <section className="auth-panel" aria-label="账号登录">
      {phase === 'checking' ? <div className="auth-progress" role="status"><Spinner size={30} /><h2>{busy ? '正在退出账号' : '正在确认登录状态'}</h2><p>正在连接美怡莱 TDL 账号服务。</p></div> : phase === 'unavailable' ? <div className="auth-progress"><WifiOff size={31} /><h2>暂时无法验证账号</h2><p role="alert">{error || '请检查网络连接后重试。'}</p><button className="button primary" onClick={() => { setPhase('checking'); setError(''); void refresh(); }}><RefreshCw size={16} />重新验证</button><p className="auth-small-note">本机作品和草稿仍保留。验证成功后即可继续。</p></div> : <>
        <div className="auth-heading"><span className="eyebrow">WELCOME TO AI FRAME</span><h2>登录创作空间</h2><p>沿用你的<strong>美怡莱 TDL 账号</strong>，无需重复注册。</p></div>
        <form className="auth-form" onSubmit={login} aria-busy={busy}>
          <label htmlFor="auth-username">账号<span className="auth-input"><UserRound size={17} /><input id="auth-username" name="username" autoComplete="username" maxLength={64} autoFocus value={username} onChange={event => setUsername(event.target.value)} placeholder="输入 TDL 账号" required disabled={busy} /></span></label>
          <label htmlFor="auth-password">密码<span className="auth-input"><LockKeyhole size={17} /><input id="auth-password" name="password" type="password" autoComplete="current-password" maxLength={120} value={password} onChange={event => setPassword(event.target.value)} placeholder="输入账号密码" required disabled={busy} /></span></label>
          <label className="auth-remember"><input type="checkbox" checked={remember && status.rememberAvailable} onChange={event => setRemember(event.target.checked)} disabled={busy || !status.rememberAvailable} /><span>在这台电脑上记住登录</span></label>
          <p className="auth-remember-note">{status.rememberAvailable ? '仅加密保存登录凭证，不保存密码。共用电脑请勿勾选。' : '当前环境无法安全保存登录凭证，仅支持本次登录。'}</p>
          {error && <div className={informational ? 'auth-notice' : 'auth-error'} role={informational ? 'status' : 'alert'}>{error}</div>}
          <button className="button primary auth-submit" type="submit" disabled={busy || !username.trim() || !password}>{busy ? <Spinner size={18} /> : <ArrowRight size={18} />}{busy ? '正在登录' : '登录并开始创作'}</button>
          <button className="button secondary" type="button" disabled={busy} onClick={() => { setPassword(''); setPhase('checking'); setError(''); void refresh(); }}><RefreshCw size={15} />重新确认登录状态</button>
          <p className="auth-remember-note">主动确认当前登录账号，验证成功后进入该账号的云端创作空间。</p>
        </form>
        <div className="auth-assurance"><ShieldCheck size={18} /><p>账号通过 HTTPS 安全验证。<br />作品、素材、任务和历史按账号保存在同一工作区。</p></div>
        <p className="auth-help">账号注册或密码问题，请在美怡莱 TDL 中处理。</p>
      </>}
    </section>
  </main>;
}

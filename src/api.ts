export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = '') {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code;
  }
}
export function isMissingProjectError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const value = error as { status?: unknown; code?: unknown };
  return value.status === 404 && (value.code === 'NOT_FOUND' || value.code === 'PROJECT_NOT_FOUND');
}
const SESSION_STORAGE_KEY = 'aiframe-local-session';
function storedSession() {
  try {
    const storage = typeof window !== 'undefined' ? window.sessionStorage : null;
    const value = storage?.getItem(SESSION_STORAGE_KEY) || '';
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  } catch { return null; }
}
let sessionId: string | null = storedSession();
let sessionVersion = 0;
const authListeners = new Set<(error: ApiError) => void>();
export function setApiSession(next: string | null) {
  if (next !== sessionId) { sessionId = next; sessionVersion++; }
  try {
    const storage = typeof window !== 'undefined' ? window.sessionStorage : null;
    if (next) storage?.setItem(SESSION_STORAGE_KEY, next);
    else storage?.removeItem(SESSION_STORAGE_KEY);
  } catch { /* A blocked tab session store must not stop authentication. */ }
}
export function subscribeAuthFailure(listener: (error: ApiError) => void) {
  authListeners.add(listener);
  return () => { authListeners.delete(listener); };
}
function rejectStaleResponse(version: number) {
  if (version !== sessionVersion) throw new DOMException('此请求所属的账号会话已结束。', 'AbortError');
}
function appBasePath() {
  if (typeof window === 'undefined' || !window.location?.pathname) return '';
  const path = window.location.pathname;
  return path === '/' ? '' : path.replace(/\/$/, '');
}
export function assetUrl(value: string | null | undefined) {
  if (!value) return '';
  const base = appBasePath();
  if (value.startsWith('/media/')) return `${base}${value}`;
  // Production is served below /workf/, so API responses may already carry
  // the public base path. Do not prepend it twice.
  if (base && value.startsWith(`${base}/media/`)) return value;
  return value;
}
export function assetPreviewUrl(value: string | null | undefined) {
  if (!value) return '';
  const base = appBasePath();
  if (value.startsWith('/media/')) return `${base}${value.replace(/^\/media\//, '/media-thumb/')}`;
  if (base && value.startsWith(`${base}/media/`)) return `${base}/media-thumb/${value.slice(`${base}/media/`.length)}`;
  return value;
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const requestSession = sessionId;
  const version = sessionVersion;
  let response: Response;
  try {
    const requestPath = path.startsWith('/api/') ? `${appBasePath()}${path}` : path;
    response = await fetch(requestPath, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Local-Client': 'aiframe', ...(requestSession ? { 'X-Studio-Session': requestSession } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error) {
    rejectStaleResponse(version);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('暂时无法连接本地服务，请稍后重试。', 0, 'LOCAL_UNAVAILABLE');
  }
  const text = await response.text();
  rejectStaleResponse(version);
  let result: unknown;
  try { result = text ? JSON.parse(text) : {}; }
  catch { throw new Error('工作台服务暂时无法响应，请确认本地服务正在运行。'); }
  if (!response.ok) {
    const failure = (result && typeof result === 'object' ? result : {}) as { error?: string; code?: string };
    const error = new ApiError(typeof failure.error === 'string' ? failure.error : `请求失败（${response.status}）`, response.status, typeof failure.code === 'string' ? failure.code : '');
    // A temporary upstream/account-service outage must not log the user out.
    // The auth gate can retry the existing local session once the service is back.
    const authFailure = ([401, 403].includes(error.status) && error.code.startsWith('AUTH_')) || (error.status === 409 && error.code === 'SESSION_CHANGED');
    if (requestSession && authFailure) {
      setApiSession(null);
      for (const listener of authListeners) listener(error);
    }
    throw error;
  }
  return result as T;
}

export async function imageData(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
  if (file.size > 15 * 1024 * 1024) throw new Error('图片不能超过 15 MB。');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('图片读取失败，请重试。'));
    reader.readAsDataURL(file);
  });
}

export const readableError = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';

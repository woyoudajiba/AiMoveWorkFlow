import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const PASSWORD_LIMIT = 256;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const COOKIE_NAME = 'aiframe_admin_session';
const error = (message, code = 'ADMIN_AUTH_REQUIRED', status = 401) => Object.assign(new Error(message), { code, status });

function validPassword(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= PASSWORD_LIMIT && !/[\x00\r\n]/.test(value);
}

export function hashAdminPassword(password, { salt = randomBytes(16).toString('hex') } = {}) {
  if (!validPassword(password)) throw error('管理员密码格式无效。', 'ADMIN_PASSWORD_INVALID', 400);
  if (typeof salt !== 'string' || !/^[a-f0-9]{16,128}$/i.test(salt)) throw error('管理员密码盐值无效。', 'ADMIN_PASSWORD_INVALID', 400);
  const digest = scryptSync(password, Buffer.from(salt, 'hex'), SCRYPT_KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 32 * 1024 * 1024 }).toString('hex');
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toLowerCase()}$${digest}`;
}

export function verifyAdminPassword(password, encoded) {
  if (!validPassword(password) || typeof encoded !== 'string') return false;
  const match = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([a-f0-9]{16,128})\$([a-f0-9]{64})$/i.exec(encoded.trim());
  if (!match) return false;
  const [, nText, rText, pText, salt, digest] = match;
  const n = Number(nText), r = Number(rText), p = Number(pText);
  if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  try {
    const actual = scryptSync(password, Buffer.from(salt, 'hex'), SCRYPT_KEY_LENGTH, { N: n, r, p, maxmem: 32 * 1024 * 1024 });
    const expected = Buffer.from(digest, 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function suppliedCookie(req, name) {
  return (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
}

export function createAdminAuth({ passwordHash = process.env.AI_FRAME_ADMIN_PASSWORD_HASH, secureCookie = process.env.NODE_ENV === 'production', cookiePath = process.env.AI_FRAME_BASE_PATH || '/', now = () => Date.now() } = {}) {
  const sessions = new Map();
  const attempts = [];
  const name = COOKIE_NAME;
  const path = typeof cookiePath === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(cookiePath) ? cookiePath.replace(/\/+$/, '') || '/' : '/admin';

  function cookie(res, value, maxAge = SESSION_TTL_MS / 1000) {
    const parts = [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${value ? Math.floor(maxAge) : 0}`];
    if (secureCookie) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  function prune() {
    const current = now();
    for (const [token, session] of sessions) if (session.expiresAt <= current) sessions.delete(token);
    while (attempts.length && attempts[0] <= current - 60_000) attempts.shift();
  }
  function requireConfigured() {
    if (!verifyAdminPassword('__configuration_probe__', passwordHash)) {
      // The probe intentionally cannot pass; this only validates the encoded format without exposing it.
      if (typeof passwordHash !== 'string' || !/^scrypt\$\d+\$\d+\$\d+\$[a-f0-9]{16,128}\$[a-f0-9]{64}$/i.test(passwordHash.trim())) throw error('管理员尚未配置，请联系系统维护人员。', 'ADMIN_NOT_CONFIGURED', 503);
    }
  }
  function get(req) {
    prune();
    const token = suppliedCookie(req, name);
    const session = token ? sessions.get(token) : null;
    if (!session) return null;
    if (session.expiresAt <= now()) { sessions.delete(token); return null; }
    return { token, ...session };
  }
  return {
    cookieName: name,
    isConfigured() { return typeof passwordHash === 'string' && /^scrypt\$\d+\$\d+\$\d+\$[a-f0-9]{16,128}\$[a-f0-9]{64}$/i.test(passwordHash.trim()); },
    status(req) { return { authenticated: Boolean(get(req)) }; },
    require(req) { return get(req) || (() => { throw error('请先登录管理员账号。'); })(); },
    async login(input, res) {
      prune();
      if (attempts.length >= 8) throw error('管理员登录请求过于频繁，请稍后再试。', 'ADMIN_RATE_LIMITED', 429);
      attempts.push(now());
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'password')) throw error('管理员登录参数无效。', 'ADMIN_INPUT_INVALID', 400);
      requireConfigured();
      if (!verifyAdminPassword(input.password, passwordHash)) throw error('管理员密码错误。', 'ADMIN_INVALID_CREDENTIALS', 401);
      const token = randomBytes(32).toString('hex');
      const expiresAt = now() + SESSION_TTL_MS;
      sessions.set(token, { createdAt: now(), expiresAt });
      cookie(res, token);
      return { authenticated: true, expiresAt: new Date(expiresAt).toISOString() };
    },
    logout(req, res) {
      const token = suppliedCookie(req, name);
      if (token) sessions.delete(token);
      cookie(res, '');
      return { authenticated: false };
    },
  };
}

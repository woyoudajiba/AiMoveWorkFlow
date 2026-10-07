const DEFAULT_REMOTE_URL = 'https://wsfile.cn/workf/';

function resolveClientTarget({ isPackaged, smokeDirectory, env = process.env } = {}) {
  const local = !isPackaged || Boolean(smokeDirectory) || env.AIFRAME_LOCAL_MODE === '1';
  if (local) return { mode: 'local', url: '' };
  const value = String(env.AIFRAME_REMOTE_URL || DEFAULT_REMOTE_URL).trim();
  let url;
  try { url = new URL(value); } catch { throw new Error('AIFRAME_REMOTE_URL 必须是有效的 HTTPS 地址。'); }
  if (url.protocol !== 'https:') throw new Error('AIFRAME_REMOTE_URL 只允许使用 HTTPS。');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return { mode: 'remote', url: url.href };
}

module.exports = { DEFAULT_REMOTE_URL, resolveClientTarget };

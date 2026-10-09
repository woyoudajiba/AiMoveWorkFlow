import {chmod, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

// The web service needs to survive a process restart without exposing the TDL
// bearer token to the browser. The file is private to the service account and
// is replaced atomically so a crash cannot leave a partially written session.
export function createFileAuthStore(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('AI_FRAME_AUTH_FILE must be an absolute path.');
  const load = async () => {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  };
  const save = async value => {
    if (value === null) { await rm(file, { force: true }); return; }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  };
  return { load, save };
}

// Persistent sessions are keyed by the random local session ID. A single
// bearer-token object cannot be shared by a multi-user web process: doing so
// makes one account's login, validation, or logout mutate every other account.
export function createFileAuthSessionStore(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('AI_FRAME_AUTH_FILE must be an absolute path.');
  const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const readSessions = async () => {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (!value || value.version !== 2 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) return {};
      return Object.fromEntries(Object.entries(value.sessions).filter(([id, session]) => validId(id) && session && typeof session === 'object'));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw error;
    }
  };
  const writeSessions = async sessions => {
    if (!Object.keys(sessions).length) { await rm(file, { force: true }); return; }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 2, sessions }), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  };
  let pending = Promise.resolve();
  const enqueue = operation => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const load = sessionId => {
    if (!validId(sessionId)) throw new Error('Invalid local session ID.');
    return enqueue(async () => (await readSessions())[sessionId] || null);
  };
  const save = (sessionId, value) => {
    if (!validId(sessionId)) throw new Error('Invalid local session ID.');
    return enqueue(async () => {
      const sessions = await readSessions();
      if (value === null) delete sessions[sessionId];
      else sessions[sessionId] = value;
      await writeSessions(sessions);
    });
  };
  return { load, save };
}

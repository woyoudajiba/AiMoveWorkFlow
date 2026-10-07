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

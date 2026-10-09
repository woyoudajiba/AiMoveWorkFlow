import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { validateAnalysis } from './domain.mjs';
import { emptyAnalysisState } from './analysis-results.mjs';
import { safeError } from './network.mjs';

const VERSION = 3;

export async function openAnalysisCheckpoint(root, project, model, totalChunks, enabled, { retryUncertain = false, retryDeterministic = false, sourceText = project.novel, appendFrom = 0, mode = 'full', initialState = null } = {}) {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: VERSION, novel: project.novel, sourceText, appendFrom, mode, style: project.style,
    aspectRatio: project.aspectRatio, narrativeMode: project.narrativeMode ?? 'auto', duration: project.duration,
    durationMode: project.durationMode ?? 'fixed', analysisSegmentMaxDuration: 15, model, totalChunks,
  })).digest('hex');
  if (enabled && !/^[A-Za-z0-9_-]{1,100}$/.test(project.id ?? '')) throw safeError('分析作品标识无效。', 'INVALID_INPUT');
  const file = enabled ? path.join(root, `${project.id}-${fingerprint}.json`) : null;
  let snapshot = { nextChunk: 0, phase: 'ready', state: initialState ? structuredClone(initialState) : emptyAnalysisState(), pendingCorrection: null };
  if (file) {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (saved.version !== VERSION || saved.fingerprint !== fingerprint || !Number.isInteger(saved.nextChunk) || saved.nextChunk < 0 || saved.nextChunk > totalChunks || !['ready', 'pending', 'correcting'].includes(saved.phase)) throw new Error('invalid checkpoint');
      const state = { ...saved.state, idMap: new Map(saved.state.idMap), ambiguousCharacterRefs: new Set(saved.state.ambiguousCharacterRefs) };
      if (saved.nextChunk) validateAnalysis(state, project);
      else if (['characters', 'segments', 'scenes', 'looks'].some(key => !Array.isArray(state[key]) || state[key].length)) throw new Error('invalid initial checkpoint');
      if ([...state.idMap.values()].some(id => !state.characters.some(character => character.id === id))) throw new Error('invalid identity map');
      const pendingCorrection = saved.phase === 'correcting' && saved.pendingCorrection && saved.pendingCorrection.chunkIndex === saved.nextChunk
        ? saved.pendingCorrection
        : null;
      if (saved.phase === 'correcting' && !pendingCorrection) throw new Error('invalid correction checkpoint');
      snapshot = { nextChunk: saved.nextChunk, phase: saved.phase, state, pendingCorrection };
    } catch (error) {
      if (error.code !== 'ENOENT') throw safeError('分析进度文件无法校验，请保留文件并检查；不会自动从头重复提交。', 'ANALYSIS_CHECKPOINT_INVALID');
    }
  }
  if (['pending', 'correcting'].includes(snapshot.phase) && retryUncertain !== true && retryDeterministic !== true) {
    const label = snapshot.phase === 'correcting' ? '纠正请求' : '提交';
    throw safeError(`第 ${snapshot.nextChunk + 1}/${totalChunks} 块的${label}结果仍待核实，已完成块保留；不会自动重复提交。`, 'SUBMISSION_UNKNOWN');
  }
  async function save(nextChunk, state, phase, extra = {}) {
    if (!file) return;
    const record = { version: VERSION, fingerprint, model, totalChunks, nextChunk, phase, updatedAt: new Date().toISOString(), state: { ...state, idMap: [...state.idMap], ambiguousCharacterRefs: [...state.ambiguousCharacterRefs] }, ...(phase === 'correcting' && extra.pendingCorrection ? { pendingCorrection: extra.pendingCorrection } : {}) };
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  }
  return { ...snapshot, save };
}

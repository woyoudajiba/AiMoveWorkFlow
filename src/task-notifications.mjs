export const STALLED_AFTER_MS = 120_000;

const generationKinds = new Set(['character', 'asset', 'look', 'image', 'storyboard', 'video', 'segment-video', 'export']);
const labels = {
  analyze: '文本分析',
  character: '身份参考',
  asset: '关键物品',
  look: '造型三视图',
  image: '分镜生图',
  storyboard: '整段分镜板',
  video: '镜头视频',
  'segment-video': '片段完整视频',
  export: '成片导出',
};

const updatedAt = job => Date.parse(job.updatedAt || job.createdAt || '') || 0;
const taskLabel = job => labels[job.kind] || '制作任务';

const isStalled = (job, now, timestamp = updatedAt(job)) => {
  // A text analysis request can spend several minutes inside one model call
  // while its chunk number stays unchanged. The server has its own bounded
  // request timeout and will publish failed/unknown explicitly, so treating
  // an active analyze job like a polled video task creates a false alarm.
  if (job.kind === 'analyze') return false;
  return (job.status === 'queued' || job.status === 'running')
    && timestamp > 0
    && now - timestamp >= STALLED_AFTER_MS;
};

export function collectTaskNotifications(previous, next, { now = Date.now(), notified = new Set(), activityAt = new Map() } = {}) {
  if (!previous || previous.id !== next.id) return [];
  const oldJobs = new Map(previous.jobs.map(job => [job.id, job]));
  const currentIds = new Set();
  const events = [];
  const batches = new Map();
  const add = (job, category, title, body) => {
    const key = `${next.id}:${job.id}:${category}`;
    if (notified.has(key)) return;
    notified.add(key);
    events.push({ key, category, title, body, jobId: job.id, jobKind: job.kind, ...(job.batchId ? { batchId: job.batchId } : {}) });
  };
  const rememberBatch = job => {
    if (!job.batchId) return null;
    let value = batches.get(job.batchId);
    if (!value) { value = { jobs: [], changed: false, categories: new Set() }; batches.set(job.batchId, value); }
    value.jobs.push(job);
    return value;
  };

  for (const job of next.jobs) {
    const old = oldJobs.get(job.id);
    const batch = rememberBatch(job);
    const wasCurrent = !old || old.status === job.status;
    const activityKey = `${next.id}:${job.id}`;
    const timestamp = updatedAt(job);
    if (!activityAt.has(activityKey)) activityAt.set(activityKey, updatedAt(old || job) || (timestamp > 0 ? timestamp : now));
    else if (!old || old.status !== job.status || old.progress !== job.progress) activityAt.set(activityKey, timestamp || now);
    if (job.status !== 'completed' || generationKinds.has(job.kind) || job.kind === 'analyze') currentIds.add(`${job.kind}:${job.targetId}`);
    if (job.status === 'failed' && (!old || old.status !== 'failed')) {
      if (batch) { batch.changed = true; batch.categories.add('failure'); continue; }
      add(job, 'failure', '映序任务失败', `${taskLabel(job)}失败，请打开任务记录查看原因。`);
      continue;
    }
    if ((job.status === 'unknown' || job.status === 'interrupted') && (!old || old.status !== job.status)) {
      if (batch) { batch.changed = true; batch.categories.add('stuck'); continue; }
      add(job, 'stuck', '映序任务卡住', `${taskLabel(job)}暂时没有得到明确结果，请打开任务记录核实或继续。`);
      continue;
    }
    if (job.status === 'completed' && (!old || old.status !== 'completed')) {
      if (batch) { batch.changed = true; batch.categories.add('completed'); continue; }
      if (job.kind === 'analyze') add(job, 'completed', '内容分析完成', '原文分析和分镜规划已经完成，可以继续审核。');
      else if (generationKinds.has(job.kind)) add(job, 'completed', '制作生成完成', `${taskLabel(job)}已经完成，可以打开查看结果。`);
      continue;
    }
    if (old && wasCurrent && isStalled(job, now, activityAt.get(activityKey))) {
      if (batch) { batch.changed = true; batch.categories.add('stuck'); continue; }
      add(job, 'stuck', '映序任务卡住', `${taskLabel(job)}超过 120 秒没有进展，请打开任务记录检查。`);
    }
  }
  for (const [batchId, batch] of batches) {
    if (!batch.changed) continue;
    const terminal = batch.jobs.every(job => ['completed', 'failed', 'unknown', 'interrupted'].includes(job.status));
    const representative = batch.jobs[0];
    if (batch.categories.has('stuck') && !terminal) {
      add({ ...representative, batchId }, 'stuck', '批量任务卡住', `${representative.batchLabel || taskLabel(representative)}暂时没有得到明确结果，请打开任务记录核实。`);
      continue;
    }
    if (!terminal) continue;
    const failed = batch.jobs.filter(job => job.status === 'failed').length;
    const uncertain = batch.jobs.filter(job => ['unknown', 'interrupted'].includes(job.status)).length;
    const completed = batch.jobs.filter(job => job.status === 'completed').length;
    if (failed) add({ ...representative, batchId }, 'failure', '批量任务完成', `${representative.batchLabel || taskLabel(representative)}完成：${completed} 项成功，${failed} 项失败，${uncertain} 项待核实。`);
    else if (uncertain) add({ ...representative, batchId }, 'stuck', '批量任务待核实', `${representative.batchLabel || taskLabel(representative)}完成：${completed} 项成功，${uncertain} 项待核实。`);
    else add({ ...representative, batchId }, 'completed', '批量生成完成', `${representative.batchLabel || taskLabel(representative)}已完成：${completed} 项。`);
  }
  // A stale active task can be detected even when its status string did not change.
  // Keep one key per task/category so the next polling tick cannot repeat the alert.
  for (const job of next.jobs) {
    if (!currentIds.has(`${job.kind}:${job.targetId}`)) continue;
    if (isStalled(job, now, activityAt.get(`${next.id}:${job.id}`))) {
      if (job.batchId) {
        const batch = batches.get(job.batchId);
        if (batch) { batch.changed = true; batch.categories.add('stuck'); }
        continue;
      }
      add(job, 'stuck', '映序任务卡住', `${taskLabel(job)}超过 120 秒没有进展，请打开任务记录检查。`);
    }
  }
  return events;
}

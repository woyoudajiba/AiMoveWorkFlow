import { useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, Film, Image, RefreshCw, ShieldCheck, Sparkles, Upload, Video } from 'lucide-react';
import { api, readableError } from './api';
import { Badge, Modal, Notice, Spinner } from './components';
import { emptyImportDraft, type ImportDraft } from './drafts';
import { imagePickerItems, llmPickerItems, ModelPicker, videoPickerItems } from './model-picker';
import { useDrafts } from './useDrafts';
import { isActive, isArkVideoModel, isCurrentJob, isMiniMaxVideoModel, isXiongmaoVideoModel, isSupersededAnalysis, jobNames, sourceTypeNames, visualStyleNames, statusNames, type Job, type NarrativeMode, type Project, type ProjectAction, type PublicConfig, type SourceType, type VideoModelOption, type VisualStyle } from './types';
const videoModelLabel = (model: string | null | undefined) => {
  if (model?.toLowerCase() === 'minimax-h3-max') return 'MiniMax H3 Max';
  if (model?.toLowerCase() === 'minimax-h3') return 'MiniMax H3';
  if (model?.toLowerCase() === 'xiongmao-minimaxh3') return 'MiniMax H3 · 熊猫Ai';
  const labels: Record<string, string> = {
    'xiongmao-seedance-2-0-official': 'Seedance 2.0 官方直连 · 标准 · 熊猫Ai',
    'xiongmao-seedance-2-0-official-fast': 'Seedance 2.0 官方直连 · Fast · 熊猫Ai',
    'xiongmao-seedance-2-0-official-mini': 'Seedance 2.0 官方直连 · Mini · 熊猫Ai',
    'xiongmao-seedance-2-0-promo': 'Seedance 2.0 特价按秒 · 标准 · 熊猫Ai',
    'xiongmao-seedance-2-0-promo-fast': 'Seedance 2.0 特价按秒 · Fast · 熊猫Ai',
    'xiongmao-seedance-2-0-promo-mini': 'Seedance 2.0 特价按秒 · Mini · 熊猫Ai',
    'xiongmao-seedance-2-0-special': 'Seedance 2.0 特价按次 · 高清 · 熊猫Ai',
    'xiongmao-seedance-2-0-special-fast': 'Seedance 2.0 特价按次 · Fast · 熊猫Ai',
    'xiongmao-seedance-2-0-special-mini': 'Seedance 2.0 特价按次 · Mini · 熊猫Ai',
    'xiongmao-seedance-2-5-special': 'Seedance 2.5 特价按次 · 熊猫Ai',
  };
  if (model && labels[model.toLowerCase()]) return labels[model.toLowerCase()];
  return model || 'MiniMax H3';
};

export function ImportDialog({ close, created, onError, config }: { close: () => void; created: (project: Project) => void; onError: (message: string) => void; config: PublicConfig | null }) {
  const [drafts, setDrafts, recovery] = useDrafts('import');
  const current = drafts.new || emptyImportDraft;
  const { title, novel, style, llmModel: draftLlmModel, aspectRatio = emptyImportDraft.aspectRatio, sourceType = emptyImportDraft.sourceType, narrativeMode = emptyImportDraft.narrativeMode, visualStyle = emptyImportDraft.visualStyle, videoMode = emptyImportDraft.videoMode } = current;
  const llmModels = Array.isArray(config?.llmModels) ? config.llmModels : [];
  const llmModel = (drafts.new ? draftLlmModel : config?.llmModel) || 'qwen3.7-plus';
  const change = (patch: Partial<ImportDraft>) => setDrafts(previous => ({ new: { ...(previous.new || emptyImportDraft), ...patch } }));
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function importFile(file: File) {
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error('请选择 UTF-8 编码的 TXT 或 Markdown 文本文件。');
      if (file.size > 2 * 1024 * 1024) throw new Error('原始内容文件不能超过 2 MB，请按章节或段落拆分后导入。');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      if (content.length > 300000) throw new Error('单个项目最多支持 30 万字，请按章节或段落拆分后导入。');
      change({ novel: content.replace(/^\uFEFF/, ''), ...(!title.trim() ? { title: file.name.replace(/\.(txt|md)$/i, '') } : {}) });
    } catch (error) { onError(error instanceof TypeError ? '无法读取文本编码。请将内容另存为 UTF-8 后重试。' : readableError(error)); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const project = await api<Project>('/api/projects', 'POST', { title: title.trim(), novel: novel.trim(), style: style.trim(), llmModel, visualStyle, sourceType, narrativeMode, duration: 15, durationMode: 'auto', generationMode: 'segment-board', videoMode, aspectRatio });
      setDrafts({}); created(project);
    }
    catch (error) { onError(readableError(error)); }
    finally { setLoading(false); }
  }
  return <Modal title="从一份内容开始" subtitle="导入小说、剧本、文章或资料，建立可生成视频的项目。原文与素材保存在当前账号工作区。" close={() => !loading && close()} wide>
    <form onSubmit={submit} className="import-form">
      {recovery.recoveredKeys.length > 0 && <p className="helper" role="status">已恢复上次未创建的项目草稿。<button type="button" className="text-button" onClick={() => { if (window.confirm('清空本机暂存的项目草稿？小说正文和制作设定将恢复为空白默认值。')) setDrafts({}); }}>清空草稿</button></p>}
      <label>项目名称<input autoFocus value={title} onChange={event => change({ title: event.target.value })} required maxLength={120} placeholder="给这部短剧起个名字" /></label>
      <div className="label-row"><label htmlFor="novel-input">原始内容</label><button type="button" className="text-button" onClick={() => input.current?.click()}><Upload size={14} />导入 TXT / MD</button></div>
      <input className="visually-hidden" ref={input} type="file" accept=".txt,.md,text/plain,text/markdown" tabIndex={-1} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
      <textarea id="novel-input" rows={8} value={novel} onChange={event => change({ novel: event.target.value })} required minLength={20} maxLength={300000} placeholder="粘贴小说、剧本、新闻、论文或讲解文章。AI 会把可验证内容拆成可生成的视频镜头…" />
      <div className="text-count">{novel.length.toLocaleString()} 字 · 支持 UTF-8 文本，20 字至 30 万字</div>
      <label>视觉媒介<select value={visualStyle} onChange={event => change({ visualStyle: event.target.value as VisualStyle })}>{(Object.keys(visualStyleNames) as VisualStyle[]).map(type => <option key={type} value={type}>{visualStyleNames[type]}</option>)}</select><p className="helper">创建后会同时约束文本分析、生图和视频；补充风格描述不能改变这个媒介选择。</p></label>
      <label>补充风格描述<input value={style} onChange={event => change({ style: event.target.value })} required maxLength={500} placeholder="例如：仙侠古风、冷色月光、克制电影感" /></label>
      <div className="import-model-setting"><ModelPicker label="本项目文字分析模型" value={llmModel} items={llmPickerItems(llmModels)} disabled={!llmModels.length || loading} onChange={value => change({ llmModel: value })} aria-label="本项目文字分析模型" /><p className="helper">创建后本项目的分析、续接和重试都会固定使用这个模型；不同项目可以分别选择 DeepSeek 或 Qwen。密钥仍从模型连接中读取。</p></div>
      <div className="form-row"><div><span className="field-label">内容类型</span><select value={sourceType} onChange={event => change({ sourceType: event.target.value as SourceType })}>{(Object.keys(sourceTypeNames) as SourceType[]).map(type => <option key={type} value={type}>{sourceTypeNames[type]}</option>)}</select><p className="helper">自动识别适合不确定来源；新闻和论文会优先保留原文事实。</p></div><div><span className="field-label">画幅比例</span><div className="segmented-control" role="group" aria-label="画幅比例"><button type="button" aria-pressed={aspectRatio === '9:16'} className={aspectRatio === '9:16' ? 'selected' : ''} onClick={() => change({ aspectRatio: '9:16' })}><Film size={14} />9:16 竖屏</button><button type="button" aria-pressed={aspectRatio === '16:9'} className={aspectRatio === '16:9' ? 'selected' : ''} onClick={() => change({ aspectRatio: '16:9' })}><Film size={14} />16:9 横屏</button></div><p className="helper">整板裁切、镜头图片、视频请求和最终成片统一使用所选画幅。</p></div></div>
      <label>叙事视角<select value={narrativeMode} onChange={event => change({ narrativeMode: event.target.value as NarrativeMode })}><option value="auto">自动分析</option><option value="narrator">旁白视角</option><option value="protagonist">主角视角</option></select><p className="helper">旁白视角适合广告、纪录片、新闻和论文讲解；主角视角优先从主角观察、反应和主观镜头组织画面。原文明确对白始终保留。</p></label>
      <label>视频生成模式<select value={videoMode} onChange={event => change({ videoMode: event.target.value as 'storyboard' | 'traditional' })}><option value="storyboard">九宫格模式</option><option value="traditional">传统模式 · 多参考图直出</option></select><p className="helper">九宫格模式先生成整段分镜板并人工审核；传统模式审核场景、人物和关键物品资料后，直接按片段镜头计划提交一条多参考图视频。</p></label>
      {drafts.new && <p className={`helper ${['skipped', 'unavailable'].includes(recovery.status) ? 'amber' : ''}`} role="status">{recovery.status === 'saved' ? '草稿已暂存本机，7 天内重新打开“新建短剧项目”可恢复。' : recovery.status === 'pending' ? '正在暂存草稿…' : '草稿暂存不可用，或内容含密钥/图片数据。请创建项目或复制正文备份。'}</p>}
      <p className="helper"><ShieldCheck size={14} />创建项目仅保存文本；点击“分析内容”后才会调用文字模型。</p>
      <footer className="modal-footer"><button type="button" className="button secondary" onClick={close} disabled={loading}>取消</button><button type="submit" className="button primary" disabled={loading || novel.trim().length < 20 || !title.trim() || !style.trim()}>{loading ? <Spinner /> : <ArrowRight size={16} />}创建项目</button></footer>
    </form>
  </Modal>;
}

export function SettingsDialog({ config, close, saved, onError }: { config: PublicConfig | null; close: () => void; saved: (config: PublicConfig) => void; onError: (message: string) => void }) {
  const [llmKey, setLlmKey] = useState('');
  const [tokenPlanKey, setTokenPlanKey] = useState('');
  const [grsaiKey, setGrsaiKey] = useState('');
  const [minimaxKey, setMinimaxKey] = useState('');
  const [xiongmaoMinimaxH3Key, setXiongmaoMinimaxH3Key] = useState('');
  const [arkKey, setArkKey] = useState('');
  const [llmModelSelection, setLlmModel] = useState<string | null>(null);
  const llmModel = llmModelSelection ?? config?.llmModel ?? '';
  const llmModels = Array.isArray(config?.llmModels) ? config.llmModels : [];
  const selectedLlmModel = llmModels.find(model => model.id === llmModel);
  const selectedKeyEntered = Boolean((selectedLlmModel?.provider === 'token-plan' ? tokenPlanKey : llmKey).trim());
  const [imageModelSelection, setImageModel] = useState<string | null>(null);
  const imageModel = imageModelSelection ?? config?.imageModel ?? 'gpt-image-2.5';
  const imageModels = Array.isArray(config?.imageModels) ? config.imageModels : [];
  const selectedImageModel = imageModels.find(model => model.id === imageModel);
  const configReady = Boolean(config && selectedLlmModel && selectedImageModel);
  const [videoModelSelection, setVideoModel] = useState<string | null>(null);
  const videoModel = videoModelSelection ?? config?.videoModel ?? 'MiniMax-H3';
  const videoConfigured = isArkVideoModel(videoModel) ? config?.arkConfigured : isXiongmaoVideoModel(videoModel) ? config?.xiongmaoMinimaxH3Configured : isMiniMaxVideoModel(videoModel) ? config?.minimaxConfigured : false;
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (loading || !configReady) return;
    setLoading(true);
    try {
      const result = await api<PublicConfig>('/api/config', 'POST', { llmModel, imageModel, videoModel, ...(llmKey.trim() ? { llmKey: llmKey.trim() } : {}), ...(tokenPlanKey.trim() ? { tokenPlanKey: tokenPlanKey.trim() } : {}), ...(grsaiKey.trim() ? { grsaiKey: grsaiKey.trim() } : {}), ...(minimaxKey.trim() ? { minimaxKey: minimaxKey.trim() } : {}), ...(xiongmaoMinimaxH3Key.trim() ? { xiongmaoMinimaxH3Key: xiongmaoMinimaxH3Key.trim() } : {}), ...(arkKey.trim() ? { arkKey: arkKey.trim() } : {}) });
      setLlmKey(''); setTokenPlanKey(''); setGrsaiKey(''); setMinimaxKey(''); setXiongmaoMinimaxH3Key(''); setArkKey(''); saved(result); close();
    } catch (error) { onError(readableError(error)); }
    finally { setLoading(false); }
  }
  return <Modal title="模型连接" subtitle="连接创作所需的模型。密钥保存后不会回显。" close={() => !loading && close()} wide>
    <form className="settings-form" onSubmit={submit}>
      <div className="model-setting">
        <div className="model-setting-heading"><span className="model-icon"><BookOpen size={19} /></span><div><h3>文本分析 <span>文字模型</span></h3><p>识别主体、拆解内容、规划场景与镜头</p></div><Badge tone={selectedLlmModel?.configured ? 'green' : ''}>{!selectedLlmModel ? '待加载' : selectedKeyEntered ? '待保存' : selectedLlmModel.configured ? '已配置' : '未配置'}</Badge></div>
        <div className="model-selection">
          <ModelPicker label="文字模型" value={llmModel} items={llmPickerItems(llmModels)} disabled={!llmModels.length || loading} onChange={setLlmModel} aria-label="文字分析模型" />
          <p id="llm-model-description" className="helper">{selectedLlmModel ? selectedLlmModel.description : (llmModels.length ? '当前模型已不在可用目录中，请重新选择。' : '模型目录就绪后才能保存连接。')}</p>
          <p id="llm-model-connection" className={`helper ${selectedLlmModel && !selectedLlmModel.configured && !selectedKeyEntered ? 'amber' : ''}`} role="status">{selectedLlmModel ? `${selectedLlmModel.providerLabel} · ${selectedKeyEntered ? '已输入新密钥，保存后生效' : selectedLlmModel.configured ? '当前服务已配置' : '尚未配置，请在下方填写对应服务的 Key'}` : '正在读取文字模型与服务配置。'}</p>
        </div>
        <div className="model-fields llm-key-fields">
          <label>阿里云 Coding Plan Key<input type="password" autoComplete="new-password" spellCheck={false} disabled={loading} value={llmKey} onChange={event => setLlmKey(event.target.value)} placeholder={config?.codingPlanConfigured ? '已配置 · 留空保留现有密钥' : '输入 Coding Plan Key'} /><span className="helper">Qwen 3.7 Plus、Qwen 3.6 Plus</span></label>
          <label>阿里云 Token Plan Key<input type="password" autoComplete="new-password" spellCheck={false} disabled={loading} value={tokenPlanKey} onChange={event => setTokenPlanKey(event.target.value)} placeholder={config?.tokenPlanConfigured ? '已配置 · 留空保留现有密钥' : '输入 Token Plan Key'} /><span className="helper">Qwen 3.8 系列、DeepSeek 系列</span></label>
        </div>
      </div>
      <div className="model-setting"><div className="model-setting-heading"><span className="model-icon"><Image size={19} /></span><div><h3>角色与分镜 <span>Grsai</span></h3><p>人物身份、场景三视图与分镜画面生成</p></div><Badge tone={config?.grsaiConfigured ? 'green' : ''}>{config?.grsaiConfigured ? '已配置' : '未配置'}</Badge></div><div className="model-fields"><ModelPicker className="model-picker-full" label="图片模型" value={imageModel} items={imagePickerItems(imageModels)} disabled={!imageModels.length || loading} onChange={setImageModel} aria-label="图片生成模型" /><p id="image-model-description" className="helper model-picker-description">{selectedImageModel ? selectedImageModel.description : (imageModels.length ? '当前模型已不在可用目录中，请重新选择。' : '模型目录就绪后才能保存连接。')}</p><label>Grsai Key<input type="password" autoComplete="new-password" spellCheck={false} disabled={loading} value={grsaiKey} onChange={event => setGrsaiKey(event.target.value)} placeholder={config?.grsaiConfigured ? '已配置 · 留空保留现有密钥' : '输入 API Key'} /></label></div></div>
      <div className="model-setting"><div className="model-setting-heading"><span className="model-icon"><Video size={19} /></span><div><h3>镜头视频 <span>MiniMax / 熊猫Ai / 火山方舟</span></h3><p>将已审核的分镜图片制作成视频，并上传人物参考图片</p></div><Badge tone={videoConfigured ? 'green' : ''}>{videoConfigured ? '已配置' : '未配置'}</Badge></div><div className="model-fields"><ModelPicker className="model-picker-full" label="视频模型" value={videoModel} items={videoPickerItems(config?.videoOptions || [])} disabled={loading} onChange={setVideoModel} aria-label="视频生成模型" />{isArkVideoModel(videoModel) ? <label>火山方舟 API Key<input type="password" autoComplete="new-password" spellCheck={false} disabled={loading} value={arkKey} onChange={event => setArkKey(event.target.value)} placeholder={config?.arkConfigured ? '已配置 · 留空保留现有密钥' : '输入 API Key'} /></label> : isXiongmaoVideoModel(videoModel) ? <label>熊猫Ai API Key<input type="password" autoComplete="new-password" spellCheck={false} disabled={loading} value={xiongmaoMinimaxH3Key} onChange={event => setXiongmaoMinimaxH3Key(event.target.value)} placeholder={config?.xiongmaoMinimaxH3Configured ? '已配置 · 留空保留现有密钥' : '输入 API Key'} /></label> : <label>MiniMax API Key<input type="password" autoComplete="new-password" spellCheck={false} disabled={loading} value={minimaxKey} onChange={event => setMinimaxKey(event.target.value)} placeholder={config?.minimaxConfigured ? '已配置 · 留空保留现有密钥' : '输入 API Key'} /></label>}</div></div>
      <div className="config-footnote"><ShieldCheck size={16} /><p>{config?.credentialStorage === 'encrypted' ? '密钥由桌面端加密保存。' : '当前为网页会话：密钥仅在本地服务运行期间保留，重启后需要重新配置。'}配置状态仅表示已录入，真实模型调用结果以任务状态为准。</p></div>
      <div className="runtime-check"><span className={`status-dot ${config?.ffmpegAvailable ? '' : 'warning'}`} />视频合成引擎 {config?.ffmpegAvailable ? '已就绪' : '暂不可用，导出前需安装 FFmpeg'}</div>
      <footer className="modal-footer"><button type="button" className="button secondary" onClick={close} disabled={loading}>取消</button><button type="submit" className="button primary" disabled={loading || !configReady}>{loading ? <Spinner /> : <Check size={16} />}保存连接</button></footer>
    </form>
  </Modal>;
}

export function JobsDialog({ project, close, act, locate, busy }: { project: Project; close: () => void; act: ProjectAction; locate: (job: Job) => void; busy: boolean }) {
  const jobs = [...project.jobs].reverse();
  function targetName(job: Job) {
    const character = project.characters.find(item => item.id === job.targetId);
    if (character) return character.name;
    const asset = project.assets?.find(item => item.id === job.targetId);
    if (asset) return `关键物品 / ${asset.name}`;
    const look = project.looks?.find(item => item.id === job.targetId);
    if (look) return `${project.scenes?.find(scene => scene.id === look.sceneId)?.name || '场景'} / ${project.characters.find(person => person.id === look.characterId)?.name || '角色'} / ${look.name}`;
    for (const segment of project.segments) {
      if (segment.id === job.targetId) return `片段 ${String(segment.number).padStart(3, '0')}`;
      const shot = segment.shots.find(item => item.id === job.targetId);
      if (shot) return `片段 ${String(segment.number).padStart(3, '0')} / 镜头 ${String(shot.number).padStart(2, '0')}`;
    }
    return project.title;
  }
  return <Modal title="制作任务" subtitle={`${jobs.filter(isActive).length} 个任务进行中 · 任务保存在当前项目`} close={close} wide>
    <div className="job-list">{jobs.length ? jobs.map(job => {
      const superseded = isSupersededAnalysis(project, job);
      const canRetryAnalysis = job.kind === 'analyze' && job.status === 'unknown' && !job.analysisRetryJobId && isCurrentJob(project, job);
      const canResume = (['unknown', 'interrupted'].includes(job.status) && ['video', 'segment-video', 'character', 'asset', 'look', 'image', 'storyboard'].includes(job.kind) || job.kind === 'analyze' && job.status === 'paused') && isCurrentJob(project, job);
      const label = superseded ? '历史失败' : job.analysisRetryJobId ? '已确认续做' : statusNames[job.status];
      return <article className={`job-item ${job.status}`} key={job.id}>
        <div className="job-icon">{isActive(job) ? <Spinner size={19} /> : job.status === 'completed' ? <Check size={19} /> : <RefreshCw size={19} />}</div>
        <div className="job-content">
          <div className="job-title"><strong>{jobNames[job.kind]}</strong><Badge tone={superseded ? '' : job.status === 'completed' ? 'green' : ['failed', 'unknown', 'interrupted'].includes(job.status) ? 'amber' : ''}>{label}</Badge></div>
          <p>{targetName(job)}</p>
          {superseded && <p className="helper">后续分析已完成，当前失败记录仅作历史保留。</p>}
          {job.analysisProgress && <p className="helper">{superseded ? '该次已保存' : '已保存'} {job.analysisProgress.completedChunks} / {job.analysisProgress.totalChunks} 块{isActive(job) && job.analysisProgress.currentChunk ? ` · 当前第 ${job.analysisProgress.currentChunk} 块` : ''}{job.analysisProgress.currentEpisodes?.length ? ` · 第 ${job.analysisProgress.currentEpisodes.join('、')} 集` : ''}{Number.isInteger(job.analysisProgress.readyThroughChunk) && job.analysisProgress.readySegmentCount ? ` · 前 ${job.analysisProgress.readyThroughChunk} 块可制作 ${job.analysisProgress.readySegmentCount} 段` : ''}{isActive(job) ? job.analysisProgress.phase === 'correcting' ? ' · 正在纠正结构' : ' · 正在分析' : ''}</p>}
          {isActive(job) && <div className="job-progress"><span style={{ width: `${Math.max(3, Math.min(100, job.progress))}%` }} /></div>}
          {job.error && <p className={superseded ? 'helper' : 'job-error'}>{superseded ? '当时原因：' : ''}{job.error}</p>}
          {job.status === 'unknown' && <p className="helper">{job.analysisRetryJobId ? '原请求结果未取回；已由使用人确认费用并创建后续分析，旧记录保留。' : '提交结果尚不明确。核实原任务后再决定后续操作。'}</p>}
          <time>{new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}</time>
        </div>
        <div className="job-actions">{canRetryAnalysis
          ? <button className="button small secondary" disabled={busy} onClick={() => { if (!window.confirm('上次分析请求的结果尚未明确，服务商可能已经计费。继续会再次请求未完成块，并可能产生重复费用。确认继续？')) return; void act(`/jobs/${job.id}/retry-analysis`, { confirmDuplicateCost: true }, 'POST', '已确认，正在继续未完成的分析块。'); }}><RefreshCw size={13} />确认后继续分析</button>
          : canResume
          ? <button className="button small secondary" disabled={busy} onClick={() => act(`/jobs/${job.id}/resume`, {}, 'POST', job.kind === 'analyze' ? '已继续分析，将从最近检查点恢复。' : '已开始查询原任务。')}><RefreshCw size={13} />{job.kind === 'analyze' ? '继续分析' : '核实状态'}</button>
          : job.kind === 'analyze' && isActive(job) ? <button className="button small secondary" disabled={busy} onClick={() => act(`/jobs/${job.id}/pause`, {}, 'POST', '已请求暂停分析；当前块结束后会保存检查点。')}><RefreshCw size={13} />暂停分析</button>
          : <button className="text-button" onClick={() => { locate(job); close(); }}>{superseded ? '查看结果' : job.status === 'failed' ? '前往重试' : '查看'}<ArrowRight size={13} /></button>}
        </div>
      </article>;
    }) : <div className="jobs-empty"><Film size={28} /><p>还没有制作任务</p><small>文本分析、图片生成和视频导出将在这里显示。</small></div>}</div>
    <p className="helper task-footnote">图片、角色造型、分镜和视频任务都支持查询原任务恢复；结果不明的提交不会自动再次发送。</p>
  </Modal>;
}

export function BatchDialog({ kind, count, videoModel, videoResolution, videoOptions = [], duration = 0, segmentBoard = false, traditionalVideo = false, regenerateStoryboard = false, regenerateVideo = false, close, confirm, loading }: { kind: 'images' | 'videos'; count: number; videoModel?: string; videoResolution?: string; videoOptions?: VideoModelOption[]; duration?: number; segmentBoard?: boolean; traditionalVideo?: boolean; regenerateStoryboard?: boolean; regenerateVideo?: boolean; close: () => void; confirm: (videoModel?: string, videoResolution?: string) => void; loading: boolean }) {
  const [selectedModel, setSelectedModel] = useState(videoModel || videoOptions[0]?.id || 'MiniMax-H3');
  const model = videoOptions.find(option => option.id.toLowerCase() === selectedModel.toLowerCase());
  const [selectedResolution, setSelectedResolution] = useState(videoResolution || model?.resolutions[0]?.id || '720p');
  const selectedModelOption = model || videoOptions.find(option => option.id === videoModel);
  const resolutions = selectedModelOption?.resolutions || [];
  const selectedResolutionOption = resolutions.find(option => option.id === selectedResolution);
  const selectedPrice = selectedResolutionOption?.pricePerSecondCny ?? null;
  const selectedPriceRange = selectedResolutionOption?.pricePerSecondCnyRange ?? null;
  const selectedPricePerCallRange = selectedResolutionOption?.pricePerCallCnyRange ?? null;
  const estimatedCost = selectedPrice === null ? null : Math.round(selectedPrice * duration * 100) / 100;
  const estimatedCostRange = selectedPricePerCallRange ? selectedPricePerCallRange : selectedPriceRange ? { min: Math.round(selectedPriceRange.min * duration * 100) / 100, max: Math.round(selectedPriceRange.max * duration * 100) / 100 } : null;
  const formatRate = (price: number | null, range: { min: number; max: number } | null | undefined, perCallRange: { min: number; max: number } | null | undefined) => perCallRange ? `¥${perCallRange.min.toFixed(2)}-${perCallRange.max.toFixed(2)}/次` : range ? `¥${range.min.toFixed(2)}-${range.max.toFixed(2)}/秒` : price === null ? null : `¥${price.toFixed(2)}/秒`;
  const videoLabel = selectedModelOption?.label || videoModelLabel(selectedModel);
  const segmentImage = segmentBoard && kind === 'images';
  const segmentVideo = segmentBoard && kind === 'videos';
  const unsupportedDuration = Boolean(segmentVideo && selectedModelOption && (duration < (selectedModelOption.minDurationSeconds ?? 4) || duration > selectedModelOption.maxDurationSeconds || (selectedModelOption.minDurationSeconds === selectedModelOption.maxDurationSeconds && duration !== selectedModelOption.minDurationSeconds)));
  const handleModelChange = (value: string) => { setSelectedModel(value); const next = videoOptions.find(option => option.id === value); setSelectedResolution(next?.resolutions[0]?.id || '720p'); };
  const durationHint = selectedModelOption ? (selectedModelOption.minDurationSeconds === selectedModelOption.maxDurationSeconds ? `固定 ${selectedModelOption.minDurationSeconds} 秒` : `${selectedModelOption.minDurationSeconds ?? 4}-${selectedModelOption.maxDurationSeconds} 秒`) : '按模型能力';
  return <Modal title={segmentImage ? regenerateStoryboard ? '重新生成这一段的整段分镜板' : '生成这一段的整段分镜板' : segmentVideo ? regenerateVideo ? '重新生成这一段完整视频' : '生成这一段完整视频' : kind === 'images' ? '生成这一段的分镜画面' : '将分镜变成动态镜头'} subtitle={segmentImage ? regenerateStoryboard ? '将重新调用一次图片模型并覆盖当前审核版本；完成后需要重新审核。' : '图片模型只调用一次，镜头数量和妆造随内容片段一起生成。' : segmentVideo ? traditionalVideo ? `视频模型只调用一次，按场景、人物和关键物品参考图生成一条完整片段（${durationHint}）。` : `视频模型只调用一次，按故事板编号顺序生成一条完整片段（${durationHint}）。` : kind === 'images' ? '只补充没有图片的镜头；旧图需要逐镜明确重做。' : '仅提交尚未完成的镜头视频。'} close={() => !loading && close()}>
    <div className="batch-summary"><span className="batch-icon">{kind === 'images' ? <Image size={32} strokeWidth={1.3} /> : <Film size={32} strokeWidth={1.3} />}</span><strong>{count}<small>个{kind === 'images' ? '生图' : '视频'}任务</small></strong></div>
    <p className="batch-description">{segmentImage ? regenerateStoryboard ? '重新生成完整片段的横版分镜板，旧版本会保留在历史台账中；新版本完成后请重新检查整板、裁切画面与人物连续性。' : '一次生成完整片段的横版分镜板，包含全部镜头画面、镜头编号、当前场景妆造和角色一致性参考；完成后检查整板与每个竖屏裁切。' : segmentVideo ? regenerateVideo ? '保留当前视频作为历史版本，重新调用视频模型生成一条新的完整片段；新结果完成后请重新检查并确认。' : traditionalVideo ? `使用场景、人物和关键物品参考图调用一次 ${videoLabel}，按镜头计划生成一条 ${durationHint} 的连续片段视频，不会拆成多个镜头任务。` : `使用整段故事板调用一次 ${videoLabel}，按镜头 1 到 N 的顺序生成一条 ${durationHint} 的完整片段视频，不会拆成多个镜头任务。` : kind === 'images' ? '每个镜头都会携带已确认的本场景角色三视图。完成后请逐格检查人物、构图和剧情。' : `使用已审核的单格原图逐镜头调用 ${videoLabel}。每个视频任务按模型自动选择时长，导出时按镜头时长裁切拼接。`}</p>
    {kind === 'videos' && <div className="video-generation-options"><ModelPicker className="model-picker-full" label="视频模型" value={selectedModel} items={videoPickerItems(videoOptions)} onChange={handleModelChange} aria-label="批量视频生成模型" /><label>分辨率<select value={selectedResolution} onChange={event => setSelectedResolution(event.target.value)}>{resolutions.map(option => <option key={option.id} value={option.id}>{option.label}{formatRate(option.pricePerSecondCny, option.pricePerSecondCnyRange, option.pricePerCallCnyRange) ? ` · ${formatRate(option.pricePerSecondCny, option.pricePerSecondCnyRange, option.pricePerCallCnyRange)}` : ''}</option>)}</select></label><div className="video-cost-estimate"><span>{segmentVideo ? '本片段时长' : '选中镜头总时长'}</span><strong>{duration || '—'} 秒</strong><span>预估费用</span><strong>{estimatedCostRange ? `约 ¥${estimatedCostRange.min.toFixed(2)}-${estimatedCostRange.max.toFixed(2)}${selectedPricePerCallRange ? ' / 次' : ''}` : estimatedCost === null ? '供应商价格待确认' : `约 ¥${estimatedCost.toFixed(2)}`}</strong><small>仅为估算，实际以供应商账单为准</small></div>{unsupportedDuration && <Notice>当前模型支持 {selectedModelOption?.minDurationSeconds ?? 4}-{selectedModelOption?.maxDurationSeconds ?? 15} 秒，当前片段为 {duration} 秒，请调整片段时长或切换模型。</Notice>}</div>}
    <Notice>此操作会调用{kind === 'images' ? ' Grsai 图片' : ` ${videoLabel} 视频`}模型并产生模型费用。实际费用以供应商账单为准。</Notice>
    <footer className="modal-footer"><button className="button secondary" disabled={loading} onClick={close}>暂不生成</button><button className="button primary" disabled={loading || count === 0 || unsupportedDuration} onClick={() => confirm(selectedModel, selectedResolution)}>{loading ? <Spinner /> : <Sparkles size={16} />}确认生成</button></footer>
  </Modal>;
}

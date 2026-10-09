import { useRef } from 'react';
import { Box, Camera, Check, CheckCheck, Clock3, Save, Sparkles, Video, X, Users } from 'lucide-react';
import { EmptyImage, Notice, Spinner, StateMark, UploadButton } from './components';
import { assetPreviewUrl, assetUrl, imageData, readableError } from './api';
import { currentSegmentVideo, currentVideo, currentImage, currentProblemJobs, currentReference, identityReady, isActive, isArkVideoModel, isCurrentJob, isMiniMaxVideoModel, isXiongmaoVideoModel, lookFor, pad, roleNames, sceneWorkflow, shotReferencesReady, type Character, type CharacterDraft, type Project, type ProjectAction, type PublicConfig, type Shot, type ShotDraft } from './types';

export const shotDraft = (shot: Shot): ShotDraft => ({ scene: shot.scene, sceneId: shot.sceneId || '', action: shot.action, camera: shot.camera, movementId: shot.movementId || '', movementPlan: shot.movementPlan || '', transitionPlan: shot.transitionPlan || '', dialogue: shot.dialogue, dialogueSpeakerId: shot.dialogueSpeakerId || '', narration: shot.narration || '', sourceEvidence: shot.sourceEvidence || '', backgroundActors: shot.backgroundActors || '', characterIds: [...shot.characterIds], assetIds: [...(shot.assetIds || [])], duration: shot.duration, trimStart: shot.trimStart });
export const characterDraft = (character: Character): CharacterDraft => ({ name: character.name, role: character.role, aliases: [...character.aliases], appearance: character.appearance, evidence: character.evidence });
function changedFields<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key as keyof T]))) as Partial<T>;
}

interface SharedEditorProps {
  project: Project; config: PublicConfig | null; act: ProjectAction; busy: boolean;
  onError: (message: string) => void; showSettings: () => void;
}

export function CharacterEditor({ project, character, config, draft, change, clear, act, busy, onError, showSettings, onPreview }: SharedEditorProps & {
  character: Character; draft: CharacterDraft; change: (patch: Partial<CharacterDraft>) => void; clear: () => void;
  onPreview?: (src: string, alt: string) => void;
}) {
  const dirty = JSON.stringify(draft) !== JSON.stringify(characterDraft(character));
  const generating = project.jobs.some(job => job.kind === 'character' && job.targetId === character.id && isActive(job) && isCurrentJob(project, job));
  const uncertain = currentProblemJobs(project).find(job => job.kind === 'character' && job.targetId === character.id && ['unknown', 'interrupted'].includes(job.status));
  const blocked = busy || generating;
  const referenceCurrent = currentReference(character);
  const path = `/characters/${character.id}`;
  async function save() { if (await act(path, changedFields(characterDraft(character), { ...draft, aliases: draft.aliases.map(value => value.trim()).filter(Boolean) }), 'PATCH', '角色设定已保存，相关场景造型和分镜需要更新。')) clear(); }
  async function upload(file: File) {
    try { await act(`${path}/upload`, { dataUrl: await imageData(file), expectedVersion: character.version }, 'POST', '身份参考已上传，请检查后确认。'); }
    catch (error) { onError(readableError(error)); }
  }
  return <div className="character-editor">
    <div className="editor-heading"><div><span className="eyebrow">CHARACTER IDENTITY</span><h2>人物身份参考</h2></div><StateMark approved={character.approved && referenceCurrent} pending={!!character.reference} /></div>
    <div className="character-layout">
      <div className="character-visual">
        <div className="character-reference">{character.reference ? <><button type="button" className="image-preview-trigger" onClick={() => onPreview?.(assetUrl(character.reference), `${character.name}的人物身份参考图`)}><img src={assetPreviewUrl(character.reference)} alt={`${character.name}的人物身份参考图`} /></button>{!referenceCurrent && <span className="stale-overlay">旧版身份参考 · 需要更新</span>}</> : <EmptyImage label="给故事里的人，一个模样" detail="先生成或上传基础身份参考" />}{generating && <div className="media-working"><Spinner size={24} /><span>正在生成人物身份参考</span></div>}</div>
        <div className="character-action-bar">
          <div className="button-pair"><button className="button primary" disabled={blocked || dirty || !!uncertain || !config?.grsaiConfigured} title={dirty ? '请先保存角色设定' : uncertain ? '请先核实原任务' : !config?.grsaiConfigured ? '请先配置图片模型' : undefined} onClick={() => act(`${path}/generate`, { expectedVersion: character.version }, 'POST', '人物身份参考任务已加入队列。')}><Sparkles size={15} />{character.reference ? '重新生成' : '生成身份参考'}</button><UploadButton onFile={upload} disabled={blocked || dirty} /></div>
          {uncertain && <button className="text-button centered" disabled={blocked} onClick={() => act(`/jobs/${uncertain.id}/resume`, {}, 'POST', '正在核实原图片任务。')}>原身份任务待核实 · 查询状态</button>}
          {!config?.grsaiConfigured && <button className="text-button centered" onClick={showSettings}>配置图片模型，或直接上传参考图</button>}
          <button className="button secondary full-width" disabled={blocked || dirty || !!uncertain || !referenceCurrent || character.approved} onClick={() => act(`${path}/approve`, { reviewedVersion: character.version }, 'POST', '人物身份已确认，下一步制作场景三视图。')}><CheckCheck size={16} />{character.approved && referenceCurrent ? '人物身份已确认' : '已检查，确认人物身份'}</button>
        </div>
        <p className="helper">身份参考固定脸、年龄与体型；每场衣服、配饰和发型状态在“场景造型”中独立设定。修改身份会使全部关联造型与分镜失效。</p>
      </div>
      <div className="character-form">
        <div className="form-row"><label>角色姓名<input value={draft.name} maxLength={80} onChange={event => change({ name: event.target.value })} /></label><label>角色类型<select value={draft.role} onChange={event => change({ role: event.target.value as Character['role'] })}><option value="protagonist">主角</option><option value="supporting">配角</option><option value="extra">群演</option></select></label></div>
        <label>别名<span className="label-hint">以逗号分隔</span><input value={draft.aliases.join('，')} onChange={event => change({ aliases: event.target.value.split(/[,，]/).map(value => value.trim()) })} placeholder="例如：阿宁、宁姑娘" /></label>
        <label>AI视觉身份简报<textarea rows={6} value={draft.appearance} onChange={event => change({ appearance: event.target.value })} placeholder="图片模型可执行的脸型、年龄段、体型、发型和稳定辨识点；不要粘贴原文，场景服装请在场景造型中填写…" /></label>
        <label>原文依据 / 待确认设定<textarea rows={4} value={draft.evidence} onChange={event => change({ evidence: event.target.value })} placeholder="保留小说中明确的描述；推测出来的设定请标明待确认。" /></label>
        <div className="save-row"><span className={dirty ? 'unsaved' : 'muted'}>{dirty ? '有未保存的修改' : '设定已保存'}</span><button className="button primary" disabled={!dirty || blocked || !draft.name.trim()} onClick={save}><Save size={15} />保存设定</button></div>
      </div>
    </div>
  </div>;
}

export function ShotEditor({ project, shot, config, draft, change, clear, act, busy, onError, showSettings, close, showLooks, mode = 'image', segmentBoard = false }: SharedEditorProps & {
  shot: Shot; draft: ShotDraft; change: (patch: Partial<ShotDraft>) => void; clear: () => void; close: () => void; showLooks: (sceneId?: string) => void; mode?: 'image' | 'video'; segmentBoard?: boolean;
}) {
  const segment = project.segments.find(item => item.shots.some(itemShot => itemShot.id === shot.id));
  const segmentBoardMode = segmentBoard || project.generationMode === 'segment-board';
  const dirty = JSON.stringify(draft) !== JSON.stringify(shotDraft(shot));
  const path = `/shots/${shot.id}`;
  const generating = project.jobs.find(job => isActive(job) && isCurrentJob(project, job) && (job.targetId === shot.id || (segmentBoardMode && ['storyboard', 'segment-video'].includes(job.kind) && job.targetId === segment?.id)));
  const uncertain = currentProblemJobs(project).find(job => segmentBoardMode && mode === 'video' ? job.targetId === segment?.id && job.kind === 'segment-video' && ['unknown', 'interrupted'].includes(job.status) : job.targetId === shot.id && job.kind === mode && ['unknown', 'interrupted'].includes(job.status));
  const reusableVideo = !!shot.video && shot.videoVersion === shot.version;
  const reusableSegmentVideo = Boolean(segment && currentSegmentVideo(project, segment));
  const segmentVideoJob = segment && project.jobs.find(job => job.kind === 'segment-video' && job.targetId === segment.id && isCurrentJob(project, job));
  const allApproved = segment?.shots.every(item => item.approved && currentImage(item) && (segmentBoardMode || shotReferencesReady(project, item))) ?? false;
  const missing = draft.characterIds.map(id => project.characters.find(character => character.id === id)).filter(character => !identityReady(project, character));
  const selectedAssetIds = draft.assetIds ?? [];
  const referencesReady = segmentBoardMode || shotReferencesReady(project, draft);
  const imageCurrent = currentImage(shot);
  const blocked = busy || !!generating;
  const videoConfigured = isArkVideoModel(config?.videoModel) ? config?.arkConfigured : isXiongmaoVideoModel(config?.videoModel) ? config?.xiongmaoMinimaxH3Configured : isMiniMaxVideoModel(config?.videoModel) ? config?.minimaxConfigured : false;
  const videoProvider = isArkVideoModel(config?.videoModel) ? '火山方舟' : isXiongmaoVideoModel(config?.videoModel) ? '熊猫Ai' : config?.videoModel?.toLowerCase() === 'minimax-h3-max' ? 'MiniMax H3 Max' : 'MiniMax H3';
  const form = useRef<HTMLDivElement>(null);
  async function save() { if (await act(path, changedFields(shotDraft(shot), draft), 'PATCH', '镜头设定已保存。请检查受影响的画面是否需要重新生成或审核。')) clear(); }
  async function upload(file: File) {
    try { await act(`${path}/upload`, { dataUrl: await imageData(file), expectedVersion: shot.version }, 'POST', '分镜图片已上传，请检查后审核。'); }
    catch (error) { onError(readableError(error)); }
  }
  const canGenerate = !segmentBoardMode && !blocked && !dirty && !uncertain && !!config?.grsaiConfigured && referencesReady;
  return <aside className="shot-inspector" ref={form}>
    <div className="inspector-heading"><div><span className="eyebrow">SHOT DETAILS</span><h2>镜头 {pad(shot.number)} <span className="version">v{shot.version}</span></h2></div><button className="icon-button inspector-close" aria-label="关闭镜头详情" onClick={close}><X size={18} /></button></div>
    {mode === 'video' && <div className="inspector-video">{segmentBoardMode ? reusableSegmentVideo && segment?.video ? <video key={segment.video} controls src={assetUrl(segment.video)} preload="metadata" playsInline /> : <div className="video-empty"><Video size={27} strokeWidth={1.3} /><span>{segmentVideoJob ? '片段完整视频生成中' : segment?.video ? '片段画面已变更，视频待更新' : '等待生成片段完整视频'}</span></div> : reusableVideo ? <video key={shot.video} controls src={assetUrl(shot.video!)} preload="metadata" playsInline /> : <div className="video-empty"><Video size={27} strokeWidth={1.3} /><span>{shot.video ? '画面已变更，视频待更新' : '等待生成视频'}</span></div>}</div>}
    <div className="inspector-body">
      <div className="inspector-status"><StateMark approved={shot.approved && imageCurrent} pending={!!shot.image} /><span><Clock3 size={13} />{shot.duration.toFixed(1)} 秒</span></div>
      {shot.image && !imageCurrent && <Notice>保留的是旧版画面。请按当前场景造型重新生成或上传，不能直接重新审核。</Notice>}
      <label>所属连续场景<select value={draft.sceneId || ''} onChange={event => change({ sceneId: event.target.value })}><option value="" disabled>请选择场景</option>{(project.scenes || []).map(scene => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></label>
      <label>场景画面描述<textarea rows={2} value={draft.scene} onChange={event => change({ scene: event.target.value })} placeholder="这个镜头里的时间、地点和环境" /></label>
      <label>画面与动作<textarea rows={3} value={draft.action} onChange={event => change({ action: event.target.value })} placeholder="这个镜头里发生了什么" /></label>
      <label>景别与运镜<div className="input-with-icon"><Camera size={15} /><input value={draft.camera} onChange={event => change({ camera: event.target.value })} placeholder="例如：中景，缓慢推进" /></div></label>
      <label>运镜库编号<input value={draft.movementId || ''} onChange={event => change({ movementId: event.target.value })} placeholder="例如：move-3（缓慢推进）" /></label>
      <label>运镜执行计划<textarea rows={3} value={draft.movementPlan || ''} onChange={event => change({ movementPlan: event.target.value })} placeholder="方向、速度、起止景别、焦点或特殊执行约束" /></label>
      <label>镜头衔接计划<textarea rows={2} value={draft.transitionPlan || ''} onChange={event => change({ transitionPlan: event.target.value })} placeholder="与前一镜的动作轴、视线、道具状态和切换方式" /></label>
      <label>角色台词<textarea rows={2} value={draft.dialogue} onChange={event => change({ dialogue: event.target.value })} placeholder="原文角色说的话；没有时留空" /></label>
      <label>台词角色<select value={draft.dialogueSpeakerId || ''} onChange={event => change({ dialogueSpeakerId: event.target.value })}><option value="">未指定（仅当单一出场角色时自动绑定）</option>{project.characters.filter(character => draft.characterIds.includes(character.id)).map(character => <option key={character.id} value={character.id}>{character.name} · {roleNames[character.role]}</option>)}</select></label>
      <label>旁白<textarea rows={2} value={draft.narration} onChange={event => change({ narration: event.target.value })} placeholder="广告、纪录片、新闻或论文讲解旁白；没有时留空" /></label>
      <label>原文依据<textarea rows={2} value={draft.sourceEvidence} onChange={event => change({ sourceEvidence: event.target.value })} placeholder="这个镜头对应原文中的事实、段落或步骤；没有可靠依据时请标记待确认" /></label>
      <label>群众演员 / 环境人群<textarea rows={2} value={draft.backgroundActors || ''} onChange={event => change({ backgroundActors: event.target.value })} placeholder="例如：宗门弟子在广场两侧列队，商场顾客从背景经过；没有群众时留空" /></label>
      <div className="form-row compact-row"><label>成片时长（秒）<input type="number" min="0.1" max="15" step="0.1" value={draft.duration} onChange={event => change({ duration: Number(event.target.value) })} /></label>{mode === 'video' && <label>剪辑入点（秒）<input type="number" min="0" max="14.9" step="0.1" value={draft.trimStart} onChange={event => change({ trimStart: Number(event.target.value) })} /></label>}</div>
      {mode === 'video' && shot.videoDuration && <p className="helper">原视频 {shot.videoDuration.toFixed(2)} 秒。入点 + 成片时长在此范围内，重新审核即可复用；超出后需要重新生成。</p>}
      {mode === 'video' && reusableVideo && !shot.approved && <p className="helper amber">剪辑已更新，重新审核后复用现有视频。</p>}
      <div className="field-label">出场人物 <span className="label-hint">{segmentBoardMode ? '分镜只使用文字设定，人物参考图在视频阶段上传' : '引用本场景三视图'}</span></div>
      <div className="cast-selector">{project.characters.length ? project.characters.map(character => {
        const look = lookFor(project, draft.sceneId, character.id);
        const ready = segmentBoardMode || identityReady(project, character) && Boolean(look?.approved && currentReference(look));
        const reference = segmentBoardMode ? null : sceneWorkflow(project) ? look?.reference : character.reference;
        return <label className={`cast-check ${draft.characterIds.includes(character.id) ? 'selected' : ''}`} key={character.id}><input type="checkbox" checked={draft.characterIds.includes(character.id)} onChange={event => { const characterIds = event.target.checked ? [...draft.characterIds, character.id] : draft.characterIds.filter(id => id !== character.id); change({ characterIds, ...(draft.dialogueSpeakerId && !characterIds.includes(draft.dialogueSpeakerId) ? { dialogueSpeakerId: '' } : {}) }); }} /><span className="cast-avatar">{reference ? <img src={assetPreviewUrl(reference)} alt="" /> : <Users size={16} />}</span><span className="cast-name">{character.name}<small>{segmentBoardMode ? `${roleNames[character.role]} · 文字设定` : sceneWorkflow(project) ? ready ? `${look!.name} · 已确认` : !look ? '本场景缺少造型' : look.reference && !currentReference(look) ? '三视图已过期' : '三视图待确认' : `${roleNames[character.role]} · 身份参考`}</small></span>{draft.characterIds.includes(character.id) && <Check size={14} />}</label>;
      }) : <p className="helper">本项目没有已识别角色。</p>}</div>
      {!!project.assets?.length && <><div className="field-label">本镜关键物品 <span className="label-hint">已确认的物品图会带入生图和视频参考</span></div><div className="asset-selector">{project.assets.map(asset => <label className={`cast-check ${selectedAssetIds.includes(asset.id) ? 'selected' : ''}`} key={asset.id}><input type="checkbox" checked={selectedAssetIds.includes(asset.id)} onChange={event => change({ assetIds: event.target.checked ? [...selectedAssetIds, asset.id] : selectedAssetIds.filter(id => id !== asset.id) })} /><span className="cast-avatar">{asset.reference ? <img src={assetPreviewUrl(asset.reference)} alt="" /> : <Box size={16} />}</span><span className="cast-name">{asset.name}<small>{asset.approved && currentReference(asset) ? '已确认参考图' : asset.reference ? '待审核' : '待生成'}</small></span>{selectedAssetIds.includes(asset.id) && <Check size={14} />}</label>)}</div></>}
      {!referencesReady && <p className="helper amber">{missing.length ? `先确认 ${missing.map(character => character?.name || '缺失角色').join('、')} 的人物身份，再完成场景造型。` : !draft.sceneId ? '请先选择此镜头所属的连续场景。' : '先确认所有出场人物在本场景的当前三视图，再生成或审核分镜。'}<button className="text-button" onClick={() => showLooks(draft.sceneId)}>完善本场景造型</button></p>}
      <div className="save-row"><span className={dirty ? 'unsaved' : 'muted'}>{dirty ? '修改尚未保存' : '设定已保存'}</span><button className="button small secondary" disabled={!dirty || blocked || !draft.scene.trim() || !draft.action.trim() || draft.duration <= 0 || (sceneWorkflow(project) && !project.scenes?.some(scene => scene.id === draft.sceneId))} onClick={save}><Save size={14} />保存</button></div>
    </div>
    <div className="inspector-footer">
      {generating && <p className="progress-message"><Spinner />{generating.kind === 'video' ? '镜头视频生成中' : generating.kind === 'segment-video' ? '片段完整视频生成中' : '正在生成分镜'} · {Math.round(generating.progress)}%</p>}
      {mode === 'image' ? segmentBoardMode ? <>
        <Notice>片段级整板模式下，图片模型一次生成整段分镜板，当前镜头是从整板裁切的竖屏画面。请回到分镜总览检查整板并统一审核。</Notice>
      </> : segmentBoardMode ? <>
        {segmentVideoJob && <p className="progress-message"><Spinner />片段完整视频生成中 · {Math.round(segmentVideoJob.progress)}%</p>}
        <Notice>片段级整板模式只生成一条完整视频。故事板中的 {segment?.shots.length ?? 0} 个编号镜头会按顺序写入同一个视频提示词，当前镜头仅用于查看计划和参考画面。</Notice>
        {uncertain && <><Notice>上次片段视频提交结果待核实，请查询原任务，避免重复计费。</Notice><button className="button secondary full-width" disabled={blocked} onClick={() => act(`/jobs/${uncertain.id}/resume`, {}, 'POST', '正在核实片段完整视频任务。')}>查询原片段视频任务</button></>}
        {!segmentVideoJob && !uncertain && !reusableSegmentVideo && <button className="button primary full-width" disabled={blocked || dirty || !allApproved || !videoConfigured} onClick={() => segment && act(`/segments/${segment.id}/generate-videos`, {}, 'POST', '片段完整视频任务已提交。')}><Video size={16} />生成这一段完整视频</button>}
        {!allApproved && <p className="helper amber">此片段的全部 {segment?.shots.length ?? 0} 个分镜通过审核后，才能开始片段视频生成。</p>}
        {!videoConfigured && <button className="text-button centered" onClick={showSettings}>配置视频模型</button>}
      </> : <>
        <div className="button-pair"><button className="button secondary" disabled={!canGenerate} title={dirty ? '请先保存修改' : !config?.grsaiConfigured ? '请先配置图片模型' : !referencesReady ? '请先确认本场景所有角色三视图' : undefined} onClick={() => act(`${path}/generate`, { expectedVersion: shot.version }, 'POST', '分镜生图任务已加入队列。')}><Sparkles size={15} />{shot.image ? '重新生成' : '生成画面'}</button><UploadButton onFile={upload} disabled={blocked || dirty} /></div>
        <button className="button primary full-width" disabled={blocked || dirty || !!uncertain || !imageCurrent || shot.approved || !referencesReady} onClick={() => act(`${path}/approve`, { reviewedVersion: shot.version }, 'POST', `镜头 ${pad(shot.number)} 已审核通过。`)}><CheckCheck size={16} />{shot.approved ? '此镜头已审核' : '审核通过'}</button>
        {uncertain && <button className="text-button centered" disabled={blocked} onClick={() => act(`/jobs/${uncertain.id}/resume`, {}, 'POST', '正在核实原图片任务。')}>原生图任务待核实 · 查询状态</button>}
        {!config?.grsaiConfigured && <button className="text-button centered" onClick={showSettings}>配置图片模型</button>}
      </> : <>
        {uncertain ? <><Notice>上次视频提交的结果待核实。请查询原任务，避免重复扣费。</Notice><button className="button secondary full-width" disabled={blocked} onClick={() => act(`/jobs/${uncertain.id}/resume`, {}, 'POST', '正在核实原视频任务。')}>查询原任务状态</button></> : <button className="button primary full-width" disabled={blocked || dirty || !allApproved || !videoConfigured} onClick={() => act(`${path}/video`, { expectedVersion: shot.version }, 'POST', '视频任务已提交。可以继续编辑其他镜头。')}><Video size={16} />{currentVideo(shot) ? '重新生成视频' : '生成此镜头视频'}</button>}
        {reusableVideo && !shot.approved && <button className="button secondary full-width" disabled={blocked || dirty || !referencesReady || !imageCurrent} onClick={() => act(`${path}/approve`, { reviewedVersion: shot.version }, 'POST', '剪辑调整已审核，原视频可用于合成。')}><CheckCheck size={15} />审核剪辑，复用原视频</button>}
        <p className="helper">提交 1 个 {videoProvider} 任务，按模型最低时长生成；导出时从剪辑入点截取 {shot.duration.toFixed(1)} 秒。保持审核图片中的人物、服装、背景和左右位置。</p>
        {!allApproved && <p className="helper amber">此片段的全部 {segment?.shots.length ?? 0} 个分镜通过审核后，才能开始视频生成。</p>}
        {!videoConfigured && <button className="text-button centered" onClick={showSettings}>配置视频模型</button>}
      </>}
    </div>
  </aside>;
}

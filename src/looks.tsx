import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, CheckCheck, Eye, MapPin, Plus, Save, Shirt, Sparkles, Users, WandSparkles } from 'lucide-react';
import { api, assetPreviewUrl, assetUrl, imageData, readableError } from './api';
import { Badge, BatchSelectCheckbox, EmptyImage, Modal, Notice, SectionEmpty, Spinner, UploadButton } from './components';
import { currentProblemJobs, currentReference, identityReady, isActive, isCurrentJob, type BatchAction, type BatchRequest, type Look, type LookAsset, type LookDraft, type Project, type ProjectAction, type PublicConfig, type Scene, type SceneDraft } from './types';

export const sceneDraft = (scene: Scene): SceneDraft => ({ name: scene.name, description: scene.description });
export const lookDraft = (look: Look): LookDraft => ({ name: look.name, appearance: look.appearance });

interface Props {
  project: Project; config: PublicConfig | null; sceneId: string; setSceneId: (id: string) => void;
  lookId: string; setLookId: (id: string) => void; sceneDrafts: Record<string, SceneDraft>; lookDrafts: Record<string, LookDraft>;
  changeScene: (scene: Scene, patch: Partial<SceneDraft>) => void; changeLook: (look: Look, patch: Partial<LookDraft>) => void;
  clearScene: (scene: Scene, saved: SceneDraft) => void; clearLook: (look: Look, saved: LookDraft) => void;
  act: ProjectAction; batchAct: BatchAction; busy: boolean; onError: (message: string) => void; showSettings: () => void; showIdentity: (id?: string) => void; showStory: () => void;
}

export function LooksWorkspace(props: Props) {
  const { project, config, act, batchAct, busy, sceneId, setSceneId, lookId, setLookId, onError, showSettings, showIdentity } = props;
  const [create, setCreate] = useState<'scene' | 'look' | null>(null);
  const [expanded, setExpanded] = useState<Look | null>(null);
  const [reuseTarget, setReuseTarget] = useState<Look | null>(null);
  const [reuseAssets, setReuseAssets] = useState<LookAsset[]>([]);
  const [reuseLoading, setReuseLoading] = useState(false);
  const [reuseError, setReuseError] = useState('');
  const [selectedLookIds, setSelectedLookIds] = useState<string[]>([]);
  const scene = project.scenes?.find(item => item.id === sceneId) || project.scenes?.[0];
  const looks = (project.looks || []).filter(item => item.sceneId === scene?.id);
  const look = looks.find(item => item.id === lookId) || looks[0];
  const selectedLooks = looks.filter(item => selectedLookIds.includes(item.id));
  const availableCharacters = project.characters.filter(character => identityReady(project, character) && !looks.some(item => item.characterId === character.id));
  const savedScene = scene ? sceneDraft(scene) : null;
  const draft = scene ? props.sceneDrafts[`${project.id}:${scene.id}`] || savedScene! : null;
  const sceneDirty = draft && JSON.stringify(draft) !== JSON.stringify(savedScene);
  const sceneCurrent = Boolean(scene?.reference && scene.referenceVersion === scene.version);
  const scenePending = scene ? project.jobs.find(job => job.kind === 'scene' && job.targetId === scene.id && isActive(job) && isCurrentJob(project, job)) : undefined;
  const sceneUncertain = scene ? currentProblemJobs(project).find(job => job.kind === 'scene' && job.targetId === scene.id && ['unknown', 'interrupted'].includes(job.status)) : undefined;
  function selectScene(id: string) { setSceneId(id); setLookId(''); }
  useEffect(() => { setSelectedLookIds(previous => previous.filter(id => looks.some(item => item.id === id))); }, [scene?.id, looks.map(item => item.id).join(',')]);
  async function runLookBatch(action: 'generate' | 'approve') {
    if (!selectedLooks.length) return;
    const request: BatchRequest = { kind: 'look', action, targetIds: selectedLooks.map(item => item.id), expectedVersions: Object.fromEntries(selectedLooks.map(item => [item.id, item.version])) };
    const result = await batchAct(request);
    if (result) setSelectedLookIds(previous => previous.filter(id => !result.accepted.includes(id)));
  }
  async function openReuse(target: Look) {
    setReuseTarget(target); setReuseAssets([]); setReuseError(''); setReuseLoading(true);
    try {
      const assets = await api<LookAsset[]>(`/api/projects/${project.id}/look-assets?characterId=${encodeURIComponent(target.characterId)}`);
      setReuseAssets(assets);
    } catch (error) { setReuseError(readableError(error)); }
    finally { setReuseLoading(false); }
  }
  async function saveScene() {
    if (!scene || !draft) return;
    if (await act(`/scenes/${scene.id}`, draft, 'PATCH', '场景已保存。本场景造型与分镜需要重新检查。')) props.clearScene(scene, draft);
  }
  async function uploadScene(file: File) {
    if (!scene) return;
    try { await act(`/scenes/${scene.id}/upload`, { dataUrl: await imageData(file), expectedVersion: scene.version }, 'POST', '场景参考图已上传，请检查后确认。'); }
    catch (error) { onError(readableError(error)); }
  }
  if (!project.segments.length) return <SectionEmpty title="先让内容搭好场景骨架" text="完成文本分析后，这里会出现连续场景与角色造型草稿。然后可以检查、补充场景并生成三视图。" icon={<MapPin size={30} strokeWidth={1.3} />}><button className="button primary" onClick={props.showStory}>前往分析内容<ArrowRight size={15} /></button></SectionEmpty>;
  return <div className="looks-workspace">
    <div className="looks-flow-note"><Shirt size={18} /><div><strong>身份不变，造型随场景改变</strong><p>先确认人物身份，再为本场景制作正面、侧面、背面三视图。换装或发型变化时，建立新的场景与造型。</p></div><button className="text-button" onClick={() => showIdentity()}>查看人物身份<ArrowRight size={14} /></button></div>
    <div className="looks-layout"><aside className="scene-list"><div className="list-heading"><span>连续场景</span><button className="button small secondary" onClick={() => setCreate('scene')} disabled={busy}><Plus size={13} />新建场景</button></div>{project.scenes?.length ? project.scenes.map(item => {
      const relevant = project.looks?.filter(value => value.sceneId === item.id) || [];
      return <button className={`scene-list-item ${item.id === scene?.id ? 'selected' : ''}`} key={item.id} onClick={() => selectScene(item.id)}><MapPin size={16} /><span><strong>{item.name}</strong><small>{relevant.filter(value => value.approved && currentReference(value)).length} / {relevant.length} 个造型已确认</small></span></button>;
    }) : <p className="helper scene-list-empty">先建场景，再给出场人物添加造型。</p>}<p className="helper scene-list-tip">同一地点发生换装，也应另建一个场景，避免引用上一场的衣服。</p></aside>
      {scene && draft ? <section className="scene-content">
        <div className="scene-editor"><div className="scene-editor-heading"><div><span className="eyebrow">SCENE CONTINUITY</span><h2>{scene.name}</h2></div><Badge>{looks.length} 个角色造型</Badge></div><div className="scene-form"><label>场景名称<input value={draft.name} maxLength={160} onChange={event => props.changeScene(scene, { name: event.target.value })} placeholder="例如：夜雨公交站" /></label><label>连续时空与造型条件<textarea rows={2} value={draft.description} onChange={event => props.changeScene(scene, { description: event.target.value })} placeholder="时间、地点、天气，以及本场景的服装状态…" /></label></div><div className="save-row"><span className={sceneDirty ? 'unsaved' : 'muted'}>{sceneDirty ? '修改后，本场景造型和分镜需要更新' : '场景设定已保存'}</span><button className="button small secondary" disabled={busy || !sceneDirty || !draft.name.trim()} onClick={saveScene}><Save size={14} />保存场景</button></div><div className="scene-reference-panel"><div className="scene-reference-copy"><strong>场景参考图</strong><p>传统模式会把当前场景图作为视频参考，锁定空间、时代与光线。</p></div>{scene.reference ? <img src={assetPreviewUrl(scene.reference)} alt={`${scene.name}场景参考`} className="scene-reference-image" /> : <EmptyImage label="尚未生成场景参考" detail="先保存场景设定，再生成一张干净的定场图" />}<div className="scene-reference-actions"><button className="button small secondary" disabled={busy || !!sceneDirty || !!scenePending || !!sceneUncertain || !config?.grsaiConfigured} onClick={() => void act(`/scenes/${scene.id}/generate`, { expectedVersion: scene.version }, 'POST', '场景参考图任务已加入队列。')}><Sparkles size={14} />{scene.reference ? '重新生成场景图' : '生成场景图'}</button><UploadButton onFile={uploadScene} disabled={busy || !!sceneDirty || !!scenePending} /><button className="button small primary" disabled={busy || !!sceneDirty || !!scenePending || !!sceneUncertain || !sceneCurrent || scene.approved} onClick={() => void act(`/scenes/${scene.id}/approve`, { reviewedVersion: scene.version }, 'POST', '场景参考图已确认，可用于传统模式视频。')}><CheckCheck size={14} />{scene.approved && sceneCurrent ? '已确认场景图' : '确认场景图'}</button></div>{scenePending && <p className="helper">正在生成场景参考图 · {Math.round(scenePending.progress)}%</p>}{sceneUncertain && <Notice>场景任务结果待核实，请先查询原任务。</Notice>}</div></div>
        <div className="looks-heading"><div><h2>本场景角色三视图</h2><p>每个角色一张正 / 侧 / 背三视图，逐一检查后确认。</p></div><button className="button secondary" disabled={busy || !availableCharacters.length || !!sceneDirty} title={!availableCharacters.length ? '先确认人物身份；已添加的人物无需重复创建' : sceneDirty ? '请先保存场景' : undefined} onClick={() => setCreate('look')}><Plus size={15} />添加角色造型</button></div>
        {sceneDirty && <Notice>请先保存上方场景设定，再保存或生成本场景造型；已填写的造型草稿会保留。</Notice>}
        {looks.length ? <><div className="batch-toolbar"><div className="batch-toolbar-heading"><BatchSelectCheckbox selectedCount={selectedLooks.length} total={looks.length} disabled={busy} onChange={checked => setSelectedLookIds(checked ? looks.map(item => item.id) : [])} /><Badge>{selectedLooks.length} 已选</Badge></div><div className="batch-toolbar-actions"><button className="text-button" disabled={busy} onClick={() => setSelectedLookIds(looks.filter(item => !item.reference || item.referenceVersion !== item.version).map(item => item.id))}>全选待生成</button><button className="text-button" disabled={busy} onClick={() => setSelectedLookIds(looks.filter(item => item.reference && currentReference(item) && !item.approved).map(item => item.id))}>全选待审核</button><button className="text-button" disabled={busy || !selectedLooks.length} onClick={() => setSelectedLookIds([])}>清空</button></div><div className="batch-toolbar-actions"><button className="button small secondary" disabled={busy || !selectedLooks.length || !config?.grsaiConfigured || !!sceneDirty} onClick={() => void runLookBatch('generate')}><Sparkles size={14} />批量生图</button><button className="button small primary" disabled={busy || !selectedLooks.length || !!sceneDirty} onClick={() => void runLookBatch('approve')}><CheckCheck size={14} />批量审核</button></div></div><div className="look-tabs">{looks.map(item => { const character = project.characters.find(value => value.id === item.characterId); return <div key={item.id} className="look-tab"><label className="look-select"><input type="checkbox" checked={selectedLookIds.includes(item.id)} onChange={event => setSelectedLookIds(previous => event.target.checked ? [...new Set([...previous, item.id])] : previous.filter(id => id !== item.id))} aria-label={`选择${character?.name || '角色'}造型`} /><span className="visually-hidden">选择{character?.name || '角色'}造型</span></label><button className={item.id === look?.id ? 'selected' : ''} onClick={() => void openReuse(item)}><Users size={14} /><span>{character?.name || '未找到角色'}</span><Badge tone={item.approved && currentReference(item) ? 'green' : item.reference && !currentReference(item) ? 'amber' : ''}>{item.reference && !currentReference(item) ? '旧版' : item.approved && currentReference(item) ? '已确认' : item.reference ? '待审核' : '待生成'}</Badge></button></div>; })}</div>{look && <LookEditor key={`${project.id}:${look.id}`} project={project} config={config} look={look} draft={props.lookDrafts[`${project.id}:${look.id}`] || lookDraft(look)} change={patch => props.changeLook(look, patch)} clear={saved => props.clearLook(look, saved)} act={act} busy={busy || !!sceneDirty} onError={onError} showSettings={showSettings} showIdentity={showIdentity} expand={() => setExpanded(look)} reuse={() => void openReuse(look)} />}</> : <SectionEmpty title="为本场景确定角色造型" text="选择一个出场人物，填写服装、配饰和发型状态。确认三视图后，这套造型只用于当前场景。" icon={<Shirt size={30} strokeWidth={1.3} />}>
          <button className="button primary" disabled={!availableCharacters.length || busy || !!sceneDirty} onClick={() => setCreate('look')}><Plus size={15} />添加角色造型</button>{!availableCharacters.length && <button className="text-button" onClick={() => showIdentity()}>前往人物身份</button>}
        </SectionEmpty>}
      </section> : <SectionEmpty title="先建立内容发生的场景" text="一个场景对应连续的时间、地点与服装状态。文本分析可以自动规划，你也可以手动补充。" icon={<MapPin size={30} strokeWidth={1.3} />}><button className="button primary" onClick={() => setCreate('scene')}><Plus size={15} />新建场景</button></SectionEmpty>}
    </div>
    {create && <CreateSceneLookDialog kind={create} project={project} scene={scene} close={() => setCreate(null)} act={act} busy={busy} created={next => {
      if (create === 'scene') { const added = next.scenes?.find(item => !project.scenes?.some(old => old.id === item.id)); if (added) selectScene(added.id); }
      else { const added = next.looks?.find(item => !project.looks?.some(old => old.id === item.id)); if (added) setLookId(added.id); }
      setCreate(null);
    }} />}
    {expanded && <Modal title={`${project.characters.find(character => character.id === expanded.characterId)?.name || '角色'} · 三视图`} subtitle={`${expanded.name} · ${currentReference(expanded) ? expanded.approved ? '已确认当前版本' : '当前版本，等待人工审核' : '旧版或未经验证的参考图，仅供对照'}`} close={() => setExpanded(null)} wide><img className="look-expanded-image" src={assetUrl(expanded.reference!)} alt={`${expanded.name}正面侧面背面三视图`} /><p className="helper">检查同一人物的脸、年龄与体型；检查三种视角的服装、发型和配饰是否一致。关闭后再确认。</p></Modal>}
    {reuseTarget && <LookReuseDialog target={reuseTarget} assets={reuseAssets} loading={reuseLoading} error={reuseError} busy={busy} close={() => setReuseTarget(null)} reuse={async asset => { const next = await act(`/looks/${reuseTarget.id}/reuse`, { sourceAssetId: asset.id, expectedVersion: reuseTarget.version }, 'POST', '已复用该人物造型，请检查后重新确认。'); if (next) setReuseTarget(null); }} />}
  </div>;
}

function LookEditor({ project, config, look, draft, change, clear, act, busy, onError, showSettings, showIdentity, expand, reuse }: {
  project: Project; config: PublicConfig | null; look: Look; draft: LookDraft; change: (patch: Partial<LookDraft>) => void; clear: (saved: LookDraft) => void;
  act: ProjectAction; busy: boolean; onError: (message: string) => void; showSettings: () => void; showIdentity: (id: string) => void; expand: () => void; reuse: () => void;
}) {
  const character = project.characters.find(item => item.id === look.characterId);
  const identityConfirmed = identityReady(project, character);
  const current = currentReference(look);
  const dirty = JSON.stringify(draft) !== JSON.stringify(lookDraft(look));
  const pending = project.jobs.find(job => job.kind === 'look' && job.targetId === look.id && isActive(job) && isCurrentJob(project, job));
  const uncertain = currentProblemJobs(project).find(job => job.kind === 'look' && job.targetId === look.id && ['unknown', 'interrupted'].includes(job.status));
  const blocked = busy || !!pending;
  const path = `/looks/${look.id}`;
  async function save() { if (await act(path, draft, 'PATCH', '造型已保存，引用这套造型的分镜需要更新。')) clear(draft); }
  async function upload(file: File) { try { await act(`${path}/upload`, { dataUrl: await imageData(file), expectedVersion: look.version }, 'POST', '三视图已上传，请检查正面、侧面与背面后确认。'); } catch (error) { onError(readableError(error)); } }
  return <div className="look-editor">
    <div className="look-reference"><div className="look-reference-header"><span><Shirt size={15} />{character?.name} · {look.name}</span><span className="version">v{look.version}</span></div><div className="look-image-wrap">{look.reference ? <><img src={assetPreviewUrl(look.reference)} alt={`${character?.name}在本场景的正侧背三视图`} /><button className="button small secondary look-expand" onClick={expand}><Eye size={14} />放大检查</button>{!current && <span className="stale-overlay">旧版三视图 · 需要更新</span>}</> : <EmptyImage label="等待本场景的角色三视图" detail="一张横图，依次包含正面 / 侧面 / 背面" />}{pending && <div className="media-working"><Spinner size={24} /><span>正在生成正 / 侧 / 背三视图 · {Math.round(pending.progress)}%</span></div>}</div><div className="look-view-labels"><span>正面</span><span>侧面</span><span>背面</span></div></div>
    <div className="look-form"><label>造型名称<input value={draft.name} maxLength={160} onChange={event => change({ name: event.target.value })} placeholder="例如：雨夜通勤装" /></label><label>本场景服装、配饰与发型<textarea rows={4} value={draft.appearance} onChange={event => change({ appearance: event.target.value })} placeholder="写清衣服颜色、版型、鞋子、随身物件和发型状态；小说未明确之处标记为待确认设定。" /></label><div className="save-row"><span className={dirty ? 'unsaved' : 'muted'}>{dirty ? '修改尚未保存' : '造型描述已保存'}</span><button className="button small secondary" disabled={blocked || !dirty || !draft.name.trim() || !draft.appearance.trim()} onClick={save}><Save size={14} />保存造型</button></div></div>
    {!identityConfirmed && <Notice>先确认 {character?.name || '该角色'} 的当前身份参考，三视图才能保持同一张脸。<button className="text-button" onClick={() => showIdentity(look.characterId)}>前往人物身份<ArrowRight size={13} /></button></Notice>}
    {look.reference && !current && <Notice>这张三视图对应旧版设定。旧图保留用于比较，请重新生成或上传当前造型后再确认。</Notice>}
    {uncertain && <Notice>原三视图任务结果待核实，不会重复付费提交。<button className="text-button" disabled={blocked} onClick={() => act(`/jobs/${uncertain.id}/resume`, {}, 'POST', '正在查询原三视图任务。')}>查询原任务</button></Notice>}
    <div className="look-actions"><div className="button-pair"><button className="button secondary" disabled={blocked || dirty || !identityConfirmed || !config?.grsaiConfigured || !!uncertain} onClick={() => act(`${path}/generate`, { expectedVersion: look.version }, 'POST', '场景三视图任务已加入队列。')}><Sparkles size={15} />{look.reference ? '重新生成三视图' : '生成三视图'}</button><UploadButton onFile={upload} disabled={blocked || dirty || !identityConfirmed}>上传三视图</UploadButton><button className="button secondary" disabled={blocked || dirty} onClick={reuse}><WandSparkles size={15} />复用已有造型</button></div><button className="button primary" disabled={blocked || dirty || !identityConfirmed || !current || look.approved || !!uncertain} onClick={() => act(`${path}/approve`, { reviewedVersion: look.version }, 'POST', '本场景造型已确认，可用于关联分镜。')}><CheckCheck size={16} />{look.approved && current ? '已确认本场景造型' : '已检查三视图，确认造型'}</button></div>
    {!config?.grsaiConfigured && <button className="text-button centered" onClick={showSettings}>配置图片模型，或上传准备好的三视图</button>}
    <p className="helper">生成会使用人物身份参考保持脸、年龄和体型，以本场景描述确定服装。模型成功不等于三视图合格，确认前请逐个视角检查。</p>
  </div>;
}

function LookReuseDialog({ target, assets, loading, error, busy, close, reuse }: { target: Look; assets: LookAsset[]; loading: boolean; error: string; busy: boolean; close: () => void; reuse: (asset: LookAsset) => void }) {
  const grouped = assets.reduce<Record<string, LookAsset[]>>((result, asset) => {
    const category = asset.classification?.category || (asset.kind === 'identity' ? '身份基准' : '其他');
    (result[category] ||= []).push(asset);
    return result;
  }, {});
  return <Modal title={`${target.name} · 选择已有造型`} subtitle="只显示同一人物的身份图和历史造型。选择后直接复用图片，不会重新生成；当前场景仍需人工检查并确认。" close={() => !busy && close()} wide>
    <div className="look-reuse-dialog">
      {loading && <div className="look-reuse-state"><Spinner size={22} /><span>正在整理已生成的身份图和历史造型…</span></div>}
      {!loading && error && <Notice>{error}</Notice>}
      {!loading && !error && !assets.length && <SectionEmpty title="还没有可复用的图片" text="先生成或上传这位角色的身份图、场景三视图，之后就可以在这里选择复用。" icon={<WandSparkles size={28} strokeWidth={1.3} />} />}
      {!loading && !error && Object.entries(grouped).map(([category, values]) => <section className="look-reuse-group" key={category}><header><strong>{category}</strong><Badge>{values.length} 张</Badge></header><div className="look-reuse-grid">{values.map(asset => <article className="look-reuse-card" key={asset.id}><div className="look-reuse-image"><img src={assetPreviewUrl(asset.reference)} alt={`${asset.name}人物造型`} /><span>{asset.kind === 'identity' ? '身份图' : asset.sceneName || '历史造型'}</span></div><div className="look-reuse-copy"><strong title={asset.name}>{asset.name}</strong><p title={asset.appearance}>{asset.appearance || '按图片保持当前造型'}</p><small>{asset.classification?.source === 'model' ? '大模型已分类' : '规则分类'} · {asset.approved ? '已确认素材' : '可供检查'}</small></div><button className="button small primary" disabled={busy} onClick={() => reuse(asset)}><CheckCheck size={14} />选用这套</button></article>)}</div></section>)}
    </div>
  </Modal>;
}

function CreateSceneLookDialog({ kind, project, scene, close, act, busy, created }: { kind: 'scene' | 'look'; project: Project; scene?: Scene; close: () => void; act: ProjectAction; busy: boolean; created: (project: Project) => void }) {
  const candidates = project.characters.filter(character => identityReady(project, character) && !project.looks?.some(look => look.sceneId === scene?.id && look.characterId === character.id));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [characterId, setCharacterId] = useState(candidates[0]?.id || '');
  async function submit(event: FormEvent) { event.preventDefault(); const next = await act(kind === 'scene' ? '/scenes' : '/looks', kind === 'scene' ? { name, description } : { sceneId: scene?.id, characterId, name, appearance: description }, 'POST', kind === 'scene' ? '场景已建立。' : '造型草稿已建立。'); if (next) created(next); }
  return <Modal title={kind === 'scene' ? '建立连续场景' : '添加本场景角色造型'} subtitle={kind === 'scene' ? '一次换装或连续时空变化，就建立一个新的场景。' : `场景：${scene?.name}。身份参考保持人物一致，本场景描述决定服装。`} close={() => !busy && close()}><form className="scene-create-form" onSubmit={submit}>{kind === 'look' && <label>出场角色<select value={characterId} onChange={event => setCharacterId(event.target.value)} required>{candidates.map(character => <option key={character.id} value={character.id}>{character.name}{identityReady(project, character) ? ' · 身份已确认' : ' · 身份待确认'}</option>)}</select></label>}<label>{kind === 'scene' ? '场景名称' : '造型名称'}<input autoFocus value={name} maxLength={160} onChange={event => setName(event.target.value)} placeholder={kind === 'scene' ? '例如：夜雨公交站' : '例如：雨夜通勤装'} required /></label><label>{kind === 'scene' ? '场景说明' : '造型说明'}<textarea rows={5} value={description} onChange={event => setDescription(event.target.value)} required={kind === 'look'} placeholder={kind === 'scene' ? '时间、地点、天气与连续服装状态' : '衣服、鞋子、配饰、发型状态；缺失的小说设定请标明待确认'} /></label><footer className="modal-footer"><button className="button secondary" type="button" onClick={close} disabled={busy}>取消</button><button className="button primary" type="submit" disabled={busy || !name.trim() || (kind === 'look' && (!characterId || !description.trim()))}>{busy ? <Spinner /> : <Plus size={15} />}创建{kind === 'scene' ? '场景' : '造型草稿'}</button></footer></form></Modal>;
}

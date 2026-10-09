import { useState } from 'react';
import { Box, CheckCheck, Plus, Save, Sparkles } from 'lucide-react';
import { assetPreviewUrl, imageData } from './api';
import { Badge, EmptyImage, SectionEmpty, Spinner, UploadButton } from './components';
import { currentReference, isActive, isCurrentJob, type Project, type ProjectAction, type ProjectAsset, type PublicConfig } from './types';

type Props = { project: Project; config: PublicConfig | null; act: ProjectAction; busy: boolean; onError: (message: string) => void };
const labels = { weapon: '武器', costume: '服饰', prop: '道具', other: '其他' } as const;

export function AssetsWorkspace({ project, config, act, busy, onError }: Props) {
  const [selectedId, setSelectedId] = useState(project.assets?.[0]?.id || '');
  const [draft, setDraft] = useState<{ name: string; kind: ProjectAsset['kind']; description: string }>(() => { const first = project.assets?.[0]; return first ? { name: first.name, kind: first.kind, description: first.description } : { name: '', kind: 'prop', description: '' }; });
  const assets = project.assets || [];
  const selected = assets.find(item => item.id === selectedId);
  const selectedDraft = draft;
  const pending = selected && project.jobs.some(job => job.kind === 'asset' && job.targetId === selected.id && isActive(job) && isCurrentJob(project, job));
  function select(asset: ProjectAsset) { setSelectedId(asset.id); setDraft({ name: asset.name, kind: asset.kind, description: asset.description }); }
  async function create() {
    if (!draft.name.trim()) return;
    const next = await act('/assets', draft, 'POST', '关键物品已创建。');
    const added = next?.assets?.find(item => !assets.some(old => old.id === item.id));
    setDraft({ name: '', kind: 'prop', description: '' });
    if (added) select(added);
  }
  async function save() { if (selected && await act(`/assets/${selected.id}`, selectedDraft, 'PATCH', '关键物品设定已保存，相关镜头需要重新检查。')) setDraft({ name: selectedDraft.name, kind: selectedDraft.kind, description: selectedDraft.description }); }
  async function upload(file: File) { if (!selected) return; try { await act(`/assets/${selected.id}/upload`, { dataUrl: await imageData(file), expectedVersion: selected.version }, 'POST', '关键物品参考图已上传，请审核。'); } catch (error) { onError(error instanceof Error ? error.message : '上传失败'); } }
  if (!project.segments.length) return <SectionEmpty title="先完成内容分析" text="分析完成后，在这里维护武器、服饰和重要道具，并将它们引用到具体镜头。" icon={<Box size={30} strokeWidth={1.3} />} />;
  return <div className="assets-workspace"><div className="assets-list"><div className="list-heading"><span>关键物品</span><Badge>{assets.length} 件</Badge></div><p className="helper">只维护会影响连续性的武器、服饰和道具。</p>{assets.map(asset => <button key={asset.id} className={`asset-list-item ${asset.id === selected?.id ? 'selected' : ''}`} onClick={() => select(asset)}><Box size={16} /><span><strong>{asset.name}</strong><small>{labels[asset.kind]} · {asset.approved && currentReference(asset) ? '已确认' : asset.reference ? '待审核' : '待生成'}</small></span></button>)}<button className="button small secondary full-width" onClick={() => { setSelectedId(''); setDraft({ name: '', kind: 'prop', description: '' }); }}><Plus size={14} />新增关键物品</button></div><section className="asset-editor"><div className="editor-heading"><div><span className="eyebrow">CONTINUITY ASSET</span><h2>{selected ? selected.name : '新增关键物品'}</h2></div>{selected && <Badge tone={selected.approved && currentReference(selected) ? 'green' : 'amber'}>{selected.approved && currentReference(selected) ? '已确认' : '待审核'}</Badge>}</div><div className="asset-form"><label>名称<input value={selectedDraft.name} onChange={event => setDraft({ ...selectedDraft, name: event.target.value })} placeholder="例如：玄铁剑、宗门礼服" /></label><label>类型<select value={selectedDraft.kind} onChange={event => setDraft({ ...selectedDraft, kind: event.target.value as ProjectAsset['kind'] })}><option value="weapon">武器</option><option value="costume">服饰</option><option value="prop">道具</option><option value="other">其他</option></select></label><label>图片模型可执行的物品说明<textarea rows={5} value={selectedDraft.description} onChange={event => setDraft({ ...selectedDraft, description: event.target.value })} placeholder="材质、颜色、形制、纹理、磨损和时代感；不要粘贴整段原文" /></label><div className="save-row"><span className="muted">物品图会作为镜头和视频参考</span><button className="button small primary" disabled={busy || !selectedDraft.name.trim()} onClick={() => void (selected ? save() : create())}><Save size={14} />{selected ? '保存设定' : '创建物品'}</button></div></div>{selected && <><div className="asset-reference">{selected.reference ? <img src={assetPreviewUrl(selected.reference)} alt={`${selected.name}参考图`} /> : <EmptyImage label="等待物品参考图" detail="先生成或上传一张清晰的物品图" />}</div><div className="asset-actions"><button className="button secondary" disabled={busy || !!pending || !config?.grsaiConfigured} onClick={() => void act(`/assets/${selected.id}/generate`, { expectedVersion: selected.version }, 'POST', '关键物品生图任务已加入队列。')}><Sparkles size={14} />{selected.reference ? '重新生成' : '生成参考图'}</button><UploadButton onFile={upload} disabled={busy || !!pending} /><button className="button primary" disabled={busy || !selected.reference || !currentReference(selected) || selected.approved} onClick={() => void act(`/assets/${selected.id}/approve`, { reviewedVersion: selected.version }, 'POST', '关键物品已审核通过。')}><CheckCheck size={14} />审核通过</button></div>{pending && <p className="progress-message"><Spinner />关键物品参考图生成中</p>}</>}</section></div>;
}

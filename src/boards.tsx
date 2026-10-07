import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Eye, LayoutTemplate, RefreshCw } from 'lucide-react';
import { Badge, Notice, Spinner } from './components';
import { assetUrl } from './api';
import { planBoardPages } from './board-plan';
import { pad, type BoardPage, type BoardTemplate, type BoardTemplateCatalog, type Shot } from './types';

export function BoardTemplatePicker({ catalog, loading, error, selectedId, savingId, disabled, shots, segmentBoard = false, collapsed = false, onExpand, retry, select }: {
  catalog: BoardTemplateCatalog | null; loading: boolean; error: string; selectedId: string; savingId: string | null; disabled: boolean;
  shots: Shot[]; segmentBoard?: boolean; collapsed?: boolean; onExpand?: () => void;
  retry: () => void; select: (id: string) => void;
}) {
  const plans = (catalog?.templates || []).map(template => ({ template, plan: planBoardPages(shots, template) }));
  const selected = plans.find(item => item.template.id === selectedId);
  if (collapsed && selected && !error) return <section className="board-template-section board-template-section-collapsed" aria-label="审核板模板">
    <div className="board-template-collapsed-row">
      <div className="board-template-collapsed-title"><LayoutTemplate size={15} /><div><span className="eyebrow">BOARD TEMPLATE</span><strong>{selected.template.name}</strong></div><Badge tone="green">已保存</Badge></div>
      <button type="button" className="text-button board-template-expand" onClick={onExpand}><LayoutTemplate size={13} />更换模板</button>
    </div>
    <p className="board-template-collapsed-note">当前审核板模板已确认，已生成的整板图片按此模板保存。需要改版时展开选择。</p>
  </section>;
  return <section className="board-template-section" aria-label="审核板模板">
    <div className="board-template-heading"><div><span className="eyebrow">BOARD TEMPLATE</span><h3><LayoutTemplate size={15} />选择审核板模板</h3></div><span>选择后自动保存</span></div>
    <p className="board-template-note">{segmentBoard ? '模板只规定整板排版，镜头数量、每镜时长与文字造型设定由文本分析和图片模型决定；整板图片一次生成，全部槽位用于镜头内容。' : '每页使用固定格子，按场景与容量自动分页。模板只调整设定板排版，已有分镜和视频保持原样。'}</p>
    {loading && !catalog ? <div className="template-loading" role="status"><Spinner size={16} />正在读取模板</div> : error ? <Notice>{error}<button className="text-button" disabled={loading} onClick={retry}><RefreshCw size={13} />重新加载</button></Notice> : <div className="board-template-options">{plans.map(({ template, plan }) => <button key={template.id} className={`board-template-card ${selectedId === template.id ? 'selected' : ''}`} aria-label={segmentBoard ? `${template.name}，整板 ${template.shotColumns} 列布局，当前片段 ${shots.length} 个镜头` : `${template.name}，每页 ${template.shotCapacity} 格分镜和 ${template.lookCapacity} 组角色三视图，当前片段共 ${plan.pages.length} 页，其中 ${plan.continuationPages} 页造型续页，留空 ${plan.emptyShotSlots} 格分镜和 ${plan.emptyLookSlots} 组造型`} title={segmentBoard ? '横版镜头面板排版' : template.description} aria-pressed={selectedId === template.id} disabled={disabled || loading || !!savingId} onClick={() => selectedId !== template.id && select(template.id)}>
      <TemplateThumbnail template={template} segmentBoard={segmentBoard} />
      <span className="template-card-content"><span className="template-card-title"><strong>{template.name}</strong>{savingId === template.id ? <Spinner size={12} /> : selectedId === template.id ? <Check size={13} /> : null}</span><span className="template-card-capacity">{segmentBoard ? `整板 ${template.shotColumns} 列 × ${template.shotRows} 行，全部用于镜头面板` : `每页 ${template.shotCapacity} 格分镜 + ${template.lookCapacity} 组三视图`}</span><span className="template-card-pages">{segmentBoard ? `当前片段 ${shots.length} 个镜头，AI 自动决定数量` : `共 ${plan.pages.length} 页 · 造型续页 ${plan.continuationPages} 页`}</span><span className="template-card-empty">{segmentBoard ? '镜头由整板图片一次生成' : `留空 ${plan.emptyShotSlots} 格分镜 / ${plan.emptyLookSlots} 组造型`}</span><span className="template-card-state">{savingId === template.id ? '正在保存…' : selectedId === template.id ? '当前模板' : '选择模板'}</span></span>
    </button>)}</div>}
    {selected && !error && (segmentBoard ? <div className="board-plan-summary"><p>{shots.length} 个镜头 · 整板一次生成 · 只包含镜头面板</p><p className="board-plan-explanation">模板只提供稳定的横版排版方向；不会把片段拆成多次生图，也不会要求你手工合成每个镜头。人物参考图会在生成视频时上传。</p></div> : <div className="board-plan-summary"><p>{shots.length} 个镜头 · 每页 {selected.template.shotCapacity} 格 · 共 {selected.plan.pages.length} 页</p><details><summary>查看每页分配与空槽位</summary><p className="board-plan-explanation">根据已保存的镜头与出场角色计算。造型续页会重复本组镜头，不增加视频镜头。</p><ol>{selected.plan.pages.map(page => <li key={page.number}><strong>第 {page.number} 页{page.continuation ? ' · 造型续页' : ''}</strong><span>镜头 {page.shotNumbers.map(pad).join('、')} · {page.lookCount} 组造型</span><span>{page.emptyShotSlots.length ? `分镜第 ${page.emptyShotSlots.join('、')} 格留空` : '分镜无空格'}；{page.emptyLookSlots.length ? `造型第 ${page.emptyLookSlots.join('、')} 组留空` : '造型无空位'}</span></li>)}</ol></details></div>)}
  </section>;
}

function TemplateThumbnail({ template, segmentBoard = false }: { template: BoardTemplate; segmentBoard?: boolean }) {
  return <span className={`template-mini-board template-${template.id}`} style={{ gridTemplateColumns: segmentBoard ? '1fr' : 'minmax(0, 2.3fr) minmax(0, 1fr)' }} aria-hidden="true"><span className="template-mini-shots" style={{ gridTemplateColumns: `repeat(${template.shotColumns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${template.shotRows}, minmax(0, 1fr))` }}>{Array.from({ length: template.shotCapacity }, (_, index) => <span className="template-mini-shot" key={index}><i /><b><em /><em /><em /></b></span>)}</span>{!segmentBoard && <span className="template-mini-looks" style={{ gridTemplateRows: `repeat(${template.lookCapacity}, minmax(0, 1fr))` }}>{Array.from({ length: template.lookCapacity }, (_, index) => <span className="template-mini-look" key={index}><i /><i /><i /></span>)}</span>}</span>;
}

export function BoardPages({ record, templates = [], compact = false }: {
  record: { gridUrl: string; pages?: BoardPage[]; templateId?: string }; templates?: BoardTemplate[]; compact?: boolean;
}) {
  const pages = record.pages?.length ? record.pages : [{ number: 1, gridUrl: record.gridUrl, shotNumbers: [], lookIds: [], continuation: false }];
  const [selected, setSelected] = useState(0);
  const index = Math.min(selected, pages.length - 1);
  const page = pages[index];
  const templateName = templates.find(template => template.id === record.templateId)?.name;
  const isLegacy = !record.pages?.length;
  return <div className={`board-pages ${compact ? 'compact' : ''}`}>
    <div className="board-pages-heading"><span>{templateName || '横版设定板'}<span> · {pages.length} 页</span></span><Badge tone={page.continuation ? 'amber' : ''}>{page.continuation ? '造型续页' : `第 ${index + 1} 页`}</Badge></div>
    <BoardPageImage key={page.gridUrl} page={page} index={index} compact={compact} />
    {!isLegacy && <p className="board-page-context">镜头 {page.shotNumbers.map(pad).join('、') || '无'}<span> · {page.lookIds.length} 组场景造型</span>{page.continuation && <span> · 继续展示同组镜头的其余角色造型</span>}</p>}
    {pages.length > 1 && <nav className="board-page-navigation" aria-label="设定板分页"><button className="icon-button" aria-label="上一页设定板" disabled={index === 0} onClick={() => setSelected(index - 1)}><ChevronLeft size={17} /></button><div className="board-page-numbers">{pages.map((item, itemIndex) => <button key={`${item.number}:${item.gridUrl}`} className={index === itemIndex ? 'selected' : ''} aria-label={`设定板第 ${itemIndex + 1} 页${item.continuation ? '，造型续页' : ''}`} aria-current={index === itemIndex ? 'page' : undefined} onClick={() => setSelected(itemIndex)}>{itemIndex + 1}{item.continuation && <span>续</span>}</button>)}</div><button className="icon-button" aria-label="下一页设定板" disabled={index === pages.length - 1} onClick={() => setSelected(index + 1)}><ChevronRight size={17} /></button></nav>}
    <div className="board-page-downloads"><a className="button small secondary" href={assetUrl(page.gridUrl)} target="_blank" rel="noreferrer"><Eye size={13} />放大本页</a>{pages.map((item, itemIndex) => <a key={item.gridUrl} href={assetUrl(item.gridUrl)} download className="button small secondary" aria-label={`下载设定板第 ${itemIndex + 1} 页${item.continuation ? '，造型续页' : ''}`}><Download size={13} />{pages.length === 1 ? '设定板图片' : `第 ${itemIndex + 1} 页${item.continuation ? ' · 造型续页' : ''}`}</a>)}</div>
  </div>;
}

function BoardPageImage({ page, index, compact }: { page: BoardPage; index: number; compact: boolean }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [reload, setReload] = useState(0);
  const source = reload ? `${page.gridUrl}${page.gridUrl.includes('?') ? '&' : '?'}reload=${reload}` : page.gridUrl;
  return <div className={`preview-image-scroll board-page-image ${status}`}>
    <a href={assetUrl(page.gridUrl)} target="_blank" rel="noreferrer" aria-label={`放大设定板第 ${index + 1} 页`}><img key={source} className="preview-board-image" src={assetUrl(source)} alt={`设定板第 ${index + 1} 页${page.continuation ? '，造型续页' : ''}${page.shotNumbers.length ? `，镜头 ${page.shotNumbers.map(pad).join('、')}` : ''}`} loading={compact ? 'lazy' : 'eager'} onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} /></a>
    {status === 'loading' && <div className="board-page-image-status" role="status"><Spinner size={18} /><span>正在载入第 {index + 1} 页</span></div>}
    {status === 'failed' && <div className="board-page-image-error" role="alert"><p>本页图片未能加载，可以重新加载当前页面。</p><button className="button small secondary" onClick={() => { setStatus('loading'); setReload(previous => Math.max(previous + 1, Date.now())); }}><RefreshCw size={13} />重新加载本页</button><p>如果仍无法加载，请尝试“放大本页”或重新导出设定板。</p></div>}
  </div>;
}

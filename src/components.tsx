import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, LoaderCircle, ImagePlus, Check, AlertCircle, Upload, Film } from 'lucide-react';

export function Modal({ title, subtitle, children, close, wide = false }: { title: string; subtitle?: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === ref.current) close(); }}>
    <div className="modal-content">
      <header className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭对话框" onClick={close}><X size={20} /></button></header>
      {children}
    </div>
  </dialog>;
}

export function Spinner({ size = 16 }: { size?: number }) { return <LoaderCircle size={size} className="spin" aria-label="处理中" />; }
export function Badge({ children, tone = '' }: { children: ReactNode; tone?: string }) { return <span className={`badge ${tone}`}>{children}</span>; }
export function BatchSelectCheckbox({ selectedCount, total, disabled = false, onChange, label = '全选' }: { selectedCount: number; total: number; disabled?: boolean; onChange: (checked: boolean) => void; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const allSelected = total > 0 && selectedCount === total;
  useEffect(() => {
    if (input.current) input.current.indeterminate = selectedCount > 0 && selectedCount < total;
  }, [selectedCount, total]);
  return <label className="batch-master-checkbox" title={allSelected ? '取消全选' : label}>
    <input ref={input} type="checkbox" checked={allSelected} disabled={disabled || total === 0} onChange={event => onChange(event.target.checked)} aria-label={label} />
    <span>{label}</span>
  </label>;
}
export function EmptyImage({ label = '等待生成画面', detail, compact = false }: { label?: string; detail?: string; compact?: boolean }) {
  return <div className={`empty-image ${compact ? 'compact' : ''}`}><ImagePlus size={compact ? 23 : 29} strokeWidth={1.3} /><span>{label}</span>{detail && <small>{detail}</small>}</div>;
}
export function Notice({ children, type = '' }: { children: ReactNode; type?: string }) {
  return <div className={`notice ${type}`}><AlertCircle size={16} /><div>{children}</div></div>;
}
export function UploadButton({ onFile, disabled = false, children = '上传图片' }: { onFile: (file: File) => void; disabled?: boolean; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  return <><input ref={input} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" tabIndex={-1} onChange={event => { const file = event.target.files?.[0]; if (file) onFile(file); event.target.value = ''; }} /><button className="button secondary" disabled={disabled} onClick={() => input.current?.click()}><Upload size={15} />{children}</button></>;
}
export function StateMark({ approved, pending }: { approved: boolean; pending?: boolean }) {
  return approved ? <span className="state-mark approved"><Check size={12} />已审核</span> : <span className="state-mark">{pending ? '待审核' : '待生成'}</span>;
}
export function SectionEmpty({ title, text, children, icon = <Film size={30} strokeWidth={1.3} /> }: { title: string; text: string; children?: ReactNode; icon?: ReactNode }) {
  return <div className="section-empty"><div className="section-empty-icon">{icon}</div><h2>{title}</h2><p>{text}</p>{children}</div>;
}

export function ToastRegion({ children, modalKey }: { children: ReactNode; modalKey: string | null }) {
  const [host, setHost] = useState<Element>(document.body);
  useLayoutEffect(() => { setHost(document.querySelector('dialog[open]') || document.body); }, [children, modalKey]);
  return createPortal(<div className="toast-stack" aria-live="polite">{children}</div>, host);
}

export function ImageLightbox({ src, alt, close }: { src: string; alt: string; close: () => void }) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKeyDown); };
  }, [close]);
  return createPortal(
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="查看原图" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <button className="image-lightbox-close" type="button" aria-label="关闭原图预览" title="关闭" onClick={close}><X size={22} /></button>
      <img src={src} alt={alt} />
    </div>,
    document.body,
  );
}

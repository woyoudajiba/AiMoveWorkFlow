import type { LlmModelPreset, VideoModelOption } from './types';

export interface ModelPickerItem {
  id: string;
  label: string;
  provider: string;
  family: string;
  variant: string;
  description?: string;
}

interface ModelPickerProps {
  label: string;
  value: string;
  items: ModelPickerItem[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

const unique = (values: string[]) => [...new Set(values)];

export function ModelPicker({ label, value, items, onChange, disabled = false, className = '', 'aria-label': ariaLabel }: ModelPickerProps) {
  const selected = items.find(item => item.id === value) || items[0];
  const providers = unique(items.map(item => item.provider));
  const provider = selected?.provider || providers[0] || '';
  const providerItems = items.filter(item => item.provider === provider);
  const families = unique(providerItems.map(item => item.family));
  const family = selected?.provider === provider && families.includes(selected.family) ? selected.family : families[0] || '';
  const variants = providerItems.filter(item => item.family === family);
  const changeProvider = (nextProvider: string) => {
    const next = items.find(item => item.provider === nextProvider);
    if (next) onChange(next.id);
  };
  const changeFamily = (nextFamily: string) => {
    const next = providerItems.find(item => item.family === nextFamily);
    if (next) onChange(next.id);
  };
  const changeVariant = (nextId: string) => onChange(nextId);
  return <div className={`model-picker ${className}`.trim()} aria-label={ariaLabel || label}>
    <span className="model-picker-label">{label}</span>
    <label><span>平台</span><select aria-label={`${label}平台`} value={provider} disabled={disabled || !providers.length} onChange={event => changeProvider(event.target.value)}>
      {!providers.length && <option value="">暂无可用项</option>}
      {providers.map(option => <option key={option} value={option}>{option}</option>)}
    </select></label>
    <label><span>系列</span><select aria-label={`${label}系列`} value={family} disabled={disabled || !families.length} onChange={event => changeFamily(event.target.value)}>
      {!families.length && <option value="">暂无可用项</option>}
      {families.map(option => <option key={option} value={option}>{option}</option>)}
    </select></label>
    <label><span>型号</span><select aria-label={`${label}型号`} value={selected && variants.some(item => item.id === selected.id) ? selected.id : variants[0]?.id || ''} disabled={disabled || !variants.length} onChange={event => changeVariant(event.target.value)}>
      {!variants.length && <option value="">暂无可用项</option>}
      {variants.map(item => <option key={item.id} value={item.id}>{item.variant}</option>)}
    </select></label>
    {selected && <p className="model-picker-current">当前：{selected.label}</p>}
  </div>;
}

export function llmPickerItems(models: LlmModelPreset[]): ModelPickerItem[] {
  return models.map(model => ({
    id: model.id,
    label: model.label,
    provider: model.providerLabel,
    family: model.id.startsWith('qwen') ? 'Qwen 系列' : 'DeepSeek 系列',
    variant: `${model.label}${model.recommended ? ' · 推荐' : ''}${model.configured ? '' : ' · 未配置'}`,
    description: model.description,
  }));
}

export function imagePickerItems(models: { id: string; label: string; description: string }[]): ModelPickerItem[] {
  return models.map(model => ({
    id: model.id,
    label: model.label,
    provider: 'Grsai',
    family: model.id.startsWith('nano-banana') ? 'Nano Banana 系列' : 'GPT Image 系列',
    variant: model.label,
    description: model.description,
  }));
}

function videoFamily(option: VideoModelOption) {
  if (option.provider === 'MiniMax') return 'MiniMax H3 系列';
  if (option.provider === '熊猫Ai') {
    if (option.providerModel === 'minimax-h3') return 'MiniMax H3 系列';
    if (option.providerModel === 'seedance-2-0-official') return 'Seedance 2.0 官方直连';
    if (option.providerModel === 'seedance-2-0-promo') return 'Seedance 2.0 特价按秒';
    if (option.providerModel === 'seedance-2-0-special') return 'Seedance 2.0 特价按次';
    if (option.providerModel === 'seedance-2-5-special') return 'Seedance 2.5 特价按次';
  }
  if (option.provider === '火山方舟') {
    if (option.id === 'doubao-seedance-2-5') return 'Seedance 2.5';
    return 'Seedance 2.0';
  }
  return option.provider;
}

function videoVariant(option: VideoModelOption) {
  if (option.provider === 'MiniMax') return option.id.toLowerCase().includes('-max') ? 'H3 Max' : 'H3';
  if (option.quality) return ({ fast: 'Fast', mini: 'Mini', 标准: '标准', 高清: '高清', 快速: '快速' } as Record<string, string>)[option.quality] || option.quality;
  if (option.provider === '火山方舟') return option.label.replace(/^Seedance 2\.0\s*/, '').replace(/^Seedance 2\.5\s*/, '') || option.label;
  return option.label;
}

export function videoPickerItems(options: VideoModelOption[]): ModelPickerItem[] {
  return options.map(option => ({
    id: option.id,
    label: option.label,
    provider: option.provider,
    family: videoFamily(option),
    variant: videoVariant(option),
  }));
}

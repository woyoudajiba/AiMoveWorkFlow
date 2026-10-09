import { CheckCheck, ChevronRight, Sparkles, Users } from 'lucide-react';
import { assetPreviewUrl, assetUrl } from './api';
import { Badge, BatchSelectCheckbox } from './components';
import { identityReady, roleNames, type Character, type Project } from './types';

type Props = {
  project: Project;
  selectedCharacterId: string;
  selectedCharacters: string[];
  disabled: boolean;
  onSelect: (id: string) => void;
  onSelectionChange: (ids: string[]) => void;
  onBatchGenerate: () => void;
  onBatchApprove: () => void;
  onPreview: (src: string, alt: string) => void;
};

export function CharacterLibrary({ project, selectedCharacterId, selectedCharacters, disabled, onSelect, onSelectionChange, onBatchGenerate, onBatchApprove, onPreview }: Props) {
  const characters = project.characters;
  const readyCount = characters.filter(character => identityReady(project, character)).length;
  return <div className="character-list">
    <div className="list-heading"><span>角色库</span><Badge>{characters.length} 位</Badge></div>
    <p className="helper">先确认身份，再准备各场景造型。</p>
    <div className="batch-toolbar">
      <div className="batch-toolbar-heading"><BatchSelectCheckbox selectedCount={selectedCharacters.length} total={characters.length} disabled={disabled} onChange={checked => onSelectionChange(checked ? characters.map(character => character.id) : [])} /><Badge>{selectedCharacters.filter(id => characters.some(character => character.id === id)).length} 已选</Badge></div>
      <div className="batch-toolbar-actions">
        <button className="text-button" disabled={disabled} onClick={() => onSelectionChange(characters.filter(character => !character.reference || character.referenceVersion !== character.version).map(character => character.id))}>全选待生成</button>
        <button className="text-button" disabled={disabled} onClick={() => onSelectionChange(characters.filter(character => character.reference && character.referenceVersion === character.version && !character.approved).map(character => character.id))}>全选待审核</button>
        <button className="text-button" disabled={disabled || !selectedCharacters.length} onClick={() => onSelectionChange([])}>清空</button>
      </div>
      <div className="batch-toolbar-actions">
        <button className="button small secondary" disabled={disabled || !selectedCharacters.length} onClick={onBatchGenerate}><Sparkles size={14} />批量生图</button>
        <button className="button small primary" disabled={disabled || !selectedCharacters.length} onClick={onBatchApprove}><CheckCheck size={14} />批量审核</button>
      </div>
    </div>
    {characters.map(character => <div className="character-list-row" key={character.id}>
      <label className="batch-checkbox" title={`选择${character.name}`}><input type="checkbox" checked={selectedCharacters.includes(character.id)} onChange={event => onSelectionChange(event.target.checked ? [...new Set([...selectedCharacters, character.id])] : selectedCharacters.filter(id => id !== character.id))} /><span className="visually-hidden">选择{character.name}</span></label>
      <button className={`character-list-item ${selectedCharacterId === character.id ? 'selected' : ''}`} onClick={() => onSelect(character.id)}>
        <span className={`character-avatar ${character.reference ? 'has-image' : ''}`} role={character.reference ? 'button' : undefined} tabIndex={character.reference ? 0 : undefined} aria-label={character.reference ? `查看${character.name}原图` : undefined} onClick={event => { if (!character.reference) return; event.stopPropagation(); onPreview(assetUrl(character.reference), `${character.name}的人物身份参考图`); }} onKeyDown={event => { if (character.reference && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); onPreview(assetUrl(character.reference), `${character.name}的人物身份参考图`); } }}>
          {character.reference ? <img src={assetPreviewUrl(character.reference)} alt="" loading="lazy" /> : <Users size={22} strokeWidth={1.2} />}
        </span>
        <span className="character-list-text"><strong>{character.name}</strong><small>{roleNames[character.role]} <span>·</span> {identityReady(project, character) ? '身份已确认' : character.reference ? '待检查' : '待生成'}</small></span>
        {identityReady(project, character) ? <CheckCheck size={16} className="mint" /> : <ChevronRight size={15} />}
      </button>
    </div>)}
    <div className="character-count"><CheckCheck size={15} /><span>{readyCount} / {characters.length} 位身份已确认</span></div>
  </div>;
}

import {safeError} from './network.mjs';

export const DEFAULT_BOARD_TEMPLATE_ID='classic-nine';
export const BOARD_TEMPLATES=Object.freeze([
  {id:'classic-nine',name:'经典九镜 · 2 组造型',description:'左侧 3×3 分镜，右侧上下两组角色三视图。',shotCapacity:9,lookCapacity:2,shotColumns:3,shotRows:3},
  {id:'eight-one',name:'八镜单角 · 1 组造型',description:'左侧 4×2 分镜，右侧一组角色三视图；第九镜自动续页。',shotCapacity:8,lookCapacity:1,shotColumns:4,shotRows:2},
  {id:'three-three',name:'三镜精看 · 3 组造型',description:'左侧三张大幅竖版分镜，图下镜头说明；右侧三组角色三视图。',shotCapacity:3,lookCapacity:3,shotColumns:3,shotRows:1},
].map(Object.freeze));

export function getBoardTemplate(id=DEFAULT_BOARD_TEMPLATE_ID){
  const template=BOARD_TEMPLATES.find(item=>item.id===id);
  if(!template)throw safeError('未知设定板模板，请从模板列表中选择。','INVALID_INPUT');
  return template;
}

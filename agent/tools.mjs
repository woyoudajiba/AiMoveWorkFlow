import * as z from 'zod/v4';
import { createLocalClient, agentError, redact } from './client.mjs';
import {DEFAULT_BOARD_TEMPLATE_ID,BOARD_TEMPLATES} from '../server/board-templates.mjs';

const id=z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const projectShape={projectId:id};
const characterShape={...projectShape,characterId:id};
const lookShape={...projectShape,lookId:id};
const sceneShape={...projectShape,sceneId:id};
const shotShape={...projectShape,shotId:id};
const segmentShape={...projectShape,segmentId:id};
const templateId=z.enum(BOARD_TEMPLATES.map(template=>template.id));
const version=z.number().int().min(1);
const text=max=>z.string().max(max);
const characterPatch=z.strictObject({name:text(100).min(1).optional(),role:z.enum(['protagonist','supporting','extra']).optional(),aliases:z.array(text(100).min(1)).max(30).optional(),appearance:text(4000).optional(),evidence:text(6000).optional()}).refine(value=>Object.keys(value).length>0,'至少提供一个待修改字段');
const shotPatch=z.strictObject({sceneId:id.optional(),scene:text(2000).optional(),action:text(3000).optional(),camera:text(1500).optional(),movementId:text(40).optional(),movementPlan:text(600).optional(),transitionPlan:text(400).optional(),dialogue:text(3000).optional(),sourceEvidence:text(1200).optional(),backgroundActors:text(1200).optional(),characterIds:z.array(id).max(9).optional(),duration:z.number().min(0.1).max(15).optional(),trimStart:z.number().min(0).max(14.9).optional()}).refine(value=>Object.keys(value).length>0,'至少提供一个待修改字段');
const scenePatch=z.strictObject({name:text(200).min(1).optional(),description:text(4000).optional()}).refine(value=>Object.keys(value).length>0,'至少提供一个待修改字段');
const lookPatch=z.strictObject({name:text(200).min(1).optional(),appearance:text(4000).min(1).optional()}).refine(value=>Object.keys(value).length>0,'至少提供一个待修改字段');
const define=(name,description,shape,{readOnly=false,paid=false}={})=>({name,description,schema:z.strictObject(shape),annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:readOnly,openWorldHint:paid}});

export const TOOL_DEFINITIONS=[
  define('studio_status','读取本地工作台连接状态、作品列表和模型已配置标记。不返回密钥。',{}, {readOnly:true}),
  define('list_board_templates','列出固定分镜设定板模板及每页分镜、三视图容量。只读，不调用模型。',{}, {readOnly:true}),
  define('create_project','创建本地文本转视频项目，不调用模型。可传小说、剧本、论文、新闻或其他文章；新项目默认使用片段整板模式，AI 按内容决定 3–12 个镜头并只提交一次完整整板。visualStyle 用于锁定仿真人、2D 动画或 3D 动画媒介；narrativeMode 可选自动分析、旁白视角或主角视角；原文明确对白始终保留。',{title:text(160).min(1),novel:text(300000).min(1),style:text(2000).optional(),visualStyle:z.enum(['photorealistic','2d-animation','3d-animation']).optional(),sourceType:z.enum(['auto','novel','script','article','paper','news']).optional(),narrativeMode:z.enum(['auto','narrator','protagonist']).optional(),aspectRatio:z.enum(['9:16','16:9']).optional(),duration:z.union([z.literal(15),z.literal(30)]).optional(),durationMode:z.enum(['auto','fixed']).optional(),generationMode:z.enum(['segment-board','legacy-shot']).optional()}),
  define('get_project','读取角色、分镜、素材版本和任务。默认省略小说全文；需要时显式 includeNovel:true。',{...projectShape,includeNovel:z.boolean().optional()},{readOnly:true}),
  define('analyze_project','使用工作台当前选中的文字模型付费分析原始内容并规划可生成视频的镜头。已存在分析结果或同一作品的进行中/待核实任务时复用，不自动重发。',projectShape,{paid:true}),
  define('reset_duration','显式重置已分析作品的 15 / 30 秒片段规划。会清理当前角色、场景、分镜和当前导出指针，但保留原稿、项目历史台账和已导出历史；有进行中或待核实任务时拒绝。重置后必须重新分析。',{...projectShape,duration:z.union([z.literal(15),z.literal(30)]),durationMode:z.enum(['fixed','auto']).optional()}),
  define('update_character','编辑人物姓名、主配角、别名、外貌或原文依据。修改会撤销关联审核。',{...characterShape,patch:characterPatch}),
  define('generate_character','付费生成角色定妆。默认复用同版素材和当前任务；明确重做必须 regenerate:true。', {...characterShape,regenerate:z.boolean().optional()},{paid:true}),
  define('approve_character','仅在已实际检查角色图后调用。reviewedVersion 必须为读取并检查的当前版本；不会生成视频。',{...characterShape,reviewedVersion:version}),
  define('create_scene','创建连续时空和服装状态的场景。换装应使用新场景，不调用模型。',{...projectShape,name:text(200).min(1),description:text(4000).optional()}),
  define('update_scene','修改场景说明，撤销该场景造型和分镜审核。',{...sceneShape,patch:scenePatch}),
  define('create_look','为本场景的角色创建服装和配饰设定；同一场景人物只能有一个造型。',{...projectShape,sceneId:id,characterId:id,name:text(200).min(1),appearance:text(4000).min(1)}),
  define('update_look','修改本场景人物造型，撤销其三视图和关联分镜审核，不影响其他场景。',{...lookShape,patch:lookPatch}),
  define('generate_look','付费生成本场景正面/侧面/背面三视图。先确认人物身份；默认复用同版素材，重做必须regenerate:true。',{...lookShape,regenerate:z.boolean().optional()},{paid:true}),
  define('approve_look','实际查看本场景三视图并核对服装后确认其reviewedVersion。确认后才能生成关联分镜，不自动提交视频。',{...lookShape,reviewedVersion:version}),
  define('update_shot','编辑分镜内容或剪辑参数。只发送真正变更的字段；仅调整时长可按服务端规则复用素材。',{...shotShape,patch:shotPatch}),
  define('generate_shot','付费生成单格分镜，自动携带已审核的角色参考。默认复用同版素材/当前任务；重做必须 regenerate:true。',{...shotShape,regenerate:z.boolean().optional()},{paid:true}),
  define('approve_shot','仅在已实际检查分镜图后调用。显式声明 reviewedVersion，审核与视频提交是独立操作。',{...shotShape,reviewedVersion:version}),
  define('approve_segment_board','仅在已实际检查整段分镜板及全部裁切画面后调用。reviewedVersion 必须为读取并检查的当前整板版本；审核通过后才允许提交片段视频。',{...segmentShape,reviewedVersion:text(4000).min(1)}),
  define('generate_video','付费提交单镜 Seedance。服务端按所属片段模式检查整板或全部逐镜审核；默认复用同版视频/当前任务，重做必须 regenerate:true。',{...shotShape,regenerate:z.boolean().optional()},{paid:true}),
  define('get_jobs','读取作品任务，或按 jobId 读取一个任务。不会生成、恢复或重发请求。',{...projectShape,jobId:id.optional()},{readOnly:true}),
  define('pause_analysis','暂停当前文本分析并保存最近检查点。当前外部模型请求无法取消时，等结果返回后再落盘；不会创建新任务。',{...projectShape,jobId:id}),
  define('resume_job','恢复已持久化的视频查询、图片下载回执或已暂停的文本分析。分析会从最近检查点继续，不会重复已完成块。',{...projectShape,jobId:id}),
  define('generate_segment_images','按作品模式生成片段画面：segment-board 只付费提交一次完整片段整板，AI 决定 3–12 个镜头并同时生成妆造参考，再由服务端裁切镜头；legacy-shot 才逐镜补缺图。不会批准分镜。',segmentShape,{paid:true}),
  define('generate_segment_videos','付费填充已审核片段缺失的视频。保留当前视频；旧版视频须逐镜明确重做。',segmentShape,{paid:true}),
  define('set_board_template','保存片段设定板模板偏好，不改变分镜、素材版本或审核。正在导出的片段不能切换模板。',{...segmentShape,templateId}),
  define('storyboard_preview','无需视频即可导出分页设定板、分镜 CSV 和映射清单。可选templateId仅覆盖本次排版，不调用模型，不改变审核状态。',{...segmentShape,templateId:templateId.optional()}),
  define('export_segment','全部当前版本视频齐备并通过审核后，按当前模板导出编号成片与所有分页设定板/CSV/映射清单。不调用外部模型。',segmentShape),
];

export function listAgentTools(){return TOOL_DEFINITIONS.map(({name,description,schema,annotations})=>({name,description,inputSchema:z.toJSONSchema(schema),annotations}));}
function summary(project,includeNovel=false){const value=structuredClone(project);if(!includeNovel){value.novelLength=typeof value.novel==='string'?value.novel.length:0;delete value.novel;}return redact(value);}
const result=(project,reused=false,reason)=>({project:summary(project),reused,...(reason?{reason}:{})});
function character(project,characterId){const found=project.characters?.find(item=>item.id===characterId);if(!found)throw agentError('NOT_FOUND','找不到该角色。');return found;}
function look(project,lookId){const found=project.looks?.find(item=>item.id===lookId);if(!found)throw agentError('NOT_FOUND','找不到该场景造型。');return found;}
function generationTarget(project,args,kind){return kind==='character'?character(project,args.characterId):kind==='look'?look(project,args.lookId):shot(project,args.shotId);}
const collectionFor=kind=>kind==='character'?'characters':kind==='look'?'looks':'shots';
function shot(project,shotId){for(const segment of project.segments??[]){const found=segment.shots?.find(item=>item.id===shotId);if(found)return found;}throw agentError('NOT_FOUND','找不到该分镜。');}
function segment(project,segmentId){const found=project.segments?.find(item=>item.id===segmentId);if(!found)throw agentError('NOT_FOUND','找不到该片段。');return found;}
function currentJob(project,kind,target){return project.jobs?.find(job=>job.kind===kind&&job.targetId===target.id&&['queued','running','unknown'].includes(job.status)&&(job.inputVersion===undefined||job.inputVersion===target.version));}
function checkedArtifact(artifact,projectId){
  const validate=url=>{
    if(typeof url!=='string')throw agentError('INVALID_MEDIA','设定板返回了无效文件地址。');
    // HTTP presentation adds a non-secret account binding; paths on disk remain unchanged.
    if(url.includes('?')){if(!/^[?]account=[a-f0-9]{64}$/.test(url.slice(url.indexOf('?'))))throw agentError('INVALID_MEDIA','设定板返回了无效账号文件地址。');url=url.slice(0,url.indexOf('?'));}
    let decoded;try{decoded=decodeURIComponent(url);}catch{throw agentError('INVALID_MEDIA','设定板返回了无效文件地址。');}
    for(const value of [url,decoded])if(typeof value!=='string'||!value.startsWith(`/media/${projectId}/`)||value.includes('..')||/[\\?#\x00]/.test(value))throw agentError('INVALID_MEDIA','设定板文件必须位于当前作品的本地媒体目录。');
  };
  for(const field of ['videoUrl','gridUrl','manifestUrl','csvUrl'])if(artifact[field]!==undefined)validate(artifact[field]);
  if(artifact.pages!==undefined){
    if(!Array.isArray(artifact.pages)||!artifact.pages.length)throw agentError('INVALID_MEDIA','设定板分页清单无效。');
    for(const page of artifact.pages)validate(page?.gridUrl);
  }
  return artifact;
}

export function createAgent(options={}){
  const client=createLocalClient(options);
  const get=projectId=>client.request(`/api/projects/${projectId}`);
  async function generate(args,kind){
    const project=await get(args.projectId);
    const target=generationTarget(project,args,kind);
    const job=currentJob(project,kind,target);
    if(job)return {...result(project,true,job.status==='unknown'?'unknown_submission_use_resume_job':'existing_task'),job:redact(job)};
    const asset=['character','look'].includes(kind)?target.reference:kind==='image'?target.image:target.video;
    const stamp=['character','look'].includes(kind)?target.referenceVersion:kind==='image'?target.imageVersion:target.videoVersion;
    if(asset&&!args.regenerate){
      if(stamp===target.version)return result(project,true,'current_asset');
      throw agentError('STALE_ASSET','已有素材对应旧版或缺少版本依据。请先检查素材；确定付费重做时显式传 regenerate:true。');
    }
    const collection=collectionFor(kind);const action=kind==='video'?'video':'generate';
    const next=await client.request(`/api/projects/${project.id}/${collection}/${target.id}/${action}`,'POST',{reuseExisting:!args.regenerate,expectedVersion:target.version});
    return result(next,false,'submitted_or_reused_atomically');
  }
  async function approve(args,kind){
    const project=await get(args.projectId);const target=generationTarget(project,args,kind);
    if(target.version!==args.reviewedVersion)throw agentError('STALE_INPUT','素材版本已变更，请重新读取并检查后再审核。');
    if(target.approved)return result(project,true,'already_approved');
    const collection=collectionFor(kind);
    return result(await client.request(`/api/projects/${project.id}/${collection}/${target.id}/approve`,'POST',{reviewedVersion:args.reviewedVersion}));
  }
  async function generateSegment(args,kind){
    const project=await get(args.projectId);const target=segment(project,args.segmentId);
    if(kind==='image'&&project.generationMode==='segment-board'){
      const boardJob=project.jobs?.find(job=>job.kind==='storyboard'&&job.targetId===target.id&&['queued','running','unknown'].includes(job.status));
      if(boardJob)return {...result(project,true,boardJob.status==='unknown'?'unknown_submission_use_resume_job':'existing_segment_storyboard_task'),job:redact(boardJob)};
      const boardCurrent=Boolean(target.storyboardImage&&target.storyboardImageVersion&&target.shots?.length&&target.shots.every(item=>item.image&&item.imageVersion===item.version));
      if(boardCurrent)return result(project,true,'current_segment_storyboard');
      const next=await client.request(`/api/projects/${project.id}/segments/${target.id}/generate-images`,'POST',{reuseExisting:true});
      return result(next,false,'submitted_one_segment_storyboard_task');
    }
    if(target.shots.some(item=>item[kind]&&item[`${kind}Version`]!==item.version)){
      throw agentError('STALE_ASSET','片段包含旧版或缺少版本依据的素材。请逐镜检查，确定付费重做时显式 regenerate:true。');
    }
    const missing=target.shots.filter(item=>!item[kind]);
    const pending=missing.filter(item=>!currentJob(project,kind,item));
    if(!pending.length)return result(project,true,missing.length?'existing_segment_tasks':`current_segment_${kind}s`);
    let latest=project;
    for(const item of pending){
      latest=await client.request(`/api/projects/${project.id}/shots/${item.id}/${kind==='image'?'generate':'video'}`,'POST',{reuseExisting:true,expectedVersion:item.version});
    }
    return result(latest,false,'submitted_missing_shots');
  }
  const handlers={
    studio_status:()=>client.request('/api/state'),
    list_board_templates:()=>client.request('/api/board-templates'),
    create_project:async args=>result(await client.request('/api/projects','POST',{...args,generationMode:args.generationMode??'segment-board'})),
    get_project:async args=>summary(await get(args.projectId),args.includeNovel),
    analyze_project:async args=>{
      const project=await get(args.projectId);
      if(project.segments?.length||project.characters?.length)return result(project,true,'existing_analysis');
      const job=project.jobs?.find(item=>item.kind==='analyze'&&['queued','running','paused','unknown'].includes(item.status));
      if(job)return {...result(project,true,'existing_analysis_task'),job};
      return result(await client.request(`/api/projects/${project.id}/analyze`,'POST',{}));
    },
    reset_duration:async args=>result(await client.request(`/api/projects/${args.projectId}/reset-duration`,'POST',{duration:args.duration,durationMode:args.durationMode??'fixed'})),
    update_character:async args=>result(await client.request(`/api/projects/${args.projectId}/characters/${args.characterId}`,'PATCH',args.patch)),
    generate_character:args=>generate(args,'character'),
    approve_character:args=>approve(args,'character'),
    create_scene:async({projectId,...body})=>result(await client.request(`/api/projects/${projectId}/scenes`,'POST',body)),
    update_scene:async args=>result(await client.request(`/api/projects/${args.projectId}/scenes/${args.sceneId}`,'PATCH',args.patch)),
    create_look:async({projectId,...body})=>result(await client.request(`/api/projects/${projectId}/looks`,'POST',body)),
    update_look:async args=>result(await client.request(`/api/projects/${args.projectId}/looks/${args.lookId}`,'PATCH',args.patch)),
    generate_look:args=>generate(args,'look'),
    approve_look:args=>approve(args,'look'),
    update_shot:async args=>result(await client.request(`/api/projects/${args.projectId}/shots/${args.shotId}`,'PATCH',args.patch)),
    generate_shot:args=>generate(args,'image'),
    approve_shot:args=>approve(args,'image'),
    approve_segment_board:async args=>{
      const project=await get(args.projectId);const target=segment(project,args.segmentId);
      if(project.generationMode!=='segment-board')throw agentError('INVALID_INPUT','当前作品不是片段级整板模式。');
      if(typeof target.storyboardImageVersion!=='string'||!target.storyboardImage)throw agentError('MISSING_ASSET','请先生成完整片段整板并检查全部裁切画面。');
      if(target.storyboardImageVersion!==args.reviewedVersion)throw agentError('STALE_INPUT','整板版本已变更，请重新读取并检查后再审核。');
      if(!target.shots?.length||target.shots.some(item=>!item.image||item.imageVersion!==item.version))throw agentError('STALE_ASSET','整板裁切画面不完整或不是当前版本，请重新生成整段分镜板。');
      return result(await client.request(`/api/projects/${project.id}/segments/${target.id}/approve`,'POST',{reviewedVersion:args.reviewedVersion}));
    },
    generate_video:args=>generate(args,'video'),
    get_jobs:async args=>{
      const project=await get(args.projectId);
      if(!args.jobId)return {projectId:project.id,jobs:project.jobs??[]};
      const job=project.jobs?.find(item=>item.id===args.jobId);if(!job)throw agentError('NOT_FOUND','找不到该任务。');return {projectId:project.id,job};
    },
    pause_analysis:async args=>result(await client.request(`/api/projects/${args.projectId}/jobs/${args.jobId}/pause`,'POST',{})),
    resume_job:async args=>result(await client.request(`/api/projects/${args.projectId}/jobs/${args.jobId}/resume`,'POST',{})),
    generate_segment_images:args=>generateSegment(args,'image'),
    generate_segment_videos:args=>generateSegment(args,'video'),
    set_board_template:async args=>result(await client.request(`/api/projects/${args.projectId}/segments/${args.segmentId}`,'PATCH',{boardTemplateId:args.templateId})),
    storyboard_preview:async args=>checkedArtifact(await client.request(`/api/projects/${args.projectId}/segments/${args.segmentId}/preview`,'POST',args.templateId===undefined?{}:{templateId:args.templateId}),args.projectId),
    export_segment:async args=>{
      const project=await get(args.projectId);const target=segment(project,args.segmentId);
      const currentTemplate=target.boardTemplateId??DEFAULT_BOARD_TEMPLATE_ID;
      const existing=project.exports?.findLast(item=>item.segmentId===args.segmentId&&item.templateId===currentTemplate);
      if(existing)return {...result(project,true,'existing_export'),export:checkedArtifact(existing,project.id)};
      return result(await client.request(`/api/projects/${project.id}/segments/${args.segmentId}/export`,'POST',{}));
    },
  };
  async function execute(name,input={}){
    const definition=TOOL_DEFINITIONS.find(tool=>tool.name===name);if(!definition)throw agentError('UNKNOWN_TOOL','未知 Agent 工具，请先列出工具。');
    const parsed=definition.schema.safeParse(input);
    if(!parsed.success)throw agentError('INVALID_INPUT','工具参数无效：请检查必填字段、长度、类型与允许字段；不接受密钥或额外配置。');
    return redact(await handlers[name](parsed.data));
  }
  return {execute,baseUrl:client.origin};
}

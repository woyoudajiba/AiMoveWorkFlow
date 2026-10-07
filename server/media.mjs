import path from 'node:path';
import { mkdir, readFile, writeFile, rename, realpath, stat, rm, access, copyFile, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { safeError, requestBuffer } from './network.mjs';
import {getBoardTemplate} from './board-templates.mjs';

const MAX_IMAGE=20*1024*1024;
const idPattern=/^[A-Za-z0-9_-]{1,100}$/;
const inRoot=(root,target)=>target===root || target.startsWith(root+path.sep);
function assertId(id){if(typeof id!=='string'||!idPattern.test(id))throw safeError('项目标识无效。','INVALID_PATH');}

export async function resolveMediaPath(mediaRoot,projectId,url) {
  assertId(projectId);
  if(typeof url!=='string'||!url.startsWith(`/media/${projectId}/`)||url.includes('\\')||url.includes('%')||url.includes('?')||url.includes('#')) throw safeError('素材必须属于当前项目。','INVALID_PATH');
  const relative=url.slice(`/media/${projectId}/`.length);
  if(!relative || relative.split('/').some(p=>!p||p==='.'||p==='..'||p.includes(':')))throw safeError('素材路径无效。','INVALID_PATH');
  const root=await realpath(mediaRoot);const projectRoot=path.resolve(root,projectId);const target=path.resolve(projectRoot,relative);
  if(!inRoot(projectRoot,target))throw safeError('素材路径超出项目目录。','INVALID_PATH');
  let actual;
  try{actual=await realpath(target);}catch{throw safeError('素材文件不存在，请重新生成或上传。','MEDIA_MISSING');}
  if(!inRoot(projectRoot,actual))throw safeError('素材链接超出项目目录。','INVALID_PATH');
  return actual;
}

export async function ffmpegAvailable(){try{await Promise.all([access(ffmpegPath),access(ffprobeStatic.path)]);return true;}catch{return false;}}

export function runProcess(command,args,{timeoutMs=120000,maxOutput=1024*1024}={}) {
  return new Promise((resolve,reject)=>{
    let child;
    try{child=spawn(command,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}
    catch{reject(safeError('本地视频工具无法启动，请确认依赖安装完成。','FFMPEG_UNAVAILABLE'));return;}
    let stdout='';let settled=false;
    const finish=(err)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(stdout);};
    const timer=setTimeout(()=>{child.kill();finish(safeError('媒体处理超时，请减小素材后重试。','MEDIA_TIMEOUT'));},timeoutMs);
    child.stdout.on('data',buf=>{stdout+=buf.toString();if(stdout.length>maxOutput){child.kill();finish(safeError('媒体处理结果过大。','MEDIA_INVALID'));}});
    child.stderr.on('data',()=>{});
    child.on('error',()=>finish(safeError('本地视频工具不可用，请重新安装应用依赖。','FFMPEG_UNAVAILABLE')));
    child.on('close',code=>finish(code===0?null:safeError('视频无法解码或处理失败，请检查素材格式。','MEDIA_INVALID')));
  });
}

export async function probeVideo(file,{decode=false,minDuration=0}={}) {
  let info;
  try{info=JSON.parse(await runProcess(ffprobeStatic.path,['-v','error','-protocol_whitelist','file,pipe','-f','mov','-show_streams','-show_format','-of','json',file]));}
  catch(error){if(error.safe)throw error;throw safeError('视频信息无法解析。','MEDIA_INVALID');}
  const stream=info.streams?.find(s=>s.codec_type==='video');
  const duration=Number(info.format?.duration??stream?.duration);
  if(!stream || !info.format?.format_name?.split(',').some(v=>['mov','mp4','m4a','3gp','3g2','mj2'].includes(v)) || !Number.isFinite(duration)||duration<=0||duration>120 || stream.width<16||stream.height<16||stream.width>8192||stream.height>8192)throw safeError('视频格式、尺寸或时长无效。','MEDIA_INVALID');
  if(duration+0.05<minDuration)throw safeError('上游视频时长不足以覆盖剪辑入点和镜头时长。','VIDEO_TOO_SHORT');
  if(decode)await runProcess(ffmpegPath,['-v','error','-xerror','-protocol_whitelist','file,pipe','-f','mov','-i',file,'-map','0:v:0','-f','null','-']);
  return {duration,width:stream.width,height:stream.height,hasAudio:info.streams.some(s=>s.codec_type==='audio')};
}

async function normalizeImage(bytes) {
  if(!bytes.length||bytes.length>MAX_IMAGE)throw safeError('图片须小于 20 MB。','IMAGE_TOO_LARGE');
  try{
    const metadata=await sharp(bytes,{limitInputPixels:40_000_000,animated:false}).metadata();
    if(!['png','jpeg','webp'].includes(metadata.format)||metadata.pages>1||metadata.width<32||metadata.height<32)throw new Error('invalid');
    return await sharp(bytes,{limitInputPixels:40_000_000}).rotate().png().toBuffer();
  }catch{throw safeError('图片必须是可解码的 PNG、JPEG 或 WebP，至少 32×32 像素。','IMAGE_INVALID');}
}

function decodeDataUrl(dataUrl) {
  if(typeof dataUrl!=='string'||dataUrl.length>MAX_IMAGE*1.4)throw safeError('上传图片超过大小限制。','IMAGE_TOO_LARGE');
  const match=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if(!match||match[2].length%4!==0)throw safeError('图片编码无效。','IMAGE_INVALID');
  const bytes=Buffer.from(match[2],'base64');
  if(bytes.toString('base64')!==match[2])throw safeError('图片编码无效。','IMAGE_INVALID');
  return bytes;
}

function csvCell(value){let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';}

const assetStatus=(url,stamp,version)=>!url?'missing':!Number.isInteger(stamp)||stamp<1?'unverified':stamp===version?'current':'stale';
const assetLabels={current:'当前版本',stale:'旧版图片',unverified:'未验证版本',missing:'缺少图片'};
const escapeText=value=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'�').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
let boardFont;
async function chineseFont(){
  if(!boardFont)boardFont=(async()=>{
    const candidates=[
      [path.join(process.env.WINDIR??'C:\\Windows','Fonts','msyh.ttc'),'Microsoft YaHei'],
      ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','Noto Sans CJK SC'],
      ['/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc','WenQuanYi Zen Hei'],
      ['/System/Library/Fonts/PingFang.ttc','PingFang SC'],
    ];
    for(const [file,family] of candidates){try{await access(file);return {file,family};}catch{}}
    throw safeError('设定板需要本机中文字体，请安装微软雅黑或 Noto Sans CJK 后重试。','BOARD_FONT_UNAVAILABLE');
  })();
  return boardFont;
}

function wrapBoardText(value,width,size,maxLines){
  const source=String(value??'').replaceAll('\r','');const limit=Math.max(1,Math.floor(width/size));
  const units=char=>/\s/.test(char)?0.4:/[\x20-\x7e]/.test(char)?0.65:1.05;
  const lines=[''];let used=0,truncated=false;
  for(const char of source){
    if(char==='\n'||used+units(char)>limit){
      if(lines.length===maxLines){truncated=true;break;}
      lines.push('');used=0;if(char==='\n')continue;
    }
    lines[lines.length-1]+=char;used+=units(char);
  }
  if(truncated){
    const suffix='…（截短）';const last=Array.from(lines.at(-1));
    while(last.length&&[...last,...suffix].reduce((sum,char)=>sum+units(char),0)>limit)last.pop();
    lines[lines.length-1]=last.join('')+suffix;
  }
  return {text:lines.join('\n'),truncated};
}

function storyboardManifest(project,segment,shots,kind){
  const segmentBoard=project.generationMode==='segment-board';
  const characterMap=new Map((project.characters??[]).map(item=>[item.id,item]));
  const sceneMap=new Map((project.scenes??[]).map(item=>[item.id,item]));
  const lookMap=new Map();
  for(const look of project.looks??[]){
    const key=JSON.stringify([look.sceneId,look.characterId]);
    if(lookMap.has(key))throw safeError('同一场景角色存在重复造型，请先整理造型资料。','INVALID_INPUT');
    lookMap.set(key,look);
  }
  const characters=[],scenes=[],looks=[];const usedCharacters=new Set(),usedScenes=new Set(),usedLooks=new Map();
  const reviewShots=shots.map(shot=>{
    if(!Array.isArray(shot.characterIds)||shot.characterIds.length>9||shot.characterIds.some(id=>!characterMap.has(id)))throw safeError('分镜引用了未知角色或超过单镜 9 人上限。','INVALID_INPUT');
    const scene=shot.sceneId?sceneMap.get(shot.sceneId):null;
    if(shot.sceneId&&!scene)throw safeError('分镜引用了未知场景。','INVALID_INPUT');
    if(scene&&!usedScenes.has(scene.id)){usedScenes.add(scene.id);scenes.push({id:scene.id,name:scene.name,description:scene.description??''});}
    const mappings=shot.characterIds.map(characterId=>{
      const character=characterMap.get(characterId);
      if(!usedCharacters.has(characterId)){
        usedCharacters.add(characterId);const referenceStatus=segmentBoard?'current':assetStatus(character.reference,character.referenceVersion,character.version);
        characters.push({id:character.id,name:character.name,role:character.role,aliases:character.aliases??[],appearance:character.appearance??'',evidence:character.evidence??'',reference:segmentBoard?null:(character.reference??null),version:character.version,referenceVersion:character.referenceVersion??null,referenceCurrent:referenceStatus==='current',referenceStatus,approved:segmentBoard||character.approved===true,reviewStatus:segmentBoard?'approved':character.approved&&referenceStatus==='current'?'approved':'needs_review'});
      }
      const key=JSON.stringify([scene?.id??null,characterId]);
      if(!usedLooks.has(key)){
        const look=scene?lookMap.get(key):null;
        const referenceStatus=segmentBoard?'current':assetStatus(look?.reference,look?.referenceVersion,look?.version);
        const identity=characters.find(item=>item.id===characterId);
        const entry={id:look?.id??null,mappingKey:key,sceneId:scene?.id??null,sceneName:scene?.name??'待完善场景',characterId,characterName:character.name,name:look?.name??'片段内自动妆造',appearance:look?.appearance??'妆造由片段整板模型依据当前场景生成',reference:segmentBoard?null:(look?.reference??null),version:look?.version??null,referenceVersion:look?.referenceVersion??null,referenceCurrent:referenceStatus==='current',referenceStatus,approved:segmentBoard?true:look?.approved===true,identityCurrent:segmentBoard||identity.referenceCurrent,identityApproved:segmentBoard||identity.approved,reviewStatus:segmentBoard?'approved':look?.approved&&referenceStatus==='current'&&identity.reviewStatus==='approved'?'approved':'needs_review',missingReason:segmentBoard?null:!scene?'scene_missing':!look?'look_missing':!look.reference?'reference_missing':null};
        usedLooks.set(key,entry);looks.push(entry);
      }
      const entry=usedLooks.get(key);return {characterId,sceneId:entry.sceneId,lookId:entry.id,mappingKey:key};
    });
    const imageStatus=assetStatus(shot.image,shot.imageVersion,shot.version);
    const referencesCurrent=segmentBoard||mappings.every(mapping=>{
      const look=usedLooks.get(mapping.mappingKey);const character=characters.find(item=>item.id===mapping.characterId);
      return look.referenceCurrent&&look.approved&&character.referenceCurrent&&character.approved;
    });
    return {id:shot.id,number:shot.number,version:shot.version,imageVersion:shot.imageVersion??null,image:shot.image,imageCurrent:imageStatus==='current',imageStatus,duration:shot.duration,trimStart:shot.trimStart??0,sceneId:scene?.id??null,sceneName:scene?.name??'',scene:shot.scene??'',action:shot.action??'',camera:shot.camera??'',movementId:shot.movementId??'',movementPlan:shot.movementPlan??'',transitionPlan:shot.transitionPlan??'',dialogue:shot.dialogue??'',sourceEvidence:shot.sourceEvidence??'',characterIds:[...shot.characterIds],characterNames:shot.characterIds.map(id=>characterMap.get(id).name),lookIds:mappings.map(item=>item.lookId).filter(Boolean),lookMappings:mappings,approved:shot.approved===true,reviewStatus:shot.approved&&imageStatus==='current'&&referencesCurrent&&!!scene?'approved':'needs_review'};
  });
  if(looks.length>18)throw safeError('单个片段最多容纳 18 组场景角色造型，请拆分片段后导出；未省略任何角色。','BOARD_CAPACITY');
  const statuses=[...reviewShots.map(shot=>shot.imageStatus),...(segmentBoard?[]:characters.map(character=>character.referenceStatus)),...(segmentBoard?[]:looks.map(look=>look.referenceStatus))];
  const assetsCurrent=statuses.every(status=>status==='current');
  const requiresReview=segmentBoard?reviewShots.some(shot=>shot.reviewStatus!=='approved'):!assetsCurrent||reviewShots.some(shot=>shot.reviewStatus!=='approved');
  return {kind,projectId:project.id,projectTitle:project.title??'',workflowVersion:project.workflowVersion??1,segmentId:segment.id,number:segment.number,title:segment.title??'',summary:segment.summary??'',duration:segment.duration,aspectRatio:project.aspectRatio,style:project.style??'',createdAt:new Date().toISOString(),requiresReview,reviewStatus:requiresReview?'needs_review':'approved',assetsCurrent,hasStaleAssets:statuses.includes('stale'),hasUnverifiedAssets:statuses.includes('unverified'),hasMissingReferences:characters.some(item=>item.referenceStatus==='missing')||looks.some(item=>item.referenceStatus==='missing'),scenes,characters,looks,shots:reviewShots};
}

function selectBoardTemplate(segment,options={}){
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='templateId'))throw safeError('预览模板参数无效。','INVALID_INPUT');
  return getBoardTemplate(options.templateId===undefined?segment.boardTemplateId:options.templateId);
}

function storyboardPages(manifest,template){
  const groups=[];
  for(const shot of manifest.shots){
    const key=shot.sceneId??`legacy:${shot.scene}`;
    if(groups.at(-1)?.key!==key)groups.push({key,sceneId:shot.sceneId,sceneName:shot.sceneName||shot.scene||'待完善场景',shots:[]});
    groups.at(-1).shots.push(shot);
  }
  const pages=[];
  for(const group of groups)for(let offset=0;offset<group.shots.length;offset+=template.shotCapacity){
    const shots=group.shots.slice(offset,offset+template.shotCapacity);
    const keys=[...new Set(shots.flatMap(shot=>shot.lookMappings.map(mapping=>mapping.mappingKey)))];
    const looks=keys.map(key=>manifest.looks.find(look=>look.mappingKey===key));
    const firstPage=pages.length+1;
    for(let lookOffset=0;lookOffset<Math.max(1,looks.length);lookOffset+=template.lookCapacity){
      pages.push({number:pages.length+1,sceneId:group.sceneId,sceneName:group.sceneName,shots,looks:looks.slice(lookOffset,lookOffset+template.lookCapacity),continuation:lookOffset>0,continuationOf:lookOffset>0?firstPage:null});
    }
  }
  if(pages.length>81)throw safeError('设定板页数超过 81 页上限，请拆分片段。','BOARD_CAPACITY');
  return pages;
}

function boardLayout(template,aspectRatio='9:16'){
  const margin=32,gap=20,cardWidth=650,top=144,large=template.id==='three-three';
  const cardHeight=large?2044:668,tileWidth=large?612:324,tileHeight=aspectRatio==='16:9'?Math.floor(tileWidth*9/16):(large?1088:576);
  const leftWidth=cardWidth*template.shotColumns+gap*(template.shotColumns-1),rightX=margin+leftWidth+32;
  const gridHeight=cardHeight*template.shotRows+gap*(template.shotRows-1);
  const width=rightX+860+margin,height=top+gridHeight+92,lookCardWidth=860;
  const lookCardHeight=Math.floor((gridHeight-(template.lookCapacity-1)*gap)/template.lookCapacity);
  if(width>6144||height>2560||width<=height||width*height>12_000_000)throw safeError('模板超出设定板尺寸预算。','BOARD_CAPACITY');
  const shots=Array.from({length:template.shotCapacity},(_,index)=>{
    const x=margin+(index%template.shotColumns)*(cardWidth+gap),y=top+Math.floor(index/template.shotColumns)*(cardHeight+gap);
    const textX=large?x+18:x+tileWidth+38,textWidth=large?cardWidth-36:cardWidth-tileWidth-56,size=large?26:22;
    const field=(offset,maxLines,heightLimit)=>({x:textX,y:y+offset,width:textWidth,size,maxLines,heightLimit});
    return {index,x,y,width:cardWidth,height:cardHeight,image:{x:x+18,y:y+68,width:tileWidth,height:tileHeight},text:{camera:large?field(1190,6,222):field(76,5,170),action:large?field(1430,8,304):field(264,7,234),dialogue:large?field(1750,7,266):field(520,4,132)}};
  });
  const looks=Array.from({length:template.lookCapacity},(_,index)=>({index,x:rightX,y:top+index*(lookCardHeight+gap),width:lookCardWidth,height:lookCardHeight}));
  return {kind:'landscape-scene-board',templateId:template.id,width,height,tileWidth,tileHeight,shotAspectRatio:aspectRatio,imageFit:'contain',textPlacement:large?'below-shot-image':'beside-shot-image',shotCapacity:template.shotCapacity,lookCapacity:template.lookCapacity,shotColumns:template.shotColumns,shotRows:template.shotRows,lookColumns:1,lookRows:template.lookCapacity,maxLookCount:18,maxPixels:12_000_000,leftWidth,rightX,cardWidth,cardHeight,lookCardWidth,lookCardHeight,slots:{shots,looks}};
}

async function writeStoryboardCsv(manifest,file){
  const prefix=String(manifest.number).padStart(3,'0');
    const rows=[['片段','分镜','版本','图片版本','图片状态','时长(秒)','剪辑入点(秒)','场景ID','场景名','场景描述','分镜场景','动作','运镜','运镜库编号','运镜执行计划','镜头衔接计划','台词','原文依据','角色ID','角色','造型ID','完整场景造型资料','审核状态','图片','视频'],...manifest.shots.map(shot=>[
    prefix,String(shot.number).padStart(2,'0'),shot.version,shot.imageVersion??'',assetLabels[shot.imageStatus],shot.duration,shot.trimStart,shot.sceneId??'',shot.sceneName,manifest.scenes.find(scene=>scene.id===shot.sceneId)?.description??'',shot.scene,shot.action,shot.camera,shot.movementId,shot.movementPlan,shot.transitionPlan,shot.dialogue,shot.sourceEvidence??'',shot.characterIds.join(' | '),shot.characterNames.join('、'),shot.lookIds.join(' | '),JSON.stringify(shot.lookMappings.map(mapping=>manifest.looks.find(look=>look.mappingKey===mapping.mappingKey))),shot.reviewStatus==='approved'?'已审核':'未审核',shot.image,shot.source??'',
  ])];
  await writeFile(file,'\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n'),'utf8');
}

export function createMediaStore(mediaRoot,{download=requestBuffer,outputRoot=null,renameDirectory=rename,copyFileImpl=copyFile}={}) {
  async function directory(project){
    assertId(project.id);await mkdir(mediaRoot,{recursive:true});const root=await realpath(mediaRoot);const target=path.join(root,project.id);await mkdir(target,{recursive:true});
    if(await realpath(target)!==target)throw safeError('项目目录不可使用外部链接。','INVALID_PATH');
    return target;
  }
  async function save(project,bytes,extension){
    const dir=await directory(project);const name=`${randomUUID()}.${extension}`;const temp=path.join(dir,`${name}.tmp`);
    await writeFile(temp,bytes,{flag:'wx'});await rename(temp,path.join(dir,name));return `/media/${project.id}/${name}`;
  }
  async function importImage(project,dataUrl){return save(project,await normalizeImage(decodeDataUrl(dataUrl)),'png');}
  async function downloadImage(project,url){const bytes=await download(url,{maxBytes:MAX_IMAGE,timeoutMs:90000});return save(project,await normalizeImage(bytes),'png');}
  async function cropStoryboardShots(project,boardUrl,segment,{templateId=segment.boardTemplateId}={}){
    if(!segment||!Array.isArray(segment.shots)||segment.shots.length<1)throw safeError('整板缺少可裁切的镜头。','INVALID_INPUT');
    const file=await resolveMediaPath(mediaRoot,project.id,boardUrl);
    let metadata;try{metadata=await sharp(file,{limitInputPixels:40_000_000}).metadata();}catch{throw safeError('整板图片无法读取。','IMAGE_INVALID');}
    const width=Number(metadata.width),height=Number(metadata.height);
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<128||height<128)throw safeError('整板图片尺寸无效。','IMAGE_INVALID');
    const template=getBoardTemplate(templateId);
    const columns=Math.max(1,Math.min(template.shotColumns,segment.shots.length));
    const rows=Math.max(1,Math.ceil(segment.shots.length/columns));
    // The generated board is storyboard-only. Review labels live in a small
    // bottom annotation band; remove that band before publishing the crop so
    // the image later used by video generation cannot carry board text into a
    // provider request.
    const boardWidth=width;
    const gutter=Math.max(4,Math.floor(Math.min(boardWidth/columns,height/rows)*0.025));
    const cellWidth=Math.floor(boardWidth/columns),cellHeight=Math.floor(height/rows);
    const images={};
    for(const [index,shot] of segment.shots.entries()){
      const column=index%columns,row=Math.floor(index/columns);
      const left=Math.min(width-32,Math.max(0,column*cellWidth+gutter));
      const top=Math.min(height-32,Math.max(0,row*cellHeight+gutter));
      const cropWidth=Math.max(32,Math.min(width-left,cellWidth-gutter*2));
      const fullCropHeight=Math.max(32,Math.min(height-top,cellHeight-gutter*2));
      const cropHeight=Math.max(32,Math.floor(fullCropHeight*0.82));
      const [shotWidth,shotHeight]=project.aspectRatio==='16:9'?[1280,720]:[720,1280];
      const bytes=await sharp(file,{limitInputPixels:40_000_000}).extract({left,top,width:cropWidth,height:cropHeight}).resize(shotWidth,shotHeight,{fit:'cover',position:'centre'}).png().toBuffer();
      images[shot.id]=await save(project,bytes,'png');
    }
    return {images,layout:{templateId:template.id,columns,rows,boardWidth,boardHeight:height,sourceWidth:width,sourceHeight:height,shotWidth:project.aspectRatio==='16:9'?1280:720,shotHeight:project.aspectRatio==='16:9'?720:1280,shotAspectRatio:project.aspectRatio,referenceStrip:'none',annotationFree:true,annotationBandRemovedRatio:0.18} };
  }
  async function imageDataUrl(project,url){
    const file=await resolveMediaPath(mediaRoot,project.id,url);if((await stat(file)).size>MAX_IMAGE)throw safeError('参考图片过大。','IMAGE_TOO_LARGE');
    const png=await normalizeImage(await readFile(file));
    const resized=await sharp(png).resize(1536,1536,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
    return `data:image/png;base64,${resized.toString('base64')}`;
  }
  async function videoSequenceDataUrl(project,urls){
    if(!Array.isArray(urls)||urls.length<2||urls.length>12)throw safeError('视频镜头序列参考图数量无效。','INVALID_INPUT');
    const files=[];
    for(const url of urls){
      const file=await resolveMediaPath(mediaRoot,project.id,url);
      if((await stat(file)).size>MAX_IMAGE)throw safeError('视频镜头参考图片过大。','IMAGE_TOO_LARGE');
      files.push(file);
    }
    const landscape=project.aspectRatio==='16:9';
    const tileWidth=landscape?480:240;
    const tileHeight=landscape?270:427;
    const columns=Math.min(3,urls.length),rows=Math.ceil(urls.length/columns);
    const composites=[];
    for(const [index,file] of files.entries()){
      const input=await readFile(file);
      const tile=await sharp(input,{limitInputPixels:40_000_000}).resize(tileWidth,tileHeight,{fit:'cover',position:'centre'}).png().toBuffer();
      composites.push({input:tile,left:(index%columns)*tileWidth,top:Math.floor(index/columns)*tileHeight});
    }
    const sheet=await sharp({create:{width:tileWidth*columns,height:tileHeight*rows,channels:3,background:'#0b120d'}}).composite(composites).png().toBuffer();
    return `data:image/png;base64,${sheet.toString('base64')}`;
  }
  async function downloadVideo(project,url,shot,{minDuration=4}={}){
    const bytes=await download(url,{maxBytes:250*1024*1024,timeoutMs:180000});
    const dir=await directory(project);const name=`${randomUUID()}.mp4`;const raw=path.join(dir,`${name}.download.tmp`);const normalized=path.join(dir,`${name}.normalized.tmp.mp4`);const requiredDuration=shot?Math.max(minDuration,Math.ceil(Number(shot.trimStart||0)+Number(shot.duration))):0;
    try{
      await writeFile(raw,bytes,{flag:'wx'});
      await probeVideo(raw,{decode:true,minDuration:requiredDuration});
      // Provider files may be valid for ffmpeg but use HEVC/AV1, an unusual
      // pixel format, or a non-faststart layout that fails in browser video
      // elements. Publish one conservative H.264/AAC MP4 for every client.
      // Keep the provider's audio exactly as supplied. Prompt guidance controls
      // unintended voices; local normalization must not decide which speech is
      // meaningful and silently remove it.
      const audioArgs = ['-map','0:a?','-c:a','aac','-b:a','128k'];
      await runProcess(ffmpegPath,['-v','error','-y','-i',raw,'-map','0:v:0',...audioArgs,'-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p','-movflags','+faststart',normalized],{timeoutMs:180000});
      await probeVideo(normalized,{decode:true,minDuration:requiredDuration});
      await rename(normalized,path.join(dir,name));
      return `/media/${project.id}/${name}`;
    }finally{await rm(raw,{force:true});await rm(normalized,{force:true});}
  }
  async function renderVideoPart({source,sourceInfo,output,duration,trimStart=0,width,height,withAudio}){
    const args=['-v','error','-y','-ss',String(trimStart),'-i',source];
    if(withAudio&&!sourceInfo.hasAudio)args.push('-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push('-map','0:v:0');
    if(withAudio)args.push('-map',sourceInfo.hasAudio?'0:a:0':'1:a:0');
    args.push('-t',String(duration),'-vf',`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`,'-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p');
    if(withAudio)args.push('-c:a','aac','-ar','48000','-ac','2','-af','apad');
    else args.push('-an');
    args.push('-movflags','+faststart',output);
    await runProcess(ffmpegPath,args);
  }
  async function cleanupVideos(project,urls){
    if(!Array.isArray(urls)||urls.length>1200)throw safeError('待清理视频清单无效。','OUTPUT_CLEANUP_INVALID');
    const unique=[...new Set(urls)];
    const entries=[];
    for(const url of unique){
      if(typeof url!=='string'||path.extname(url).toLowerCase()!=='.mp4')throw safeError('只能清理 MP4 视频。','OUTPUT_CLEANUP_INVALID');
      const file=await resolveMediaPath(mediaRoot,project.id,url);
      entries.push({url,file});
    }
    const dir=await directory(project);const tombstone=path.join(dir,`.cleanup-${randomUUID()}`);await mkdir(tombstone,{recursive:true});
    const moved=[];let finalized=false;
    const rollback=async()=>{
      if(finalized)return;
      for(const item of [...moved].reverse())await rename(item.tombstone,item.file).catch(()=>{});
      await rm(tombstone,{recursive:true,force:true});
    };
    try{
      for(const [index,item] of entries.entries()){
        const target=path.join(tombstone,`${String(index).padStart(4,'0')}-${path.basename(item.file)}`);
        await rename(item.file,target);moved.push({...item,tombstone:target});
      }
      return {removed:entries.map(item=>item.url),commit:async()=>{await rm(tombstone,{recursive:true,force:true});finalized=true;},rollback};
    }catch(error){await rollback();throw error;}
  }
  async function copyExport(project,artifact){
    if(!outputRoot)return null;
    assertId(project.id);
    if(!artifact||typeof artifact!=='object'||Array.isArray(artifact))throw safeError('导出结果无效，无法保存本地副本。','OUTPUT_COPY_FAILED');
    const urls=[artifact.videoUrl,artifact.gridUrl,artifact.manifestUrl,artifact.csvUrl,...(Array.isArray(artifact.pages)?artifact.pages.map(page=>page?.gridUrl):[])].filter(Boolean);
    if(!urls.length||urls.some(url=>typeof url!=='string'))throw safeError('导出结果缺少可保存文件。','OUTPUT_COPY_FAILED');
    const relativePaths=[];
    for(const url of [...new Set(urls)]){
      const file=await resolveMediaPath(mediaRoot,project.id,url);
      const relative=url.slice(`/media/${project.id}/`.length);
      const segments=relative.split('/');
      if(segments.length<2||!/^export-[A-Za-z0-9-]{8,120}$/.test(segments[0]))throw safeError('导出文件目录无效，无法保存本地副本。','OUTPUT_COPY_FAILED');
      relativePaths.push({file,name:segments.at(-1),exportName:segments[0]});
    }
    const exportNames=new Set(relativePaths.map(item=>item.exportName));
    if(exportNames.size!==1)throw safeError('导出文件不属于同一导出目录。','OUTPUT_COPY_FAILED');
    const exportName=relativePaths[0].exportName;
    const rootPath=path.resolve(outputRoot);
    const mediaPath=path.resolve(mediaRoot);
    if(rootPath===mediaPath||rootPath.startsWith(mediaPath+path.sep))throw safeError('本地 output 目录不能位于服务器媒体目录内。','OUTPUT_COPY_FAILED');
    await mkdir(rootPath,{recursive:true});
    const rootStat=await lstat(rootPath);
    if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||await realpath(rootPath)!==rootPath)throw safeError('本地 output 目录不可使用链接。','OUTPUT_COPY_FAILED');
    const projectRoot=path.join(rootPath,project.id);
    await mkdir(projectRoot,{recursive:true});
    if(await realpath(projectRoot)!==projectRoot)throw safeError('本地 output 项目目录不可使用链接。','OUTPUT_COPY_FAILED');
    const target=path.join(projectRoot,exportName);
    const temporary=path.join(projectRoot,`.${exportName}-${randomUUID()}.tmp`);
    const expectedNames=[...new Set(relativePaths.map(item=>item.name))];
    const outputCopyResult=()=>({status:'saved',directory:`output/${project.id}/${exportName}`,files:expectedNames.map(name=>`output/${project.id}/${exportName}/${name}`)});
    const completeDirectory=async directoryPath=>{
      let directoryStat;
      try{directoryStat=await lstat(directoryPath);}catch(error){if(error.code==='ENOENT')return false;throw error;}
      if(directoryStat.isSymbolicLink()||!directoryStat.isDirectory()||await realpath(directoryPath)!==directoryPath)throw safeError('本地 output 导出目录不可使用链接。','OUTPUT_COPY_FAILED');
      for(const name of expectedNames){
        const filePath=path.join(directoryPath,name);
        let fileStat;
        try{fileStat=await lstat(filePath);}catch(error){if(error.code==='ENOENT')return false;throw error;}
        if(fileStat.isSymbolicLink()||!fileStat.isFile())throw safeError('本地 output 导出文件不可使用链接。','OUTPUT_COPY_FAILED');
        if(await realpath(filePath)!==filePath)throw safeError('本地 output 导出文件不可使用链接。','OUTPUT_COPY_FAILED');
      }
      return true;
    };
    const removeIncompleteTarget=async()=>{
      let targetStat;
      try{targetStat=await lstat(target);}catch(error){if(error.code==='ENOENT')return;throw error;}
      if(targetStat.isSymbolicLink()||!targetStat.isDirectory()||await realpath(target)!==target)throw safeError('本地 output 导出目录不可使用链接。','OUTPUT_COPY_FAILED');
      await rm(target,{recursive:true,force:true});
    };
    await mkdir(temporary,{recursive:true});
    let fallbackTemporary=null;
    try{
      for(const item of relativePaths)await copyFileImpl(item.file,path.join(temporary,item.name));
      // A previous attempt may have left a directory behind. It is reusable
      // only when every expected artifact is present and is a regular file.
      if(await completeDirectory(target)){await rm(temporary,{recursive:true,force:true});return outputCopyResult();}
      await removeIncompleteTarget();
      try{await renameDirectory(temporary,target);}
      catch(error){
        if(error.code!=='EPERM'&&error.code!=='EXDEV')throw error;
        // Directory rename can be rejected on Windows while a scanner holds
        // the staging directory. Copy into a second complete staging folder,
        // then publish that folder atomically. Never write directly to target.
        fallbackTemporary=path.join(projectRoot,`.${exportName}-${randomUUID()}.publish.tmp`);
        await mkdir(fallbackTemporary,{recursive:true});
        for(const name of expectedNames)await copyFileImpl(path.join(temporary,name),path.join(fallbackTemporary,name));
        if(!await completeDirectory(fallbackTemporary))throw safeError('本地 output 导出副本不完整。','OUTPUT_COPY_FAILED');
        if(await completeDirectory(target)){await rm(fallbackTemporary,{recursive:true,force:true});fallbackTemporary=null;return outputCopyResult();}
        await removeIncompleteTarget();
        await renameDirectory(fallbackTemporary,target);
        fallbackTemporary=null;
      }
    }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
    finally{await rm(temporary,{recursive:true,force:true});if(fallbackTemporary)await rm(fallbackTemporary,{recursive:true,force:true});}
    return outputCopyResult();
  }
  async function writeStoryboardGrid(project,manifest,page,template,output,pageCount){
    const layout=boardLayout(template,project.aspectRatio),margin=32;
    const {width,height,leftWidth,rightX,cardWidth,cardHeight,tileWidth,tileHeight,lookCardWidth,lookCardHeight}=layout;
    const font=await chineseFont();const layers=[],shapes=[],truncatedFields=[],imageCache=new Map();
    const rect=(x,y,w,h,fill='#fffdf9',stroke='#d9dde0')=>shapes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}"/>`);
    async function text(value,x,y,w,size=22,maxLines=1,color='#26343d',context,heightLimit){
      const maxHeight=heightLimit??Math.ceil(size*1.4)*maxLines+4*(maxLines-1);
      let wrapped,rendered,wrapWidth=w;
      // Pango may expand an unbroken word beyond its requested width. Only
      // measured pixel bounds permit a text layer into the fixed board layout.
      for(let attempt=0;attempt<32;attempt++){
        wrapped=wrapBoardText(value,wrapWidth,size,maxLines);
        if(!wrapped.text.trim())return;
        rendered=await sharp({text:{text:`<span foreground="${color}">${escapeText(wrapped.text)}</span>`,font:`${font.family} ${size}`,fontfile:font.file,rgba:true,width:w,spacing:4}}).png().toBuffer({resolveWithObject:true});
        if(rendered.info.width<=w&&rendered.info.height<=maxHeight)break;
        if(rendered.info.width<=w&&maxLines>1){maxLines--;continue;}
        const nextWidth=Math.floor(wrapWidth*Math.min(0.9,w/rendered.info.width*0.95));
        if(nextWidth<1||nextWidth>=wrapWidth)break;
        wrapWidth=nextWidth;
      }
      if(rendered.info.width>w||rendered.info.height>maxHeight)throw safeError('设定板文字超出排版区域，请检查本机字体。','BOARD_TEXT_OVERFLOW');
      if(wrapped.truncated&&context)truncatedFields.push(context);
      layers.push({input:rendered.data,left:Math.round(x),top:Math.round(y)});
    }
    async function picture(url,x,y,w,h){
      const key=JSON.stringify([url,w,h]);
      if(!imageCache.has(key)){
        const file=await resolveMediaPath(mediaRoot,project.id,url);
        imageCache.set(key,await sharp(file,{limitInputPixels:40_000_000}).resize(w,h,{fit:'contain',background:'#e8ebed'}).png().toBuffer());
      }
      layers.push({input:imageCache.get(key),left:x,top:y});
    }
    const prefix=String(manifest.number).padStart(3,'0');
    await text(`${prefix}  ${manifest.projectTitle} · ${manifest.title}`,margin,25,width-820,34,1,'#1a2d38',{kind:'segment',id:manifest.segmentId,field:'title'});
    await text(`片段 ${manifest.duration} 秒 · 第 ${page.number}/${pageCount} 页${page.continuation?' · 造型续页':''} · ${manifest.requiresReview?'待检查':'已审核'}`,width-780,36,748,22,1,manifest.requiresReview?'#8b531d':'#276d56');
    await text(`${template.name} · 场景：${page.sceneName}`,margin,96,leftWidth,24,1,'#26343d',{kind:'page',id:String(page.number),field:'sceneName'});
    await text(`场景造型 / 正面 · 侧面 · 背面 / ${page.looks.length} 组`,rightX,96,width-rightX-margin,24);
    const emptyShotSlots=[],emptyLookSlots=[];
    for(let i=0;i<template.shotCapacity;i++){
      const shot=page.shots[i],slot=layout.slots.shots[i];const {x,y}=slot;
      rect(x,y,cardWidth,cardHeight);
      if(!shot){
        emptyShotSlots.push(i+1);rect(slot.image.x,slot.image.y,tileWidth,tileHeight,'#eceeea');
        await text(`空分镜槽位 ${String(i+1).padStart(2,'0')}`,x+18,y+20,cardWidth-36,25,1,'#7a858b');
        await text('本页没有更多分镜',x+36,y+130,cardWidth-72,28,2,'#7a858b');
        await text('保留固定位置，不补帧、不改变镜头顺序。',x+36,y+220,cardWidth-72,22,3,'#7a858b');
        continue;
      }
      await picture(shot.image,slot.image.x,slot.image.y,slot.image.width,slot.image.height);
      const context=field=>({kind:'shot',id:shot.id,field});
      await text(`${String(shot.number).padStart(2,'0')} · ${shot.duration.toFixed(2)} 秒`,x+18,y+20,cardWidth-160,27,1,'#26343d');
      await text(shot.reviewStatus==='approved'?'已审核':'待审核',x+cardWidth-108,y+24,90,22,1,shot.reviewStatus==='approved'?'#276d56':'#8b531d');
      for(const [field,label] of [['camera','景别 / 运镜'],['action','动作'],['dialogue','台词']]){
        const area=slot.text[field];
        await text(`${label}\n${shot[field]||'—'}`,area.x,area.y,area.width,area.size,area.maxLines,field==='camera'?'#4e5e69':'#26343d',context(field),area.heightLimit);
      }
    }
    for(let i=0;i<template.lookCapacity;i++){
      const look=page.looks[i];const {x,y}=layout.slots.looks[i];
      rect(x,y,lookCardWidth,lookCardHeight);const inner=lookCardWidth-36;
      const imageHeight=Math.min(Math.round(inner*9/16),lookCardHeight-368),imageBottom=103+imageHeight;
      if(!look){
        emptyLookSlots.push(i+1);rect(x+18,y+103,inner,imageHeight,'#eceeea');
        await text(`空造型槽位 ${String(i+1).padStart(2,'0')}`,x+18,y+18,inner,28,1,'#7a858b');
        await text('本页没有对应的角色造型',x+36,y+140,inner-36,25,2,'#7a858b');
        await text('保留固定位置，不代用其他场景的服装。',x+36,y+230,inner-36,22,3,'#7a858b');
        continue;
      }
      const context=field=>({kind:'look',id:look.id,mappingKey:look.mappingKey,field});
      await text(look.characterName,x+18,y+18,inner,29,1,'#1a2d38',context('characterName'),38);
      await text(`场景：${look.sceneName}`,x+18,y+61,inner,22,1,'#4e5e69',context('sceneName'));
      if(look.reference){await picture(look.reference,x+18,y+103,inner,imageHeight);}
      else{
        rect(x+18,y+103,inner,imageHeight,'#f1ede6','#d7caba');
        await text('缺少正面 / 侧面 / 背面三视图',x+36,y+128+Math.floor(imageHeight/4),inner-36,24,2,'#8b531d');
        const note=look.missingReason==='scene_missing'?'旧格式：请先完善场景与造型':look.missingReason==='look_missing'?'请为此场景建立角色造型':'请生成或上传本造型三视图';
        await text(note,x+36,y+156+Math.floor(imageHeight/2),inner-36,21,2,'#66594b');
      }
      await text('正面  /  侧面  /  背面',x+18,y+imageBottom+16,inner,20,1,'#657781');
      await text(`造型：${look.name}`,x+18,y+imageBottom+53,inner,23,1,'#26343d',context('name'));
      const descriptionY=imageBottom+97,descriptionLines=Math.max(1,Math.floor((lookCardHeight-descriptionY-102)/26));
      await text(look.appearance||'造型说明待补充',x+18,y+descriptionY,inner,22,descriptionLines,'#4e5e69',context('appearance'),lookCardHeight-descriptionY-102);
      const shotNumbers=page.shots.filter(shot=>shot.lookMappings.some(mapping=>mapping.mappingKey===look.mappingKey)).map(shot=>String(shot.number).padStart(2,'0'));
      await text(`本页登记镜头：${shotNumbers.join(' · ')}`,x+18,y+lookCardHeight-82,inner,20,1,'#657781');
      const current=look.reviewStatus==='approved';
      await text(`${look.identityCurrent&&look.identityApproved?'身份已确认':'身份待确认'} · ${assetLabels[look.referenceStatus]} · ${look.referenceCurrent&&look.approved?'造型已确认':'造型待确认'}`,x+18,y+lookCardHeight-42,inner,18,1,current?'#276d56':'#8b531d');
    }
    await text(page.continuation?'造型续页：重复本组镜头以核对其余造型，不增加成片镜头 · 完整文字见 CSV / manifest':'设定板仅用于检查 · 镜头原图与视频独立保存 · …（截短）表示完整文字见 CSV / manifest',margin,height-56,width-margin*2,22,1,'#657781');
    const background=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f2f0eb"/>${shapes.join('')}</svg>`);
    await sharp(background).composite(layers).jpeg({quality:94,chromaSubsampling:'4:4:4'}).toFile(output);
    return {...layout,sourceAspectRatio:project.aspectRatio,lookCount:page.looks.length,fontFamily:font.family,emptyShotSlots,emptyLookSlots,truncatedFields};
  }
  async function writeStoryboardPages(project,manifest,template,plans,outputDir,base){
    const prefix=String(manifest.number).padStart(3,'0'),pages=[];
    for(const page of plans){
      const name=plans.length===1?`${prefix}.jpg`:`${prefix}-${String(page.number).padStart(2,'0')}.jpg`;
      const layout=await writeStoryboardGrid(project,manifest,page,template,path.join(outputDir,name),plans.length);
      pages.push({number:page.number,gridUrl:`${base}/${name}`,sceneId:page.sceneId,sceneName:page.sceneName,shotNumbers:page.shots.map(shot=>shot.number),lookIds:page.looks.map(look=>look.id).filter(Boolean),lookMappingKeys:page.looks.map(look=>look.mappingKey),continuation:page.continuation,continuationOf:page.continuationOf,layout});
    }
    manifest.templateId=template.id;manifest.pages=pages;manifest.layout=pages[0].layout;manifest.grid=manifest.layout;
    return pages;
  }
  async function exportStoryboardPreview(project,segment,options={}){
    const template=selectBoardTemplate(segment,options);
    const segmentBoard=project.generationMode==='segment-board';
    const minimumShots=segmentBoard?3:9,maximumShots=segmentBoard?12:9;
    if(!Number.isInteger(segment.number)||segment.number<1)throw safeError('片段编号无效。','INVALID_EXPORT');
    if(!['9:16','16:9'].includes(project.aspectRatio))throw safeError('预览画幅必须为 9:16 或 16:9。','INVALID_INPUT');
    if(!Array.isArray(segment.shots)||segment.shots.length<minimumShots||segment.shots.length>maximumShots)throw safeError(`预览需要完整的 ${minimumShots === maximumShots ? minimumShots : `${minimumShots} 到 ${maximumShots}`} 个分镜图片。`,'EXPORT_INCOMPLETE');
    const shots=[...segment.shots].sort((a,b)=>a.number-b.number);
    if(shots.some((s,i)=>s.number!==i+1||!s.image))throw safeError(`预览需要按 1–${shots.length} 连续编号的完整分镜图片。`,'EXPORT_INCOMPLETE');
    const flexibleDuration=segmentBoard&&project.durationMode==='auto';
    if((flexibleDuration?(segment.duration<3||segment.duration>30):![15,30].includes(segment.duration))||shots.some(s=>!Number.isFinite(s.duration)||s.duration<=0||s.duration>15)||Math.abs(shots.reduce((sum,s)=>sum+s.duration,0)-segment.duration)>0.01)throw safeError('分镜总时长与片段时长不符。','EXPORT_DURATION');
    const manifest=storyboardManifest(project,segment,shots,'storyboard-preview');
    const plans=storyboardPages(manifest,template);
    // Resolve every source before creating an artifact directory. The shared
    // renderer repeats the boundary check when opening each image.
    for(const shot of shots)await resolveMediaPath(mediaRoot,project.id,shot.image);
    const dir=await directory(project),previewName=`preview-${randomUUID()}`;
    const temp=path.join(dir,`.${previewName}`),target=path.join(dir,previewName);
    const base=`/media/${project.id}/${previewName}`;
    await mkdir(temp);
    try{
      const pages=await writeStoryboardPages(project,manifest,template,plans,temp,base);
      await writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
      await writeStoryboardCsv(manifest,path.join(temp,'分镜清单.csv'));
      await rename(temp,target);
      const {requiresReview,assetsCurrent,hasStaleAssets,hasUnverifiedAssets,hasMissingReferences,createdAt}=manifest;
      return {kind:'storyboard-preview',projectId:project.id,segmentId:segment.id,number:segment.number,duration:segment.duration,aspectRatio:project.aspectRatio,templateId:template.id,pages,gridUrl:pages[0].gridUrl,manifestUrl:`${base}/manifest.json`,csvUrl:`${base}/分镜清单.csv`,requiresReview,assetsCurrent,hasStaleAssets,hasUnverifiedAssets,hasMissingReferences,layout:manifest.layout,createdAt};
    }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
  }
  async function exportSegment(project,segment){
    const template=selectBoardTemplate(segment);
    const segmentBoard=project.generationMode==='segment-board';
    const minimumShots=segmentBoard?3:9,maximumShots=segmentBoard?12:9;
    if(!Number.isInteger(segment.number)||segment.number<1)throw safeError('片段编号无效。','INVALID_EXPORT');
    if(!Array.isArray(segment.shots)||segment.shots.length<minimumShots||segment.shots.length>maximumShots)throw safeError(`导出需要完整的 ${minimumShots === maximumShots ? minimumShots : `${minimumShots} 到 ${maximumShots}`} 个分镜。`,'EXPORT_INCOMPLETE');
    const flexibleDuration=segmentBoard&&project.durationMode==='auto';
    if(flexibleDuration?(segment.duration<3||segment.duration>30):![15,30].includes(segment.duration))throw safeError(flexibleDuration?'自动片段时长必须在 3 到 30 秒之间。':'片段时长必须是 15 或 30 秒。','EXPORT_DURATION');
    const shots=[...segment.shots].sort((a,b)=>a.number-b.number);
    if(shots.some((s,i)=>s.number!==i+1))throw safeError(`分镜编号必须依次为 1–${shots.length}。`,'EXPORT_INCOMPLETE');
    if(segmentBoard){
      if(!segment.video||segment.videoVersion===null)throw safeError('片段缺少当前版本的完整视频。','EXPORT_STALE');
      if(shots.some(s=>!s.approved||!s.image))throw safeError('分镜须全部审核且保留当前画面。','EXPORT_STALE');
      const source=await resolveMediaPath(mediaRoot,project.id,segment.video);
      const info=await probeVideo(source,{decode:true,minDuration:segment.duration-0.05});
      if(Math.abs(info.duration-segment.duration)>0.35)throw safeError('片段完整视频时长与设定不一致。','EXPORT_DURATION');
      const manifest=storyboardManifest(project,segment,shots,'segment-export');
      const plans=storyboardPages(manifest,template);
      const dir=await directory(project);const exportName=`export-${randomUUID()}`;const temp=path.join(dir,`.${exportName}`);const target=path.join(dir,exportName);const prefix=String(segment.number).padStart(3,'0'),base=`/media/${project.id}/${exportName}`;
      await mkdir(temp);
      try{
        await copyFile(source,path.join(temp,`${prefix}.mp4`));
        const pages=await writeStoryboardPages(project,manifest,template,plans,temp,base);
        Object.assign(manifest,{duration:info.duration,width:info.width,height:info.height,fps:info.fps,audio:info.hasAudio?'present':'muted',shots:manifest.shots.map(shot=>({...shot,source:segment.video,videoVersion:segment.videoVersion,exportedDuration:shot.duration}))});
        await writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
        await writeStoryboardCsv(manifest,path.join(temp,'分镜清单.csv'));
        await rename(temp,target);
        return {videoUrl:`${base}/${prefix}.mp4`,templateId:template.id,pages,gridUrl:pages[0].gridUrl,manifestUrl:`${base}/manifest.json`,csvUrl:`${base}/分镜清单.csv`};
      }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
    }
    if(shots.some(s=>!s.approved||!s.image||!s.video||s.videoVersion!==s.version))throw safeError('分镜须全部审核且视频版本与当前分镜一致。','EXPORT_STALE');
    if(shots.some(s=>!Number.isFinite(s.duration)||s.duration<=0||!Number.isFinite(s.trimStart??0)||(s.trimStart??0)<0))throw safeError('分镜剪辑时长无效。','EXPORT_DURATION');
    const total=shots.reduce((sum,s)=>sum+s.duration,0);
    if(Math.abs(total-segment.duration)>0.05)throw safeError('分镜总时长与片段时长不符。','EXPORT_DURATION');
    const manifest=storyboardManifest(project,segment,shots,'segment-export');
    if(project.workflowVersion>=2&&manifest.requiresReview)throw safeError('人物、场景造型和分镜图片须均为已审核的当前版本。','EXPORT_STALE');
    const plans=storyboardPages(manifest,template);
        const sources=[];
    for(const shot of shots){const file=await resolveMediaPath(mediaRoot,project.id,shot.video);const info=await probeVideo(file,{minDuration:(shot.trimStart??0)+shot.duration});sources.push({file,info});}
    const withAudio=sources.some(source=>source.info.hasAudio);
    const dir=await directory(project);const exportName=`export-${randomUUID()}`;const temp=path.join(dir,`.${exportName}`);await mkdir(temp);
    const target=path.join(dir,exportName);const prefix=String(segment.number).padStart(3,'0'),base=`/media/${project.id}/${exportName}`;
    const [width,height]=project.aspectRatio==='16:9'?[1280,720]:[720,1280];
    try{
      const frames=[];let elapsed=0;let previousFrame=0;
      for(let i=0;i<shots.length;i++){
        elapsed+=shots[i].duration;const endFrame=Math.round(elapsed*30);const count=endFrame-previousFrame;previousFrame=endFrame;
        if(count<1)throw safeError('单个分镜时长不足一帧。','EXPORT_DURATION');frames.push(count);
        await renderVideoPart({source:sources[i].file,sourceInfo:sources[i].info,output:path.join(temp,`part-${i}.mp4`),duration:frames[i]/30,trimStart:shots[i].trimStart??0,width,height,withAudio});
      }
      await writeFile(path.join(temp,'concat.txt'),shots.map((_,i)=>`file 'part-${i}.mp4'`).join('\n'));
      const videoFile=path.join(temp,`${prefix}.mp4`);
       const concatArgs=['-v','error','-y','-f','concat','-safe','1','-i',path.join(temp,'concat.txt'),'-map','0:v:0'];
       if(withAudio)concatArgs.push('-map','0:a:0');else concatArgs.push('-an');
       concatArgs.push('-c','copy','-movflags','+faststart',videoFile);
       await runProcess(ffmpegPath,concatArgs);
      const resultInfo=await probeVideo(videoFile,{decode:true,minDuration:segment.duration-0.05});
      if(Math.abs(resultInfo.duration-segment.duration)>0.15)throw safeError('导出时长校验失败。','EXPORT_DURATION');
      const pages=await writeStoryboardPages(project,manifest,template,plans,temp,base);
       Object.assign(manifest,{duration:resultInfo.duration,width,height,fps:30,audio:withAudio?'present':'muted'});
      manifest.shots=manifest.shots.map((shot,i)=>({...shot,source:shots[i].video,videoVersion:shots[i].videoVersion,plannedDuration:shots[i].duration,exportedDuration:frames[i]/30}));
      await writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
      await writeStoryboardCsv(manifest,path.join(temp,'分镜清单.csv'));
      for(let i=0;i<shots.length;i++)await rm(path.join(temp,`part-${i}.mp4`));await rm(path.join(temp,'concat.txt'));
      await rename(temp,target);
      return {videoUrl:`${base}/${prefix}.mp4`,templateId:template.id,pages,gridUrl:pages[0].gridUrl,manifestUrl:`${base}/manifest.json`,csvUrl:`${base}/分镜清单.csv`};
    }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
  }
  async function exportProject(project, segments){
    if(!Array.isArray(segments)||!segments.length)throw safeError('项目没有可导出的片段。','EXPORT_INCOMPLETE');
    const ordered=[...segments].sort((a,b)=>a.number-b.number);
    if(project.generationMode==='segment-board'){
      const sources=[];
      for(const segment of ordered){
        if(!segment.video||segment.videoVersion===null)throw safeError(`片段 ${segment.number} 缺少当前版本的完整视频。`,'EXPORT_STALE');
        const file=await resolveMediaPath(mediaRoot,project.id,segment.video);const info=await probeVideo(file,{decode:true,minDuration:segment.duration-0.05});sources.push({segment,file,info});
      }
      const withAudio=sources.some(source=>source.info.hasAudio);
      const exportName=`export-${randomUUID()}`;const dir=await directory(project);const temp=path.join(dir,`.${exportName}`);const target=path.join(dir,exportName);const base=`/media/${project.id}/${exportName}`;const [width,height]=project.aspectRatio==='16:9'?[1280,720]:[720,1280];await mkdir(temp);
      try{
        for(const [index,item] of sources.entries())await renderVideoPart({source:item.file,sourceInfo:item.info,output:path.join(temp,`part-${index}.mp4`),duration:item.segment.duration,trimStart:0,width,height,withAudio});
        await writeFile(path.join(temp,'concat.txt'),sources.map((_,index)=>`file 'part-${index}.mp4'`).join('\n'),'utf8');
        const videoFile=path.join(temp,'project.mp4');const concatArgs=['-v','error','-y','-f','concat','-safe','1','-i',path.join(temp,'concat.txt'),'-map','0:v:0'];if(withAudio)concatArgs.push('-map','0:a:0');else concatArgs.push('-an');concatArgs.push('-c','copy','-movflags','+faststart',videoFile);await runProcess(ffmpegPath,concatArgs);
        const info=await probeVideo(videoFile,{decode:true,minDuration:ordered.reduce((sum,segment)=>sum+segment.duration,0)-0.1});
        const firstImage=await resolveMediaPath(mediaRoot,project.id,ordered[0].shots.find(shot=>shot.image)?.image);const cover=await sharp(firstImage).resize(width,height,{fit:'contain',background:'#101711'}).jpeg({quality:88}).toBuffer();await writeFile(path.join(temp,'project.jpg'),cover);
        const manifest={kind:'project-export',projectId:project.id,title:project.title,aspectRatio:project.aspectRatio,duration:info.duration,width,height,fps:30,audio:withAudio?'present':'muted',segments:ordered.map(segment=>({id:segment.id,number:segment.number,title:segment.title,duration:segment.duration,video:segment.video,videoVersion:segment.videoVersion})),shots:ordered.flatMap(segment=>[...segment.shots].sort((a,b)=>a.number-b.number).map(shot=>({id:shot.id,number:shot.number,segmentId:segment.id,segmentNumber:segment.number,segmentTitle:segment.title,scene:shot.scene,action:shot.action,camera:shot.camera,movementId:shot.movementId??'',movementPlan:shot.movementPlan??'',transitionPlan:shot.transitionPlan??'',dialogue:shot.dialogue,plannedDuration:shot.duration,source:segment.video,videoVersion:segment.videoVersion})))};
        await writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
        const csv=['项目,片段编号,片段名称,镜头编号,场景,动作,运镜,运镜库编号,运镜执行计划,镜头衔接计划,台词,计划时长,来源',...manifest.shots.map(shot=>[project.title,shot.segmentNumber,shot.segmentTitle,shot.number,shot.scene,shot.action,shot.camera,shot.movementId,shot.movementPlan,shot.transitionPlan,shot.dialogue,shot.plannedDuration,shot.source].map(value=>`"${String(value??'').replace(/"/g,'""')}"`).join(','))].join('\n');await writeFile(path.join(temp,'项目镜头清单.csv'),csv,'utf8');
        for(const [index] of sources.entries())await rm(path.join(temp,`part-${index}.mp4`),{force:true});await rm(path.join(temp,'concat.txt'),{force:true});await rename(temp,target);
        return {videoUrl:`${base}/project.mp4`,gridUrl:`${base}/project.jpg`,manifestUrl:`${base}/manifest.json`,csvUrl:`${base}/项目镜头清单.csv`};
      }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
    }
    const shots=ordered.flatMap(segment=>[...segment.shots].sort((a,b)=>a.number-b.number).map(shot=>({...shot,segmentId:segment.id,segmentNumber:segment.number,segmentTitle:segment.title})));
    if(!shots.length||shots.some(shot=>!shot.approved||!shot.video||shot.videoVersion!==shot.version))throw safeError('所有片段都需要完成审核并生成当前版本视频。','EXPORT_STALE');
    if(shots.some(shot=>!Number.isFinite(shot.duration)||shot.duration<=0||!Number.isFinite(shot.trimStart??0)||(shot.trimStart??0)<0))throw safeError('项目中存在无效的镜头时长。','EXPORT_DURATION');
    const sources=[];for(const shot of shots){const file=await resolveMediaPath(mediaRoot,project.id,shot.video);const info=await probeVideo(file,{minDuration:(shot.trimStart??0)+shot.duration});sources.push({file,info});}
    const withAudio=sources.some(source=>source.info.hasAudio);
    const total=shots.reduce((sum,shot)=>sum+shot.duration,0);const exportName=`export-${randomUUID()}`;const dir=await directory(project);const temp=path.join(dir,`.${exportName}`);const target=path.join(dir,exportName);const base=`/media/${project.id}/${exportName}`;const prefix='project';const [width,height]=project.aspectRatio==='16:9'?[1280,720]:[720,1280];await mkdir(temp);
    try{
      let elapsed=0;let previousFrame=0;const frames=[];
      for(let index=0;index<shots.length;index++){
        elapsed+=shots[index].duration;const endFrame=Math.round(elapsed*30);const count=endFrame-previousFrame;previousFrame=endFrame;if(count<1)throw safeError('项目中存在不足一帧的镜头。','EXPORT_DURATION');frames.push(count);
        await renderVideoPart({source:sources[index].file,sourceInfo:sources[index].info,output:path.join(temp,`part-${index}.mp4`),duration:frames[index]/30,trimStart:shots[index].trimStart??0,width,height,withAudio});
      }
      await writeFile(path.join(temp,'concat.txt'),shots.map((_,index)=>`file 'part-${index}.mp4'`).join('\n'),'utf8');
      const videoFile=path.join(temp,`${prefix}.mp4`);const concatArgs=['-v','error','-y','-f','concat','-safe','1','-i',path.join(temp,'concat.txt'),'-map','0:v:0'];if(withAudio)concatArgs.push('-map','0:a:0');else concatArgs.push('-an');concatArgs.push('-c','copy','-movflags','+faststart',videoFile);await runProcess(ffmpegPath,concatArgs);
      const resultInfo=await probeVideo(videoFile,{decode:true,minDuration:total-0.05});if(Math.abs(resultInfo.duration-total)>0.2)throw safeError('项目成片时长校验失败。','EXPORT_DURATION');
      const firstImageSource=await resolveMediaPath(mediaRoot,project.id,shots[0].image);const firstImage=await sharp(firstImageSource).resize(960,540,{fit:'contain',background:'#101711'}).jpeg({quality:88}).toBuffer();await writeFile(path.join(temp,'project.jpg'),firstImage);
      const manifest={kind:'project-export',projectId:project.id,title:project.title,aspectRatio:project.aspectRatio,duration:resultInfo.duration,width,height,fps:30,audio:withAudio?'present':'muted',segments:ordered.map(segment=>({id:segment.id,number:segment.number,title:segment.title,duration:segment.duration})),shots:shots.map((shot,index)=>({id:shot.id,number:shot.number,segmentId:shot.segmentId,segmentNumber:shot.segmentNumber,segmentTitle:shot.segmentTitle,scene:shot.scene,action:shot.action,camera:shot.camera,movementId:shot.movementId??'',movementPlan:shot.movementPlan??'',transitionPlan:shot.transitionPlan??'',dialogue:shot.dialogue,plannedDuration:shot.duration,exportedDuration:frames[index]/30,source:shot.video,videoVersion:shot.videoVersion}))};
      await writeFile(path.join(temp,'manifest.json'),JSON.stringify(manifest,null,2),'utf8');
      const csv=['项目,片段编号,片段名称,镜头编号,场景,动作,运镜,运镜库编号,运镜执行计划,镜头衔接计划,台词,计划时长,导出时长',...shots.map((shot,index)=>[project.title,shot.segmentNumber,shot.segmentTitle,shot.number,shot.scene,shot.action,shot.camera,shot.movementId??'',shot.movementPlan??'',shot.transitionPlan??'',shot.dialogue,shot.duration,frames[index]/30].map(value=>`"${String(value??'').replace(/"/g,'""')}"`).join(','))].join('\n');await writeFile(path.join(temp,'项目镜头清单.csv'),csv,'utf8');
      for(let index=0;index<shots.length;index++)await rm(path.join(temp,`part-${index}.mp4`),{force:true});await rm(path.join(temp,'concat.txt'),{force:true});await rename(temp,target);
      return {videoUrl:`${base}/${prefix}.mp4`,gridUrl:`${base}/project.jpg`,manifestUrl:`${base}/manifest.json`,csvUrl:`${base}/项目镜头清单.csv`};
    }catch(error){await rm(temp,{recursive:true,force:true});throw error;}
  }
  return {importImage,downloadImage,imageDataUrl,videoSequenceDataUrl,cropStoryboardShots,downloadVideo,cleanupVideos,exportSegment,exportProject,exportStoryboardPreview,copyExport};
}

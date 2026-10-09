import http from 'node:http';
import {createReadStream} from 'node:fs';
import {stat,realpath} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import {createMediaThumbnail} from './media.mjs';
import {DEFAULT_BOARD_TEMPLATE_ID,BOARD_TEMPLATES} from './board-templates.mjs';
import {createLocalSession} from './local-session.mjs';
import {accountKey} from './workspaces.mjs';

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.csv':'text/csv; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.exe':'application/vnd.microsoft.portable-executable'};
const BODY_LIMIT=24*1024*1024;
const bad=(message,status=400)=>Object.assign(new Error(message),{status,code:'REQUEST_INVALID'});
const MEDIA_FIELDS=new Set(['image','video','reference','storyboardImage','gridUrl','manifestUrl','csvUrl','videoUrl','assetUrl']);
const cleanPathPrefix=value=>{const text=typeof value==='string'?value.trim():'';if(!text||text==='/')return '';return `/${text.replace(/^\/+|\/+$/g,'')}`;};
const publicBasePath=cleanPathPrefix(process.env.AI_FRAME_BASE_PATH);
function json(res,status,data){
  const payload=Buffer.from(JSON.stringify(data,(key,value)=>{
    if(!MEDIA_FIELDS.has(key)||typeof value!=='string'||!value.startsWith('/media/'))return value;
    const exposed=`${publicBasePath}${value}`;
    if(!res.accountKey)return exposed;
    const query=new URLSearchParams({account:res.accountKey,...(res.sessionId?{session:res.sessionId}:{})});
    return `${exposed}?${query}`;
  }));
  const compressed=res.acceptsGzip&&payload.length>=16*1024?gzipSync(payload):null;
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Vary':'Accept-Encoding',
    ...(compressed?{'Content-Encoding':'gzip'}:{}),
  });
  res.end(compressed||payload);
}
async function body(req,limit=BODY_LIMIT){
  if(req.parsedBody)return req.parsedBody;
  if(!req.headers['content-type']?.startsWith('application/json')) throw bad('请求需要 JSON 格式');
  const size=Number(req.headers['content-length']||0);if(size>limit) throw bad('上传文件过大',413);
  let bytes=0;const chunks=[];
  for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw bad('上传文件过大',413);chunks.push(chunk);}
  try {const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();req.parsedBody=value;return value;}catch{throw bad('无法读取 JSON 请求');}
}
async function sendFile(req,res,root,name,privateMedia=false,download=false){
  if(name.includes('\0')||name.includes('\\')||name.split('/').some(p=>p.startsWith('.'))) throw bad('找不到文件',404);
  const base=await realpath(root).catch(()=>null);if(!base)throw bad('找不到文件',404);
  const candidate=path.resolve(base,name);
  if(!candidate.startsWith(base+path.sep))throw bad('找不到文件',404);
  const file=await realpath(candidate).catch(()=>null);
  if(!file||!file.startsWith(base+path.sep))throw bad('找不到文件',404);
  const info=await stat(file);if(!info.isFile())throw bad('找不到文件',404);
  const ext=path.extname(file).toLowerCase();if(!MIME[ext])throw bad('不支持的文件类型',404);
  let start=0,end=info.size-1,status=200;
  if(req.headers.range){
    const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if(!match)throw bad('无效的媒体范围',416);
    start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;
    if(start>end||start>=info.size)throw bad('无效的媒体范围',416);
    status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${info.size}`);
  }
  const headers={'Content-Type':MIME[ext],'Content-Length':Math.max(0,end-start+1),'Accept-Ranges':'bytes','Cache-Control':privateMedia?'no-store':ext==='.html'?'no-cache':'private, max-age=60'};
  if(download)headers['Content-Disposition']=`attachment; filename="${path.basename(file).replace(/"/g,'')}"`;
  res.writeHead(status,headers);
  if(req.method==='HEAD')return res.end();
  const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());stream.pipe(res);
}

async function sendThumbnail(req, res, mediaRoot, projectId, relative) {
  const original = `/media/${projectId}/${relative}`;
  const image = await createMediaThumbnail(mediaRoot, projectId, original);
  const headers = {
    'Content-Type': 'image/jpeg',
    'Content-Length': image.length,
    'Cache-Control': 'private, max-age=600',
    'X-Content-Type-Options': 'nosniff',
  };
  res.writeHead(200, headers);
  if (req.method !== 'HEAD') res.end(image);
  else res.end();
}

export async function createHttpServer({auth,authFactory,workspaces,distDir,downloadsDir=null,adminDir=path.join(distDir,'admin'),adminAuth=null,port=0,allowDevOrigin=false}){
  if((!auth&&!authFactory)||!workspaces)throw new Error('Authentication and account workspaces are required.');
  const sessions=createLocalSession(auth,{factory:authFactory});
  let address;
  const server=http.createServer(async(req,res)=>{
    res.acceptsGzip=/\bgzip\b/i.test(String(req.headers['accept-encoding']||''));
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try{
      const configuredHosts=(process.env.AI_FRAME_ALLOWED_HOSTS||'').split(',').map(value=>value.trim()).filter(Boolean);
      const allowedHosts=[`127.0.0.1:${address.port}`,`localhost:${address.port}`,...configuredHosts];
      if(allowDevOrigin)allowedHosts.push('127.0.0.1:4317','localhost:4317');
      if(!allowedHosts.includes(req.headers.host))throw bad('拒绝非本机请求',403);
      const url=new URL(req.url,'http://127.0.0.1');
      const pathname=decodeURIComponent(url.pathname);
      if(pathname.startsWith('/api/')||!['GET','HEAD'].includes(req.method)){
        const configuredOrigins=(process.env.AI_FRAME_ALLOWED_ORIGINS||'').split(',').map(value=>value.trim()).filter(Boolean);
        const origins=[...allowedHosts.map(h=>`http://${h}`),...configuredOrigins];
        if(req.headers['x-local-client']!=='aiframe'||(req.headers.origin&&!origins.includes(req.headers.origin))||req.headers['sec-fetch-site']==='cross-site')throw bad('请求来源验证失败，请从工作台操作',403);
      }
      if(pathname==='/api/admin/auth/status'&&req.method==='GET'){
        if(!adminAuth)throw Object.assign(new Error('管理员尚未配置，请联系系统维护人员。'),{code:'ADMIN_NOT_CONFIGURED',status:503});
        return json(res,200,adminAuth.status(req));
      }
      if(pathname==='/api/admin/auth/login'&&req.method==='POST'){
        if(!adminAuth)throw Object.assign(new Error('管理员尚未配置，请联系系统维护人员。'),{code:'ADMIN_NOT_CONFIGURED',status:503});
        return json(res,200,await adminAuth.login(await body(req,8192),res));
      }
      if(pathname==='/api/admin/auth/logout'&&req.method==='POST'){
        if(!adminAuth)throw Object.assign(new Error('管理员尚未配置，请联系系统维护人员。'),{code:'ADMIN_NOT_CONFIGURED',status:503});
        await body(req,8192);return json(res,200,adminAuth.logout(req,res));
      }
      if(pathname.startsWith('/api/admin/')){
        if(!adminAuth)throw Object.assign(new Error('管理员尚未配置，请联系系统维护人员。'),{code:'ADMIN_NOT_CONFIGURED',status:503});
        adminAuth.require(req);
        if(pathname==='/api/admin/projects'&&req.method==='GET')return json(res,200,await workspaces.adminList());
        if(pathname==='/api/admin/projects'&&req.method==='DELETE'){
          const input=await body(req,8192);
          if(input?.confirm!==true)throw Object.assign(new Error('删除项目必须明确确认。'),{code:'ADMIN_CONFIRMATION_REQUIRED',status:409});
          return json(res,200,await workspaces.adminDeleteProject({accountRef:input.accountRef,projectId:input.projectId}));
        }
        if(pathname==='/api/admin/cleanup'&&req.method==='POST'){
          const input=await body(req,8192);
          if(input?.confirm!==true||input?.scope!=='media-analysis')throw Object.assign(new Error('全局清理必须确认媒体与分析数据范围。'),{code:'ADMIN_CONFIRMATION_REQUIRED',status:409});
          return json(res,200,{scope:input.scope,result:await workspaces.adminCleanup()});
        }
        throw bad('找不到管理员请求',404);
      }
      if(pathname==='/api/auth/status'&&req.method==='GET')return json(res,200,await sessions.status(req,res,accountKey));
      if(pathname==='/api/auth/login'&&req.method==='POST')return json(res,200,await sessions.login(await body(req,8192),res,accountKey));
      if(pathname==='/api/auth/logout'&&req.method==='POST'){await body(req,8192);return json(res,200,await sessions.logout(req,res));}
      let service,config,dataDir;
      if(pathname.startsWith('/api/')||pathname.startsWith('/media/')||pathname.startsWith('/media-thumb/')){
        const mediaRequest = pathname.startsWith('/media/') || pathname.startsWith('/media-thumb/');
        const authorization=await sessions.require(req,res,mediaRequest);
        const key=accountKey(authorization.user.id);
        if(mediaRequest&&(url.searchParams.get('account')!==key||url.searchParams.getAll('account').length!==1))throw bad('媒体不属于当前账号，请重新打开作品',404);
        if(!['GET','HEAD'].includes(req.method))await body(req,pathname.startsWith('/api/auth/')?8192:BODY_LIMIT);
        const workspace=await workspaces.get(authorization.user);
        authorization.assert();
        res.accountKey=key;
        ({service,config,dataDir}=workspace);
        if(pathname==='/api/auth/legacy'){
          if(req.method==='GET')return json(res,200,await workspaces.legacyStatus(authorization.user));
          if(req.method==='POST')return json(res,200,await workspaces.legacyImport(authorization.user,await body(req)));
        }
      }
      if(pathname==='/api/state'&&req.method==='GET')return json(res,200,{projects:await service.list(),config:config.public()});
      if(pathname==='/api/history'&&req.method==='GET')return json(res,200,{records:await service.history()});
      if(pathname==='/api/ledger'&&req.method==='GET')return json(res,200,{records:await service.ledger()});
      if(pathname==='/api/board-templates'&&req.method==='GET')return json(res,200,{defaultTemplateId:DEFAULT_BOARD_TEMPLATE_ID,templates:BOARD_TEMPLATES.map(({id,name,description,shotCapacity,lookCapacity,shotColumns,shotRows})=>({id,name,description,shotCapacity,lookCapacity,shotColumns,shotRows}))});
      if(pathname==='/api/config'){
        if(req.method==='GET')return json(res,200,config.public());
        if(req.method==='POST')return json(res,200,await config.update(await body(req)));
      }
      if(pathname==='/api/demo'&&req.method==='POST')return json(res,200,await service.demo());
      if(pathname==='/api/projects'&&req.method==='POST')return json(res,200,await service.create(await body(req)));
      const episodeAction=/^\/api\/projects\/([a-zA-Z0-9_-]+)\/episodes\/(episode-\d+|unassigned)\/generate-storyboards$/.exec(pathname);
      if(episodeAction&&req.method==='POST')return json(res,200,await service.generateEpisodeStoryboards(episodeAction[1],episodeAction[2],await body(req)));
      const match=/^\/api\/projects\/([a-zA-Z0-9_-]+)(?:\/(.*))?$/.exec(pathname);
      if(match){
        const id=match[1],tail=match[2];let result;
        if(!tail&&req.method==='GET')result=await service.get(id);
        else if(!tail&&req.method==='DELETE')result=await service.remove(id,await body(req));
        else if(!tail&&req.method==='PATCH')result=await service.update(id,await body(req));
        else if(tail==='cleanup-videos'&&req.method==='POST')result=await service.cleanupVideos(id,await body(req));
        else if(tail==='export'&&req.method==='POST'){await body(req);result=await service.exportProject(id);}
        else if(tail==='reset-duration'&&req.method==='POST')result=await service.resetDuration(id,await body(req));
        else if(tail==='batch'&&req.method==='POST')result=await service.batchAction(id,await body(req));
        else if(tail==='analyze'&&req.method==='POST'){await body(req);result=await service.analyze(id);}
        else if(tail==='analyze-append'&&req.method==='POST'){await body(req);result=await service.analyzeAppend(id);}
        else if(tail==='scenes'&&req.method==='POST')result=await service.createScene(id,await body(req));
        else if(tail==='looks'&&req.method==='POST')result=await service.createLook(id,await body(req));
        else if(tail==='look-assets'&&req.method==='GET')result=await service.lookAssets(id,url.searchParams.get('characterId'));
        else if(tail==='assets'&&req.method==='POST')result=await service.createAsset(id,await body(req));
        else {
          const action=/^(characters|assets|scenes|looks|shots|segments|jobs)\/([a-zA-Z0-9_-]+)(?:\/([a-z-]+))?$/.exec(tail||'');
          if(action){
            const [,group,target,verb]=action;
            if(req.method==='PATCH'&&!verb){
              const payload=await body(req);
              if(group==='characters')result=await service.updateCharacter(id,target,payload);
              if(group==='assets')result=await service.updateAsset(id,target,payload);
              if(group==='scenes')result=await service.updateScene(id,target,payload);
              if(group==='looks')result=await service.updateLook(id,target,payload);
              if(group==='shots')result=await service.updateShot(id,target,payload);
              if(group==='segments')result=await service.updateSegment(id,target,payload);
            }else if(req.method==='POST'&&verb){
              const payload=await body(req);
              if(group==='characters'&&['generate','approve','upload'].includes(verb))result=await service.characterAction(id,target,verb,payload);
              if(group==='assets'&&['generate','approve','upload'].includes(verb))result=await service.assetAction(id,target,verb,payload);
              if(group==='scenes'&&['generate','approve','upload'].includes(verb))result=await service.sceneAction(id,target,verb,payload);
              if(group==='looks'&&['generate','approve','upload'].includes(verb))result=await service.lookAction(id,target,verb,payload);
              if(group==='looks'&&verb==='reuse')result=await service.reuseLook(id,target,payload);
              if(group==='shots'&&['generate','approve','upload','video'].includes(verb))result=await service.shotAction(id,target,verb,payload);
              if(group==='segments'&&['approve','generate-images','generate-videos','export'].includes(verb))result=await service.segmentAction(id,target,verb,payload);
              if(group==='segments'&&verb==='preview')result=await service.previewSegment(id,target,payload);
              if(group==='jobs'&&verb==='pause')result=await service.pauseAnalysis(id,target);
              if(group==='jobs'&&verb==='resume')result=await service.resumeJob(id,target);
              if(group==='jobs'&&verb==='retry-analysis')result=await service.retryAnalysis(id,target,payload);
            }
          }
        }
        if(result!==undefined)return json(res,200,result);
      }
      if(['GET','HEAD'].includes(req.method)){
        if(pathname.startsWith('/media/'))return await sendFile(req,res,path.join(dataDir,'media'),pathname.slice(7),true);
        if(pathname.startsWith('/media-thumb/')) {
          const match = /^\/media-thumb\/([A-Za-z0-9_-]{1,100})\/(.+)$/.exec(pathname);
          if (!match) throw bad('找不到文件', 404);
          return await sendThumbnail(req, res, path.join(dataDir, 'media'), match[1], match[2]);
        }
        if(pathname.startsWith('/downloads/')&&downloadsDir)return await sendFile(req,res,downloadsDir,pathname.slice('/downloads/'.length),false,true);
        if(pathname==='/admin') { res.writeHead(301,{Location:`${publicBasePath}/admin/`}); return res.end(); }
        if(pathname==='/admin/'||pathname==='/admin/index.html')return await sendFile(req,res,adminDir,'index.html');
        if(pathname.startsWith('/admin/'))return await sendFile(req,res,adminDir,pathname.slice('/admin/'.length));
        if(pathname==='/'||pathname==='/index.html')return await sendFile(req,res,distDir,'index.html');
        if(pathname.startsWith('/assets/'))return await sendFile(req,res,distDir,pathname.slice(1));
      }
      throw bad('找不到请求的资源',404);
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      const status=Number.isInteger(error.status)?error.status:500;
      const safe=(status<500||error.code==='AUTH_UNAVAILABLE')&&typeof error.code==='string';
      json(res,status,{error:safe?error.message:'操作未完成，请检查配置与任务状态后重试',code:safe?error.code:'INTERNAL_ERROR'});
    }
  });
  server.requestTimeout=120000;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  address=server.address();
  return {server,url:`http://127.0.0.1:${address.port}`,close:()=>new Promise((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());})};
}

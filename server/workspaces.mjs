import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink} from 'node:fs/promises';
import {createConfig} from './config.mjs';
import {createProviders} from './providers.mjs';
import {createService} from './service.mjs';
import {migrateSceneWorkflow} from './domain.mjs';
import {DEFAULT_BOARD_TEMPLATE_ID, getBoardTemplate} from './board-templates.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACCOUNT_KEY=/^[a-f0-9]{64}$/;
const ASSET_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.webp','.mp4','.json','.csv','.txt']);
const CLAIM_FILE='legacy-import.json';
const MEDIA_CLAIM='.legacy-import.json';
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
function fail(message,code,status=409){throw Object.assign(new Error(message),{code,status});}
function accountId(user){return accountKey(user?.id);}
export function accountKey(userId){
  if(!((typeof userId==='string'&&userId.trim()&&userId.length<=512)||(Number.isSafeInteger(userId)&&userId>0)))fail('请先登录有效账号','AUTH_REQUIRED',401);
  return createHash('sha256').update(String(userId)).digest('hex');
}
async function exists(target){try{return await lstat(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function safePath(root,target,{directory=false,optional=false}={}){
  const relative=path.relative(root,target);
  if(relative.startsWith('..')||path.isAbsolute(relative))fail('数据目录包含不安全路径','UNSAFE_DATA_PATH');
  let current=root;
  for(const part of relative?relative.split(path.sep):[]){
    current=path.join(current,part);const stat=await exists(current);
    if(!stat){if(optional&&current===target)return null;fail('数据目录不存在','UNSAFE_DATA_PATH');}
    if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||!samePath(await realpath(current),current))fail('数据目录包含链接，无法安全打开','UNSAFE_DATA_PATH');
    if(current!==target&&!stat.isDirectory())fail('数据目录格式无效','UNSAFE_DATA_PATH');
  }
  const stat=await lstat(target);
  if(stat.isSymbolicLink()||!samePath(await realpath(target),target)||(directory?!stat.isDirectory():!stat.isFile()))fail('数据目录包含链接或类型无效','UNSAFE_DATA_PATH');
  return stat;
}
async function safeDirectory(root,target){
  const relative=path.relative(root,target);
  if(relative.startsWith('..')||path.isAbsolute(relative))fail('数据目录超出允许范围','UNSAFE_DATA_PATH');
  let current=root;
  for(const part of relative?relative.split(path.sep):[]){current=path.join(current,part);try{await mkdir(current);}catch(error){if(error.code!=='EEXIST')throw error;}await safePath(root,current,{directory:true});}
  return target;
}
async function writeAtomic(root,target,value,{exclusive=false}={}){
  await safePath(root,path.dirname(target),{directory:true});
  if(await exists(target))await safePath(root,target);
  const temp=path.join(path.dirname(target),`.${path.basename(target)}-${randomUUID()}.tmp`);
  let handle;
  try{
    handle=await open(temp,'wx',0o600);await handle.writeFile(JSON.stringify(value,null,2),'utf8');await handle.sync();await handle.close();handle=null;
    // Hard-link publication is atomic and, unlike rename, cannot replace a claim.
    if(exclusive)await link(temp,target);else await rename(temp,target);
  }finally{if(handle)await handle.close();await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function readJson(root,target,maxBytes=8*1024*1024){
  const stat=await safePath(root,target);
  if(stat.size>maxBytes||stat.nlink>1)fail('本地文件不符合安全读取要求','UNSAFE_DATA_PATH');
  return JSON.parse(await readFile(target,'utf8'));
}

async function measureTree(root, target) {
  const result = { files: 0, bytes: 0 };
  const walk = async directory => {
    const stat = await safePath(root, directory, { directory: true });
    if (stat.isSymbolicLink()) fail('数据目录包含链接，无法安全统计', 'UNSAFE_DATA_PATH');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const fileStat = await safePath(root, file);
        result.files += 1;
        result.bytes += fileStat.size;
      } else fail('数据目录包含不支持的文件类型', 'UNSAFE_DATA_PATH');
    }
  };
  if (await exists(target)) await walk(target);
  return result;
}

function projectSummary(project, id, accountRef) {
  const jobs = Array.isArray(project?.jobs) ? project.jobs : [];
  const segments = Array.isArray(project?.segments) ? project.segments : [];
  const shots = segments.reduce((total, segment) => total + (Array.isArray(segment?.shots) ? segment.shots.length : 0), 0);
  return {
    id,
    accountRef,
    title: typeof project?.title === 'string' && project.title.trim() ? project.title.trim() : '未命名项目',
    createdAt: typeof project?.createdAt === 'string' ? project.createdAt : null,
    updatedAt: typeof project?.updatedAt === 'string' ? project.updatedAt : null,
    segmentCount: segments.length,
    characterCount: Array.isArray(project?.characters) ? project.characters.length : 0,
    shotCount: shots,
    activeTaskCount: jobs.filter(job => ['queued', 'running', 'unknown'].includes(job?.status)).length,
  };
}

function resetDerivedProjectData(project) {
  const keep = ['id', 'title', 'novel', 'style', 'visualStyle', 'sourceType', 'narrativeMode', 'aspectRatio', 'duration', 'durationMode', 'generationMode', 'workflowVersion', 'createdAt'];
  const clean = Object.fromEntries(keep.filter(key => Object.hasOwn(project, key)).map(key => [key, project[key]]));
  clean.characters = [];
  clean.scenes = [];
  clean.looks = [];
  clean.segments = [];
  clean.jobs = [];
  clean.exports = [];
  clean.projectExports = [];
  clean.exportHistory = [];
  clean.mediaHistory = [];
  clean.updatedAt = new Date().toISOString();
  clean.cloudCleanupAt = clean.updatedAt;
  return clean;
}
function validProject(project,id){
  if(!project||project.id!==id||!Array.isArray(project.jobs)||!Array.isArray(project.segments)||!Array.isArray(project.characters)||!Array.isArray(project.exports))return false;
  if(project.jobs.some(job=>!job||typeof job!=='object'||Array.isArray(job)))return false;
  try{
    const copy=structuredClone(project);
    for(const segment of copy.segments){if(!segment||!Array.isArray(segment.shots))return false;getBoardTemplate(segment.boardTemplateId??DEFAULT_BOARD_TEMPLATE_ID);}
    migrateSceneWorkflow(copy);
    return true;
  }catch{return false;}
}
async function legacyProjects(root){
  const projects=[];
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(!entry.name.endsWith('.json'))continue;const id=entry.name.slice(0,-5);if(!UUID.test(id))continue;
    if(entry.isSymbolicLink())fail('旧版作品包含链接，无法安全导入','UNSAFE_DATA_PATH');
    if(!entry.isFile())continue;
    let project;try{project=await readJson(root,path.join(root,entry.name));}catch(error){if(error.code==='UNSAFE_DATA_PATH')throw error;if(error instanceof SyntaxError)continue;throw error;}
    if(validProject(project,id))projects.push(project);
  }
  return projects.sort((a,b)=>a.id.localeCompare(b.id));
}
async function copyAssets(root,source,destination){
  await safePath(root,source,{directory:true});await safeDirectory(root,destination);
  for(const entry of await readdir(source,{withFileTypes:true})){
    const from=path.join(source,entry.name),to=path.join(destination,entry.name);
    if(entry.isSymbolicLink())fail('旧版媒体包含链接，无法安全导入','UNSAFE_DATA_PATH');
    if(entry.name.startsWith('.')||entry.name.toLowerCase().startsWith('credentials'))continue;
    if(entry.isDirectory()){await copyAssets(root,from,to);continue;}
    if(!entry.isFile()||!ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))continue;
    const stat=await safePath(root,from);if(stat.nlink>1)fail('旧版媒体包含共享文件链接','UNSAFE_DATA_PATH');
    await copyFile(from,to,constants.COPYFILE_EXCL);
  }
}

export async function createWorkspaces({dataDir,outputRoot=null,loadCredentials,saveCredentials,configEnv={},ffmpegAvailable=false,createServiceImpl=createService,createProvidersImpl=createProviders}={}){
  if(typeof dataDir!=='string'||!dataDir)fail('数据目录无效','INVALID_DATA_DIR',500);
  const requested=path.resolve(dataDir);await mkdir(requested,{recursive:true});
  if((await lstat(requested)).isSymbolicLink())fail('数据目录不能是链接','UNSAFE_DATA_PATH');
  const root=await realpath(requested);
  const entries=new Map();let closed=false,closing,legacyQueue=Promise.resolve();
  function ready(){if(closed)fail('工作台正在关闭','CLOSED',503);}
  function enqueue(record,operation){const result=record.queue.then(operation);record.queue=result.catch(()=>{});return result;}
  function legacyExclusive(operation){const result=legacyQueue.then(operation);legacyQueue=result.catch(()=>{});return result;}
  async function validateSavedFiles(directory){
    await safePath(root,directory,{directory:true});
    for(const entry of await readdir(directory,{withFileTypes:true})){
      if(!/^[A-Za-z0-9_-]+[.]json$/.test(entry.name))continue;
      const stat=await safePath(root,path.join(directory,entry.name));
      if(stat.nlink>1)fail('账号数据包含共享文件链接，无法安全打开','UNSAFE_DATA_PATH');
    }
  }
  async function startService(record){
    await validateSavedFiles(record.directory);
    await safePath(root,path.join(record.directory,'media'),{directory:true});
    const receipts=path.join(record.directory,'provider-receipts');await safeDirectory(root,receipts);await validateSavedFiles(receipts);
    return createServiceImpl({dataDir:record.directory,providers:record.providers});
  }
  async function openWorkspace(key){
    const directory=path.join(root,'accounts',key);await safeDirectory(root,directory);await safeDirectory(root,path.join(directory,'media'));
    await validateSavedFiles(directory);
    const config=await createConfig({env:configEnv,ffmpegAvailable,load:loadCredentials?async()=>await loadCredentials(key)??{}:undefined,save:saveCredentials?settings=>saveCredentials(key,settings):undefined});
    const accountOutputRoot=typeof outputRoot==='string'&&outputRoot.trim()?path.join(path.resolve(outputRoot),key):null;
    const providers=await createProvidersImpl({getSettings:config.settings,mediaRoot:path.join(directory,'media'),outputRoot:accountOutputRoot});
    const record={queue:Promise.resolve(),current:null,providers,directory,config};record.current=await startService(record);
    // A stable facade keeps existing HTTP requests bound to this account while
    // an explicit import temporarily reloads its underlying service.
    const methods=new Map(),methodNames=new Set(Object.keys(record.current).filter(name=>typeof record.current[name]==='function'));
    const service=new Proxy({}, {get(_target,name){
      if(name==='then')return undefined;
      if(!methodNames.has(name))return undefined;
      if(!methods.has(name))methods.set(name,(...args)=>enqueue(record,async()=>{ready();if(!record.current)fail('工作区暂时无法打开，请重试导入或重启','WORKSPACE_UNAVAILABLE',503);return record.current[name](...args);}));
      return methods.get(name);
    }});
    record.workspace={service,config,dataDir:directory,accountKey:key};return record;
  }
  function entry(user){
    ready();const key=accountId(user);
    if(!entries.has(key)){const pending=openWorkspace(key);entries.set(key,pending);pending.catch(()=>{if(entries.get(key)===pending)entries.delete(key);});}
    return entries.get(key);
  }
  async function accountKeys() {
    const accountsRoot = path.join(root, 'accounts');
    await safeDirectory(root, accountsRoot);
    const keys = [];
    for (const item of await readdir(accountsRoot, { withFileTypes: true })) {
      if (!ACCOUNT_KEY.test(item.name)) continue;
      const directory = path.join(accountsRoot, item.name);
      await safePath(root, directory, { directory: true });
      keys.push(item.name);
    }
    return keys.sort();
  }
  async function resolveAccountRef(ref) {
    if (typeof ref !== 'string' || !/^[a-f0-9]{12,64}$/i.test(ref)) fail('账号标识无效', 'ADMIN_INPUT_INVALID', 400);
    const matches = (await accountKeys()).filter(key => key.startsWith(ref.toLowerCase()));
    if (matches.length !== 1) fail(matches.length ? '账号标识不唯一，请刷新管理员页面' : '找不到该账号', 'ADMIN_ACCOUNT_NOT_FOUND', 404);
    return matches[0];
  }
  async function projectFiles(directory, id) {
    if (!UUID.test(id)) fail('项目标识无效', 'ADMIN_INPUT_INVALID', 400);
    const projectFile = path.join(directory, `${id}.json`);
    const mediaDirectory = path.join(directory, 'media', id);
    const hasProject = await exists(projectFile);
    const hasMedia = await exists(mediaDirectory);
    if (hasProject) await safePath(root, projectFile);
    if (hasMedia) await safePath(root, mediaDirectory, { directory: true });
    return { projectFile, mediaDirectory, hasProject: Boolean(hasProject), hasMedia: Boolean(hasMedia) };
  }
  async function removeProjectReceipts(directory, id) {
    const receiptRoot = path.join(directory, 'provider-receipts');
    if (!await exists(receiptRoot)) return;
    await safePath(root, receiptRoot, { directory: true });
    const removeMatching = async target => {
      for (const item of await readdir(target, { withFileTypes: true })) {
        const file = path.join(target, item.name);
        if (item.isDirectory()) await removeMatching(file);
        else if (item.isFile() && item.name.startsWith(`${id}-`)) { await safePath(root, file); await rm(file, { force: true }); }
        else if (!item.isDirectory() && !item.isFile()) fail('供应商回执目录包含不支持的文件类型', 'UNSAFE_DATA_PATH');
      }
    };
    await removeMatching(receiptRoot);
  }
  async function removeProjectFiles(directory, id) {
    const targets = await projectFiles(directory, id);
    if (!targets.hasProject && !targets.hasMedia) fail('找不到该项目', 'ADMIN_PROJECT_NOT_FOUND', 404);
    if (targets.hasProject) await rm(targets.projectFile, { force: true });
    if (targets.hasMedia) await rm(targets.mediaDirectory, { recursive: true, force: true });
    await removeProjectReceipts(directory, id);
  }
  async function readAdminProject(directory, accountRef, id) {
    const file = path.join(directory, `${id}.json`);
    try { return projectSummary(await readJson(root, file), id, accountRef); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      return { id, accountRef, title: '项目文件无法读取', createdAt: null, updatedAt: null, segmentCount: 0, characterCount: 0, shotCount: 0, activeTaskCount: 0, corrupt: true };
    }
  }
  async function adminList() {
    ready();
    const accounts = [];
    let totalProjects = 0, mediaBytes = 0, mediaFiles = 0, analysisBytes = 0, analysisFiles = 0;
    for (const key of await accountKeys()) {
      const directory = path.join(root, 'accounts', key);
      const mediaRoot = path.join(directory, 'media');
      const receiptRoot = path.join(directory, 'provider-receipts');
      const media = await measureTree(root, mediaRoot);
      const analysis = await measureTree(root, path.join(receiptRoot, 'analysis'));
      mediaBytes += media.bytes; mediaFiles += media.files; analysisBytes += analysis.bytes; analysisFiles += analysis.files;
      const projects = [];
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (!item.isFile() || !UUID.test(item.name.slice(0, -5)) || !item.name.endsWith('.json')) continue;
        const summary = await readAdminProject(directory, key.slice(0, 16), item.name.slice(0, -5));
        if (summary) projects.push(summary);
      }
      projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      totalProjects += projects.length;
      accounts.push({ accountRef: key.slice(0, 16), projectCount: projects.length, mediaBytes: media.bytes, mediaFiles: media.files, analysisBytes: analysis.bytes, analysisFiles: analysis.files, projects });
    }
    return { accounts, totals: { accounts: accounts.length, projects: totalProjects, mediaBytes, mediaFiles, analysisBytes, analysisFiles } };
  }
  async function adminDeleteProject({ accountRef, projectId }) {
    ready();
    const key = await resolveAccountRef(accountRef);
    if (!UUID.test(projectId || '')) fail('项目标识无效', 'ADMIN_INPUT_INVALID', 400);
    const directory = path.join(root, 'accounts', key);
    if (entries.has(key)) {
      const record = await entries.get(key);
      return enqueue(record, async () => {
        if (!record.current) fail('账号工作区暂时不可用', 'WORKSPACE_UNAVAILABLE', 503);
        const result = await record.current.remove(projectId, { force: true });
        await removeProjectReceipts(directory, projectId);
        return { ...result, accountRef: key.slice(0, 16) };
      });
    }
    await removeProjectFiles(directory, projectId);
    return { id: projectId, accountRef: key.slice(0, 16) };
  }
  async function cleanAccount(directory) {
    await safePath(root, directory, { directory: true });
    const mediaRoot = path.join(directory, 'media');
    const receiptRoot = path.join(directory, 'provider-receipts');
    if (await exists(mediaRoot)) { await safePath(root, mediaRoot, { directory: true }); await rm(mediaRoot, { recursive: true, force: true }); }
    if (await exists(receiptRoot)) { await safePath(root, receiptRoot, { directory: true }); await rm(receiptRoot, { recursive: true, force: true }); }
    await safeDirectory(root, mediaRoot);
    await safeDirectory(root, receiptRoot);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (!item.isFile() || !item.name.endsWith('.json') || !UUID.test(item.name.slice(0, -5))) continue;
      const file = path.join(directory, item.name);
      const project = await readJson(root, file);
      await writeAtomic(root, file, resetDerivedProjectData(project));
    }
  }
  async function adminCleanup() {
    ready();
    const keys = await accountKeys();
    const loaded = new Map();
    for (const key of keys) {
      if (!entries.has(key)) continue;
      const record = await entries.get(key);
      loaded.set(key, record);
      await enqueue(record, async () => {
        if (record.current) { await record.current.close(); record.current = null; }
        await cleanAccount(path.join(root, 'accounts', key));
        record.current = await startService(record);
      });
    }
    for (const key of keys) if (!loaded.has(key)) await cleanAccount(path.join(root, 'accounts', key));
    // Legacy root-level media and receipts are not part of an account and can
    // otherwise retain the same generated assets after a workspace cleanup.
    for (const directory of [path.join(root, 'media'), path.join(root, 'provider-receipts')]) {
      if (!await exists(directory)) continue;
      await safePath(root, directory, { directory: true });
      await rm(directory, { recursive: true, force: true });
    }
    return adminList();
  }
  async function claim(){
    const target=path.join(root,CLAIM_FILE);if(!await exists(target))return null;
    let value;try{value=await readJson(root,target,64*1024);}catch(error){if(error.code==='UNSAFE_DATA_PATH')throw error;fail('旧版导入记录损坏，请保留数据并联系维护者','LEGACY_STATE_INVALID');}
    if(value?.version!==1||!UUID.test(value.id)||!/^[a-f0-9]{64}$/.test(value.accountKey)||!['pending','complete'].includes(value.status)||!Array.isArray(value.projects)||value.projects.some(id=>!UUID.test(id))||new Set(value.projects).size!==value.projects.length)fail('旧版导入记录无效，请保留数据并联系维护者','LEGACY_STATE_INVALID');
    return value;
  }
  async function assertIdle(record){
    if(!record.current)return;
    for(const item of await record.current.list()){const project=await record.current.get(item.id);if(project.jobs.some(job=>['queued','running'].includes(job.status)))fail('当前账号还有任务执行中，请等待完成后导入','ACTIVE_JOB');}
  }
  async function checkConflicts(record,projects){
    for(const project of projects)for(const target of [path.join(record.directory,`${project.id}.json`),path.join(record.directory,'media',project.id)])if(await exists(target))fail('当前账号已有同编号作品或媒体，导入不会覆盖原内容','LEGACY_CONFLICT');
  }
  async function prepare(record,key,projects){
    const state={version:1,id:randomUUID(),accountKey:key,status:'pending',projects:projects.map(project=>project.id)};
    const stage=path.join(record.directory,`.legacy-import-${state.id}`);await safeDirectory(root,stage);
    try{
      await safeDirectory(root,path.join(stage,'media'));
      for(const original of projects){
        const project=structuredClone(original);
        for(const job of project.jobs)if(['queued','running','unknown'].includes(job.status)){job.status=job.submissionStarted?'unknown':'failed';job.error='从旧版本导入，任务未自动恢复或重新提交；请核实服务商状态后再操作';job.updatedAt=new Date().toISOString();}
        project.legacyImportId=state.id;
        await writeAtomic(root,path.join(stage,`${project.id}.json`),project,{exclusive:true});
        const source=path.join(root,'media',project.id),target=path.join(stage,'media',project.id);
        if(await exists(source))await copyAssets(root,source,target);else await safeDirectory(root,target);
        await writeAtomic(root,path.join(target,MEDIA_CLAIM),{id:state.id},{exclusive:true});
      }
      await writeAtomic(root,path.join(root,CLAIM_FILE),state,{exclusive:true});
      return state;
    }catch(error){await safePath(root,stage,{directory:true});await rm(stage,{recursive:true,force:true});throw error;}
  }
  async function publish(record,state){
    const stage=path.join(record.directory,`.legacy-import-${state.id}`);
    for(const id of state.projects){
      const target=path.join(record.directory,`${id}.json`),media=path.join(record.directory,'media',id);
      if(await exists(target)){
        const present=await readJson(root,target);
        if(present.legacyImportId!==state.id||present.id!==id)fail('同编号作品已存在，导入不会覆盖','LEGACY_CONFLICT');
        await safePath(root,media,{directory:true});
        const marker=await readJson(root,path.join(media,MEDIA_CLAIM),1024);
        if(marker.id!==state.id)fail('已导入作品的媒体归属不符，请保留数据并检查','LEGACY_STATE_INVALID');
        continue;
      }
      const source=path.join(stage,`${id}.json`);const project=await readJson(root,source);
      if(!validProject(project,id)||project.legacyImportId!==state.id)fail('旧版导入暂存内容无效','LEGACY_STATE_INVALID');
      if(await exists(media)){
        await safePath(root,media,{directory:true});
        let marker;try{marker=await readJson(root,path.join(media,MEDIA_CLAIM),1024);}catch{fail('同编号媒体已存在，导入不会覆盖','LEGACY_CONFLICT');}
        if(marker.id!==state.id)fail('同编号媒体已存在，导入不会覆盖','LEGACY_CONFLICT');
      }else{
        const stagedMedia=path.join(stage,'media',id);await safePath(root,stagedMedia,{directory:true});
        await safePath(root,path.dirname(media),{directory:true});await rename(stagedMedia,media);
      }
      // Exclusive creation prevents replacement if a project appeared during a
      // failed import. The preserved staged copy makes same-account retry safe.
      await writeAtomic(root,target,project,{exclusive:true});
    }
  }
  return {
    async get(user){const record=await entry(user);ready();await safePath(root,record.directory,{directory:true});await safePath(root,path.join(record.directory,'media'),{directory:true});return record.workspace;},
    adminList,
    adminDeleteProject,
    adminCleanup,
    async legacyStatus(user){
      ready();const key=accountId(user);
      return legacyExclusive(async()=>{const state=await claim();if(state)return {available:state.accountKey===key&&state.status==='pending',count:state.accountKey===key&&state.status==='pending'?state.projects.length:0,claimed:true};const count=(await legacyProjects(root)).length;return {available:count>0,count,claimed:false};});
    },
    async legacyImport(user,options){
      ready();const key=accountId(user);if(options?.confirm!==true)fail('请确认把旧版本机作品导入当前账号','CONFIRM_REQUIRED',400);
      return legacyExclusive(async()=>{
        ready();let state=await claim();
        if(state&&state.accountKey!==key)fail('旧版本机作品已经归属其他账号','LEGACY_CLAIMED');
        if(state?.status==='complete')return {imported:0};
        const projects=state?null:await legacyProjects(root);if(projects?.length===0)return {imported:0};
        const record=await entry(user);
        return enqueue(record,async()=>{
          ready();await assertIdle(record);
          if(!state){await checkConflicts(record,projects);state=await prepare(record,key,projects);}
          if(record.current)await record.current.close();record.current=null;
          try{
            await publish(record,state);
            record.current=await startService(record);
            await writeAtomic(root,path.join(root,CLAIM_FILE),{...state,status:'complete'});
            const stage=path.join(record.directory,`.legacy-import-${state.id}`);
            // Staging is private and disposable only after a durable complete claim.
            if(await exists(stage)){await safePath(root,stage,{directory:true});await rm(stage,{recursive:true,force:true});}
            return {imported:state.projects.length};
          }catch(error){
            if(!record.current)try{record.current=await startService(record);}catch{}
            throw error;
          }
        });
      });
    },
    close(){
      if(closing)return closing;closed=true;
      closing=(async()=>{
        await legacyQueue;const loaded=await Promise.allSettled([...entries.values()]);
        const stopped=await Promise.allSettled(loaded.filter(result=>result.status==='fulfilled').map(result=>enqueue(result.value,()=>result.value.current?.close())));
        const failed=stopped.find(result=>result.status==='rejected');if(failed)throw failed.reason;
      })();
      return closing;
    },
  };
}

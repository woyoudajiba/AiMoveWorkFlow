import test from 'node:test';
import assert from 'node:assert/strict';
import {link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProject} from '../server/domain.mjs';
import {createService} from '../server/service.mjs';
import {accountKey, createWorkspaces} from '../server/workspaces.mjs';

const alice={id:'account-alice'},bob={id:'account-bob'};
async function fixture(t,options={}) {
  const dataDir=await mkdtemp(path.join(tmpdir(),'aiframe-accounts-'));
  const workspaces=await createWorkspaces({dataDir,createProvidersImpl:()=>({}),...options});
  t.after(async()=>{await workspaces.close();await rm(dataDir,{recursive:true,force:true});});
  return {dataDir,workspaces};
}
async function legacyProject(dataDir,extra={}) {
  const project={...createProject({title:'旧版本作品',novel:'这是原来的小说。'}),...extra};
  await writeFile(path.join(dataDir,`${project.id}.json`),JSON.stringify(project));
  const media=path.join(dataDir,'media',project.id);await mkdir(media,{recursive:true});
  await writeFile(path.join(media,'poster.png'),'image-fixture');
  return project;
}

test('account workspaces load lazily, deduplicate initialization and isolate projects and media',async t=>{
  const opened=[];
  const {dataDir,workspaces}=await fixture(t,{createServiceImpl:async options=>{opened.push(options.dataDir);return createService(options);}});
  assert.deepEqual(opened,[]);
  await legacyProject(dataDir,{jobs:[{kind:'analyze',status:'queued'}]});
  assert.equal((await workspaces.legacyStatus(alice)).count,1);assert.deepEqual(opened,[]);
  const [a,aAgain,b]=await Promise.all([workspaces.get(alice),workspaces.get(alice),workspaces.get(bob)]);
  assert.strictEqual(a,aAgain);assert.equal(opened.length,2);
  assert.match(a.accountKey,/^[a-f0-9]{64}$/);assert.notEqual(a.accountKey,b.accountKey);
  assert.equal(a.dataDir,path.join(dataDir,'accounts',accountKey(alice.id)));
  const created=await a.service.create({title:'Alice 作品'});
  assert.equal((await a.service.list()).length,1);assert.deepEqual(await b.service.list(),[]);
  await assert.rejects(b.service.get(created.id),e=>e.code==='NOT_FOUND');
  await writeFile(path.join(a.dataDir,'media','alice.png'),'private-media');
  await assert.rejects(readFile(path.join(b.dataDir,'media','alice.png')),e=>e.code==='ENOENT');
});

test('desktop output roots are partitioned by the authenticated account hash',async t=>{
  const outputRoot=await mkdtemp(path.join(tmpdir(),'aiframe-output-root-'));t.after(()=>rm(outputRoot,{recursive:true,force:true}));
  const roots=[];
  const {workspaces}=await fixture(t,{outputRoot,createProvidersImpl:options=>{roots.push(options.outputRoot);return {};}});
  const a=await workspaces.get(alice),b=await workspaces.get(bob);
  assert.equal(roots.length,2);
  assert.equal(roots[0],path.join(outputRoot,a.accountKey));
  assert.equal(roots[1],path.join(outputRoot,b.accountKey));
  assert.notEqual(roots[0],roots[1]);
});

test('each account uses encrypted credential callbacks and never inherits global model keys',async t=>{
  const keys=['DASHSCOPE_API_KEY','QWEN_API_KEY','ALIBABA_CODING_PLAN_API_KEY','GRSAI_API_KEY','MINIMAX_API_KEY','XIONGMAO_API_KEY','XIONGMAO_MINIMAXH3_API_KEY','ARK_API_KEY','TOKEN_PLAN_API_KEY','ALIBABA_TOKEN_PLAN_API_KEY'];
  const original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)process.env[key]='global-secret-fixture';
  t.after(()=>{for(const key of keys)if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];});
  const store=new Map(),loads=[];
  const {workspaces}=await fixture(t,{loadCredentials:async key=>{loads.push(key);return store.get(key)||{};},saveCredentials:async(key,value)=>{store.set(key,value);}});
  const a=await workspaces.get(alice),b=await workspaces.get(bob);
  for(const key of ['llmKey','tokenPlanKey','grsaiKey','minimaxKey','xiongmaoMinimaxH3Key','arkKey']){assert.equal(a.config.settings()[key],'');assert.equal(b.config.settings()[key],'');}
  await a.config.update({llmKey:'alice-only',grsaiKey:'alice-image'});
  assert.equal(store.get(a.accountKey).llmKey,'alice-only');assert.equal(b.config.settings().llmKey,'');
  assert.deepEqual(loads.sort(),[a.accountKey,b.accountKey].sort());
});

test('server mode can explicitly inject its protected model environment',async t=>{
  const {workspaces}=await fixture(t,{configEnv:{DASHSCOPE_API_KEY:'server-text',GRSAI_API_KEY:'server-image',MINIMAX_API_KEY:'server-video',XIONGMAO_MINIMAXH3_API_KEY:'server-xiongmao-video'}});
  const account=await workspaces.get(alice);
  assert.equal(account.config.settings().llmKey,'server-text');
  assert.equal(account.config.settings().grsaiKey,'server-image');
  assert.equal(account.config.settings().minimaxKey,'server-video');
  assert.equal(account.config.settings().xiongmaoMinimaxH3Key,'server-xiongmao-video');
});

test('invalid account IDs cannot become paths and closed workspaces reject operations',async t=>{
  const {workspaces}=await fixture(t);
  for(const id of [undefined,null,'',{},[],NaN])await assert.rejects(workspaces.get({id}),e=>e.code==='AUTH_REQUIRED');
  assert.match(accountKey('../../outside'),/^[a-f0-9]{64}$/);
  const a=await workspaces.get(alice);await workspaces.close();
  await assert.rejects(workspaces.get(alice),e=>e.code==='CLOSED');
  await assert.rejects(a.service.create({title:'after close'}),e=>e.code==='CLOSED');
});

test('legacy import preserves originals and completed media, pauses unfinished jobs, and belongs to one account',async t=>{
  let providerCalls=0;
  const {dataDir,workspaces}=await fixture(t,{createProvidersImpl:()=>({analyze:async()=>{providerCalls++;throw new Error('must not run');},pollVideo:async()=>{providerCalls++;throw new Error('must not poll');}})});
  const old=await legacyProject(dataDir);
  old.jobs=[{id:'queued',kind:'analyze',targetId:old.id,status:'queued',submissionStarted:false},{id:'submitted',kind:'video',targetId:'old-shot',status:'running',submissionStarted:true,providerTaskId:'old-provider'},{id:'done',kind:'image',status:'completed',progress:100}];
  old.exports=[{id:'old-export',videoUrl:`/media/${old.id}/finished.mp4`}];
  await writeFile(path.join(dataDir,`${old.id}.json`),JSON.stringify(old));
  await writeFile(path.join(dataDir,'credentials.enc'),'old-secret');
  await writeFile(path.join(dataDir,'media',old.id,'credentials.enc'),'nested-secret');
  const original=await readFile(path.join(dataDir,`${old.id}.json`),'utf8');
  const a=await workspaces.get(alice);const service=a.service;
  await assert.rejects(workspaces.legacyImport(alice,{}),e=>e.code==='CONFIRM_REQUIRED');
  assert.deepEqual(await workspaces.legacyImport(alice,{confirm:true}),{imported:1});
  assert.strictEqual(a.service,service);
  const imported=await service.get(old.id);assert.equal(imported.jobs[0].status,'failed');assert.equal(imported.jobs[1].status,'unknown');assert.equal(imported.jobs[2].status,'completed');
  assert.match(imported.jobs[0].error,/导入|自动/);assert.equal(providerCalls,0);assert.deepEqual(imported.exports,old.exports);
  assert.equal(await readFile(path.join(dataDir,`${old.id}.json`),'utf8'),original);
  assert.equal(await readFile(path.join(a.dataDir,'media',old.id,'poster.png'),'utf8'),'image-fixture');
  await assert.rejects(readFile(path.join(a.dataDir,'credentials.enc')),e=>e.code==='ENOENT');
  await assert.rejects(readFile(path.join(a.dataDir,'media',old.id,'credentials.enc')),e=>e.code==='ENOENT');
  assert.deepEqual(await workspaces.legacyStatus(bob),{available:false,count:0,claimed:true});
  await assert.rejects(workspaces.legacyImport(bob,{confirm:true}),e=>e.code==='LEGACY_CLAIMED');
  assert.deepEqual(await workspaces.legacyImport(alice,{confirm:true}),{imported:0});
  assert.equal((await service.list()).length,1);
});

test('legacy status counts only validated UUID project files and cannot open unsafe directories',async t=>{
  const {dataDir,workspaces}=await fixture(t);await legacyProject(dataDir);
  await writeFile(path.join(dataDir,'deadbeef.json'),'{}');
  await writeFile(path.join(dataDir,'00000000-0000-4000-8000-000000000000.json'),'{broken');
  assert.equal((await workspaces.legacyStatus(alice)).count,1);
  const outside=await mkdtemp(path.join(tmpdir(),'aiframe-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await mkdir(path.join(dataDir,'accounts'),{recursive:true});
  await symlink(outside,path.join(dataDir,'accounts',accountKey(alice.id)),'junction');
  await assert.rejects(workspaces.get(alice),e=>e.code==='UNSAFE_DATA_PATH');
  assert.deepEqual(await readdir(outside),[]);
});

test('legacy import never overwrites a project with the same ID',async t=>{
  const {dataDir,workspaces}=await fixture(t);const a=await workspaces.get(alice);const existing=await a.service.create({title:'保留账号作品'});
  await legacyProject(dataDir,{id:existing.id,title:'不能覆盖'});
  await assert.rejects(workspaces.legacyImport(alice,{confirm:true}),e=>e.code==='LEGACY_CONFLICT');
  assert.equal((await a.service.get(existing.id)).title,'保留账号作品');
  assert.equal((await workspaces.legacyStatus(bob)).count,1);
});

test('legacy import refuses active work and succeeds after it finishes',async t=>{
  let finish;const running=new Promise(resolve=>{finish=resolve;});
  const {dataDir,workspaces}=await fixture(t,{createProvidersImpl:()=>({analyze:async()=>{await running;throw Object.assign(new Error('fixture done'),{definitive:true});}})});
  t.after(()=>finish());await legacyProject(dataDir);
  const a=await workspaces.get(alice);const active=await a.service.create({title:'活动作品',novel:'正文'});await a.service.analyze(active.id);
  await assert.rejects(workspaces.legacyImport(alice,{confirm:true}),e=>e.code==='ACTIVE_JOB');
  finish();for(let i=0;i<50;i++){if((await a.service.get(active.id)).jobs[0].status==='failed')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.deepEqual(await workspaces.legacyImport(alice,{confirm:true}),{imported:1});
});

test('requests using an existing service facade wait for import reload',async t=>{
  let startReload,finishReload,opens=0;
  const started=new Promise(resolve=>{startReload=resolve;}),reload=new Promise(resolve=>{finishReload=resolve;});
  const {dataDir,workspaces}=await fixture(t,{createServiceImpl:async options=>{if(++opens===2){startReload();await reload;}return createService(options);}});
  t.after(()=>finishReload());const old=await legacyProject(dataDir);const a=await workspaces.get(alice);
  const imported=workspaces.legacyImport(alice,{confirm:true});await started;
  let request;try{request=a.service.list();}finally{finishReload();}
  await imported;assert.deepEqual((await request).map(project=>project.id),[old.id]);
});

test('failed reload keeps the claim private and same-account retry never overwrites imported edits',async t=>{
  let opens=0;
  const {dataDir,workspaces}=await fixture(t,{createServiceImpl:async options=>{if(++opens===2)throw new Error('reload fixture failure');return createService(options);}});
  const old=await legacyProject(dataDir);const a=await workspaces.get(alice);
  await assert.rejects(workspaces.legacyImport(alice,{confirm:true}),/reload fixture failure/);
  assert.deepEqual(await workspaces.legacyStatus(bob),{available:false,count:0,claimed:true});
  assert.deepEqual(await workspaces.legacyStatus(alice),{available:true,count:1,claimed:true});
  await a.service.update(old.id,{title:'导入后人工修改'});
  assert.deepEqual(await workspaces.legacyImport(alice,{confirm:true}),{imported:1});
  assert.equal((await a.service.get(old.id)).title,'导入后人工修改');
  assert.equal((await a.service.list()).length,1);
  assert.equal(JSON.parse(await readFile(path.join(dataDir,`${old.id}.json`),'utf8')).title,'旧版本作品');
});

test('failed initial workspace creation can be retried and closing waits for in-flight initialization',async t=>{
  let loads=0,closed=0;
  const {workspaces}=await fixture(t,{createServiceImpl:async options=>{if(++loads===1)throw new Error('init fixture failure');const service=await createService(options);const close=service.close;service.close=async()=>{closed++;await close();};return service;}});
  await assert.rejects(workspaces.get(alice),/init fixture failure/);
  const a=await workspaces.get(alice);assert.deepEqual(await a.service.list(),[]);
  const pending=workspaces.get(bob);const stopping=workspaces.close();
  await assert.rejects(pending,e=>e.code==='CLOSED');await stopping;assert.equal(closed,2);
});

test('a linked legacy media directory cannot escape and a clean retry remains possible',async t=>{
  const {dataDir,workspaces}=await fixture(t);const old=await legacyProject(dataDir);
  const outside=await mkdtemp(path.join(tmpdir(),'aiframe-outside-media-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await writeFile(path.join(outside,'private.png'),'outside-secret-fixture');
  const linked=path.join(dataDir,'media',old.id,'escape');await symlink(outside,linked,'junction');
  await assert.rejects(workspaces.legacyImport(alice,{confirm:true}),e=>e.code==='UNSAFE_DATA_PATH');
  assert.equal((await workspaces.legacyStatus(bob)).claimed,false);
  assert.equal(await readFile(path.join(outside,'private.png'),'utf8'),'outside-secret-fixture');
  await rm(linked,{force:true,recursive:true});
  assert.deepEqual(await workspaces.legacyImport(alice,{confirm:true}),{imported:1});
  const a=await workspaces.get(alice);await assert.rejects(readFile(path.join(a.dataDir,'media',old.id,'escape','private.png')),e=>e.code==='ENOENT');
});

test('simultaneous legacy import requests assign original works to only one account',async t=>{
  const {dataDir,workspaces}=await fixture(t);await legacyProject(dataDir);
  const results=await Promise.allSettled([workspaces.legacyImport(alice,{confirm:true}),workspaces.legacyImport(bob,{confirm:true})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'LEGACY_CLAIMED');
  const a=await workspaces.get(alice),b=await workspaces.get(bob);assert.equal((await a.service.list()).length+(await b.service.list()).length,1);
});

test('partial import ownership and retry survive a workspaces restart',async t=>{
  let opens=0;
  const {dataDir,workspaces}=await fixture(t,{createServiceImpl:async options=>{if(++opens===2)throw new Error('reload fixture failure');return createService(options);}});
  const old=await legacyProject(dataDir);await assert.rejects(workspaces.legacyImport(alice,{confirm:true}),/reload fixture failure/);await workspaces.close();
  const restarted=await createWorkspaces({dataDir,createProvidersImpl:()=>({})});t.after(()=>restarted.close());
  assert.deepEqual(await restarted.legacyStatus(bob),{available:false,count:0,claimed:true});
  assert.deepEqual(await restarted.legacyImport(alice,{confirm:true}),{imported:1});
  const a=await restarted.get(alice);assert.equal((await a.service.list()).length,1);assert.equal((await a.service.get(old.id)).title,old.title);
  assert.deepEqual(await restarted.legacyStatus(alice),{available:false,count:0,claimed:true});
});

test('saved project hardlinks are rejected before a service can load or recover them',async t=>{
  let opened=0;
  const {dataDir,workspaces}=await fixture(t,{createServiceImpl:async options=>{opened++;return createService(options);}});
  const old=await legacyProject(dataDir);const directory=path.join(dataDir,'accounts',accountKey(alice.id));await mkdir(directory,{recursive:true});
  await link(path.join(dataDir,`${old.id}.json`),path.join(directory,`${old.id}.json`));
  await assert.rejects(workspaces.get(alice),e=>e.code==='UNSAFE_DATA_PATH');assert.equal(opened,0);
});

// Local QA only. Excluded from the package allowlist; never contacts TDL or model providers.
import path from 'node:path';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {createHttpServer} from '../server/http.mjs';
import {createTdlAuth} from '../server/tdl-auth.mjs';
import {createWorkspaces} from '../server/workspaces.mjs';
import {createService} from '../server/service.mjs';

if(!process.argv.includes('--confirm-local-fixture'))throw new Error('QA fixture flag is required.');
const parent=path.resolve('output/auth-qa');await mkdir(parent,{recursive:true});
const dataDir=await mkdtemp(path.join(parent,'run-'));
const controlFile=path.join(dataDir,'control.json');await writeFile(controlFile,JSON.stringify({mode:'ok',advanceMs:0}));
let control={mode:'ok',advanceMs:0},stored=null;const configurations=new Map();
const settings=async()=>{control=JSON.parse(await readFile(controlFile,'utf8'));return control;};
const now=()=>Date.now()+(control.advanceMs||0);
const user=name=>({id:`qa-${name}`,username:name,displayName:name==='alice'?'本地验收·甲':'本地验收·乙',role:'MEMBER',membershipTier:'NORMAL'});
const auth=await createTdlAuth({now,load:async()=>stored,save:async value=>{stored=value;},request:async(url,options)=>{
  await settings();
  if(control.mode==='offline')throw new Error('Local fixture offline');
  if(url.endsWith('/login')){
    if(!['alice','bob'].includes(options.body.username)||options.body.password!=='local-fixture-password')throw Object.assign(new Error('Local fixture invalid login'),{status:401});
    return {token:options.body.username,expiresAt:new Date(now()+3600000).toISOString(),user:user(options.body.username)};
  }
  if(url.endsWith('/logout'))return {ok:true};
  if(control.mode==='revoked')throw Object.assign(new Error('Local fixture revoked'),{status:401});
  return {user:user(options.headers.Authorization.slice(7))};
}});
const originalValidate=auth.validate;auth.validate=async options=>{await settings();return originalValidate(options);};
const legacy=await createService({dataDir,providers:{}});const sample=await legacy.demo();await legacy.update(sample.id,{title:'旧版本本地验收作品'});await legacy.close();
const workspaces=await createWorkspaces({dataDir,loadCredentials:async key=>configurations.get(key)||{},saveCredentials:async(key,value)=>{configurations.set(key,value);},ffmpegAvailable:true,createProvidersImpl:()=>({})});
const app=await createHttpServer({auth,workspaces,distDir:path.resolve('dist'),port:0});
await writeFile(path.join(parent,'current.json'),JSON.stringify({url:app.url,dataDir,controlFile,pid:process.pid},null,2));
console.log(JSON.stringify({url:app.url,dataDir,controlFile,pid:process.pid}));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close().then(()=>workspaces.close()).finally(()=>process.exit(0));});

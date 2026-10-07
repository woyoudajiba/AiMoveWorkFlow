import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHttpServer} from '../server/http.mjs';
import {createTdlAuth} from '../server/tdl-auth.mjs';
import {createLocalClient} from '../agent/client.mjs';

async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'aiframe-auth-http-'));
  const distDir=path.join(dir,'dist');await mkdir(distDir);await writeFile(path.join(distDir,'index.html'),'<html>login</html>');
  let clock=Date.now(),mode='ok',loaded=0;const accounts=new Map();
  const user=name=>({id:`account-${name}`,username:name,displayName:name,role:'MEMBER',membershipTier:'NORMAL'});
  const auth=await createTdlAuth({now:()=>clock,request:async(url,options)=>{
    if(mode==='offline')throw new Error('upstream private detail');
    if(url.endsWith('/login')){if(options.body.password!=='fixture-password')throw Object.assign(new Error('invalid private detail'),{status:401});return {token:options.body.username,expiresAt:new Date(clock+3600000).toISOString(),user:user(options.body.username)};}
    if(url.endsWith('/logout'))return {ok:true};
    if(mode==='disabled')throw Object.assign(new Error('disabled private detail'),{status:403});
    return {user:user(options.headers.Authorization.slice(7))};
  }});
  const workspaces={get:async(u)=>{
    if(!accounts.has(u.id)){
      loaded++;const accountDir=path.join(dir,u.id);await mkdir(path.join(accountDir,'media'),{recursive:true});await writeFile(path.join(accountDir,'media','same.png'),u.username);
      const projects=[];let model='default';
      accounts.set(u.id,{dataDir:accountDir,service:{list:async()=>projects,create:async(input)=>{const p={id:u.id,title:input.title};projects.push(p);return p;}},config:{public:()=>({llmModel:model}),update:async(input)=>{model=input.llmModel;return {llmModel:model};}}});
    }return accounts.get(u.id);
  }};
  const server=await createHttpServer({auth,workspaces,distDir});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const headers={'X-Local-Client':'aiframe','content-type':'application/json'};
  const call=(route,method='GET',body,session)=>fetch(server.url+route,{method,headers:{...headers,...(session?{'X-Studio-Session':session}: {})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=async(name='alice')=>{const r=await call('/api/auth/login','POST',{username:name,password:'fixture-password'});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};};
  return {...server,call,login,loaded:()=>loaded,setMode:value=>{mode=value;clock+=31000;},advance:ms=>clock+=ms};
}

test('login page is public but every data, model, media and Agent route is protected',async t=>{
  const f=await fixture(t);assert.equal((await fetch(f.url)).status,200);
  for(const route of ['/api/state','/api/config','/api/board-templates','/api/projects/x','/api/auth/legacy'])assert.equal((await f.call(route)).status,401,route);
  assert.equal((await fetch(f.url+'/media/same.png')).status,401);
  assert.equal((await f.call('/api/demo','POST',{})).status,401);
  assert.equal((await f.call('/api/auth/status')).status,200);assert.equal(f.loaded(),0);
  await assert.rejects(createLocalClient({baseUrl:f.url}).request('/api/state'),e=>e.code==='AUTH_REQUIRED');
});

test('account switch isolates API and media and invalidates bound Agent and old browser requests',async t=>{
  const f=await fixture(t),a=await f.login();
  assert.equal(a.user.username,'alice');assert.ok(!('token' in a));
  const agent=createLocalClient({baseUrl:f.url});await agent.request('/api/state');
  assert.equal((await f.call('/api/projects','POST',{title:'Alice story'},a.sessionId)).status,200);
  await f.call('/api/config','POST',{llmModel:'alice-model'},a.sessionId);
  let media=await fetch(f.url+'/media/same.png?account='+a.accountKey,{headers:{Cookie:a.cookie}});assert.equal(await media.text(),'alice');assert.equal(media.headers.get('cache-control'),'no-store');
  media=await fetch(f.url+'/media/same.png?account='+a.accountKey,{headers:{'X-Local-Client':'aiframe','X-Studio-Session':a.sessionId}});assert.equal(await media.text(),'alice');
  const wrongAccount=a.accountKey.slice(0,-1)+(a.accountKey.endsWith('0')?'1':'0');
  assert.equal((await fetch(f.url+'/media/same.png?account='+wrongAccount,{headers:{'X-Local-Client':'aiframe','X-Studio-Session':a.sessionId}})).status,404);
  media=await fetch(f.url+'/media%2Fsame.png?account='+a.accountKey,{headers:{Cookie:a.cookie}});assert.equal(media.status,200);assert.equal(media.headers.get('cache-control'),'no-store');
  assert.equal((await f.call('/api/auth/logout','POST',{},a.sessionId)).status,200);
  assert.equal((await fetch(f.url+'/media/same.png?account='+a.accountKey,{headers:{Cookie:a.cookie}})).status,401);
  const b=await f.login('bob');assert.notEqual(a.accountKey,b.accountKey);
  assert.equal((await fetch(f.url+'/media/same.png?account='+a.accountKey,{headers:{Cookie:b.cookie}})).status,404,'old tab URL cannot read new account media through the shared browser cookie');
  assert.equal((await fetch(f.url+'/media/same.png',{headers:{Cookie:b.cookie}})).status,404);
  const state=await (await f.call('/api/state','GET',undefined,b.sessionId)).json();assert.deepEqual(state.projects,[]);assert.equal(state.config.llmModel,'default');
  assert.equal((await f.call('/api/projects','POST',{title:'stale'},a.sessionId)).status,409);
  await assert.rejects(agent.request('/api/projects','POST',{title:'stale agent'}),e=>e.code==='SESSION_CHANGED');
  media=await fetch(f.url+'/media/same.png?account='+b.accountKey,{headers:{Cookie:b.cookie}});assert.equal(await media.text(),'bob');
  await f.call('/api/auth/logout','POST',{},b.sessionId);const again=await f.login();
  const restored=await (await f.call('/api/state','GET',undefined,again.sessionId)).json();assert.equal(restored.projects[0].title,'Alice story');assert.equal(restored.config.llmModel,'alice-model');
});

test('disabled, expired and offline cloud sessions fail closed with safe recoverable messages',async t=>{
  const f=await fixture(t),a=await f.login();
  f.setMode('offline');let r=await f.call('/api/state','GET',undefined,a.sessionId);assert.equal(r.status,503);assert.equal((await r.json()).code,'AUTH_UNAVAILABLE');assert.equal(f.loaded(),0);
  f.setMode('ok');r=await f.call('/api/state','GET',undefined,a.sessionId);assert.equal(r.status,200);
  f.setMode('disabled');r=await f.call('/api/state','GET',undefined,a.sessionId);assert.equal(r.status,403);assert.equal((await r.json()).code,'AUTH_DISABLED');
  f.setMode('ok');const b=await f.login('bob');f.advance(3600001);r=await f.call('/api/state','GET',undefined,b.sessionId);assert.equal(r.status,401);
});

test('auth endpoints enforce origin, field allowlist, body limit and bounded login attempts',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.url+'/api/auth/status')).status,403);
  assert.equal((await fetch(f.url+'/api/auth/status',{headers:{'X-Local-Client':'aiframe',Origin:'https://evil.example'}})).status,403);
  assert.equal((await f.call('/api/auth/login','POST',{username:'alice',password:'fixture-password',baseUrl:'https://evil.example'})).status,400);
  assert.equal((await f.call('/api/auth/login','POST',{username:'alice',password:'x'.repeat(9000)})).status,413);
  for(let i=0;i<4;i++){const r=await f.call('/api/auth/login','POST',{username:'alice',password:'bad'});assert.equal(r.status,401);assert.equal((await r.text()).includes('private detail'),false);}
  assert.equal((await f.call('/api/auth/login','POST',{username:'alice',password:'bad'})).status,429);
  assert.equal(f.loaded(),0);
});

test('logout clears local access even when upstream is unavailable',async t=>{
  const f=await fixture(t),a=await f.login();f.setMode('offline');
  const r=await f.call('/api/auth/logout','POST',{},a.sessionId);assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,remoteRevoked:false});
  assert.equal((await f.call('/api/state','GET',undefined,a.sessionId)).status,401);
});

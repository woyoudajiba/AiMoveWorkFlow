import test from 'node:test';
import assert from 'node:assert/strict';
import {createTdlAuth} from '../server/tdl-auth.mjs';

const BASE='https://wsfile.cn/myladmin';
const NOW=Date.parse('2026-10-02T01:00:00.000Z');
const USER={id:'cm-account-001',username:'演员甲',displayName:'第一位演员',role:'MEMBER',membershipTier:'NORMAL'};
const INPUT={username:' 演员甲 ',password:'password-fixture'};
const session=(overrides={})=>({token:'private-session-fixture',expiresAt:new Date(NOW+3600000).toISOString(),user:{...USER},...overrides});
const upstream=(status)=>Object.assign(new Error('password-fixture private-session-fixture upstream secret'),{status,statusCode:status});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const rejectCode=(code,status)=>error=>error.code===code&&error.status===status&&error.safe===true;

test('login uses the fixed HTTPS TDL contract and exposes only the five public user fields',async()=>{
  const requests=[];
  const auth=await createTdlAuth({now:()=>NOW,request:async(url,options)=>{requests.push({url,options});return session({user:{...USER,password:'hidden-user-fixture',token:'hidden-user-token',isAdmin:true}});}});
  assert.deepEqual(auth.public(),{authenticated:false,user:null,expiresAt:'',rememberAvailable:false,remembered:false});
  const result=await auth.login(INPUT);
  assert.equal(result.authenticated,true);
  assert.deepEqual(result.user,USER);
  assert.equal(requests[0].url,`${BASE}/api/auth/login`);
  assert.deepEqual(requests[0].options.body,{username:'演员甲',password:'password-fixture',clientLabel:'映序'});
  assert.equal(requests[0].options.method,'POST');
  assert.equal(requests[0].options.timeoutMs,15000);
  assert.equal(requests[0].options.maxBytes,65536);
  assert.doesNotMatch(JSON.stringify(result),/password|private-session|hidden-user|isAdmin/);
  result.user.id='changed';
  assert.equal(auth.public().user.id,USER.id);
});

test('input validation rejects malformed or redirected login attempts before any request',async()=>{
  let calls=0;const auth=await createTdlAuth({request:async()=>{calls++;return session();},now:()=>NOW});
  const invalid=[null,[],{}, {...INPUT,username:''},{...INPUT,username:'x'.repeat(65)},{...INPUT,username:'bad\nuser'},
    {...INPUT,password:''},{...INPUT,password:'x'.repeat(121)},{...INPUT,password:42},{...INPUT,remember:'true'},
    {...INPUT,baseUrl:'https://untrusted.example'},{...INPUT,token:'injected'}];
  for(const input of invalid)await assert.rejects(auth.login(input),rejectCode('AUTH_INPUT_INVALID',400));
  await assert.rejects(auth.login({...INPUT,remember:true}),rejectCode('AUTH_INPUT_INVALID',400));
  assert.equal(calls,0);
  await auth.login({username:'a',password:'x'});
  assert.equal(calls,1,'historical TDL login accepts one-character credentials');
});

test('remembered sessions persist token and sanitized user but never passwords',async()=>{
  const writes=[];const auth=await createTdlAuth({request:async()=>session(),now:()=>NOW,load:async()=>null,save:async value=>writes.push(structuredClone(value))});
  await auth.login({...INPUT,remember:true});
  assert.equal(auth.public().rememberAvailable,true);
  assert.equal(auth.public().remembered,true);
  assert.deepEqual(writes.at(-1),session());
  assert.doesNotMatch(JSON.stringify(writes),/password-fixture/);
  await auth.login(INPUT);
  assert.equal(auth.public().remembered,false);
  assert.equal(writes.at(-1),null,'session-only login clears a previous remembered credential');
});

test('server-persisted sessions survive a login without relying on the browser remember checkbox', async () => {
  const writes = [];
  const auth = await createTdlAuth({ now: () => NOW, persistLogin: true, request: async () => session(), save: async value => writes.push(structuredClone(value)) });
  await auth.login({ ...INPUT, remember: false });
  assert.deepEqual(writes.at(-1), session());
});

test('cached credentials remain locked until the first remote validation',async()=>{
  const calls=[];const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async()=>{},request:async(url,options)=>{calls.push({url,options});return {user:USER};}});
  assert.equal(calls.length,0);
  assert.equal(auth.public().authenticated,false);
  assert.equal(auth.public().user,null);
  assert.equal(auth.public().remembered,true);
  assert.deepEqual(await auth.validate(),USER);
  assert.equal(calls[0].url,`${BASE}/api/auth/me`);
  assert.equal(calls[0].options.headers.Authorization,'Bearer private-session-fixture');
  assert.equal(auth.public().authenticated,true);
});

test('validation reuses at most thirty seconds and force rechecks the server',async()=>{
  let time=NOW,calls=0;const auth=await createTdlAuth({now:()=>time,validationTtlMs:999999,load:async()=>session(),save:async()=>{},request:async()=>{calls++;return {user:USER};}});
  await auth.validate();time+=29999;await auth.validate();assert.equal(calls,1);
  time++;await auth.validate();assert.equal(calls,2);
  await auth.validate({force:true});assert.equal(calls,3);
  time-=1000;await auth.validate();assert.equal(calls,4,'clock rollback cannot extend prior verification');
});

test('expiry is checked on every access even inside the validation cache',async()=>{
  let time=NOW,calls=0;const writes=[];
  const auth=await createTdlAuth({now:()=>time,load:async()=>session({expiresAt:new Date(NOW+1000).toISOString()}),save:async value=>writes.push(value),request:async()=>{calls++;return {user:USER};}});
  await auth.validate();time+=1000;
  await assert.rejects(auth.validate(),rejectCode('AUTH_INVALID',401));
  assert.equal(auth.public().authenticated,false);assert.equal(auth.public().user,null);assert.equal(calls,1);
  assert.equal(writes.at(-1),null);
});

test('expired or malformed stored sessions never become authenticated or reach the network',async()=>{
  for(const saved of [session({expiresAt:new Date(NOW).toISOString()}),session({token:'bad\nheader'}),session({user:{...USER,id:'../another-account'}}),{password:'private-password'},null]){
    let calls=0;const auth=await createTdlAuth({now:()=>NOW,load:async()=>saved,save:async()=>{},request:async()=>{calls++;return {user:USER};}});
    assert.equal(auth.public().authenticated,false);
    await assert.rejects(auth.validate(),rejectCode('AUTH_REQUIRED',401));
    assert.equal(calls,0);
  }
});

test('offline validation fails closed but keeps remembered credentials available for a later retry',async()=>{
  let offline=false;const writes=[];
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async value=>writes.push(value),request:async()=>{if(offline)throw upstream(503);return {user:USER};}});
  await auth.validate();offline=true;
  await assert.rejects(auth.validate({force:true}),rejectCode('AUTH_UNAVAILABLE',503));
  assert.equal(auth.public().authenticated,false);assert.equal(auth.public().user,null);assert.equal(auth.public().remembered,true);
  assert.equal(writes.length,0);
  offline=false;await auth.validate();assert.equal(auth.public().authenticated,true);
});

test('rejected and disabled upstream sessions are cleared and errors never expose secrets',async()=>{
  for(const [status,code] of [[401,'AUTH_INVALID'],[403,'AUTH_DISABLED']]){
    const writes=[];const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async value=>writes.push(value),request:async()=>{throw upstream(status);}});
    await assert.rejects(auth.validate(),error=>{assert.ok(rejectCode(code,status)(error));assert.doesNotMatch(JSON.stringify(error)+error.message+error.stack,/private-session|password-fixture|upstream secret/);return true;});
    assert.equal(auth.public().authenticated,false);assert.equal(auth.public().remembered,false);assert.equal(writes.at(-1),null);
    await assert.rejects(auth.validate(),rejectCode('AUTH_REQUIRED',401));
  }
});

test('login and unavailable upstream errors are translated to safe account errors',async()=>{
  for(const [status,code,local] of [[401,'AUTH_INVALID',401],[403,'AUTH_DISABLED',403],[400,'AUTH_INPUT_INVALID',400],[429,'AUTH_UNAVAILABLE',503],[500,'AUTH_UNAVAILABLE',503]]){
    const auth=await createTdlAuth({now:()=>NOW,request:async()=>{throw upstream(status);}});
    await assert.rejects(auth.login(INPUT),error=>{assert.ok(rejectCode(code,local)(error));assert.doesNotMatch(error.message+JSON.stringify(error),/private-session|password-fixture/);return true;});
    assert.equal(auth.public().authenticated,false);
  }
});

test('logout always locks local state and clears persistence even when the service is offline',async()=>{
  let offline=false;const writes=[],calls=[];
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async value=>writes.push(value),request:async(url,options)=>{calls.push({url,options});if(offline)throw upstream(503);return {user:USER};}});
  await auth.validate();offline=true;
  assert.deepEqual(await auth.logout(),{ok:true,remoteRevoked:false});
  assert.equal(auth.public().authenticated,false);assert.equal(auth.public().remembered,false);assert.equal(writes.at(-1),null);
  assert.equal(calls.at(-1).url,`${BASE}/api/auth/logout`);
  assert.equal(calls.at(-1).options.method,'POST');
  assert.equal(calls.at(-1).options.headers.Authorization,'Bearer private-session-fixture');
  await assert.rejects(auth.validate(),rejectCode('AUTH_REQUIRED',401));
});

test('successful logout reports server revocation and does not expose its response',async()=>{
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async()=>{},request:async()=>({ok:true,token:'private-session-fixture'})});
  assert.deepEqual(await auth.logout(),{ok:true,remoteRevoked:true});
});

test('an in-flight login cannot restore a logged-out session',async()=>{
  const pending=deferred(),entered=deferred();const writes=[];
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>null,save:async value=>writes.push(value),request:async()=>{entered.resolve();return pending.promise;}});
  const login=auth.login({...INPUT,remember:true});const rejected=assert.rejects(login,rejectCode('AUTH_REQUIRED',401));
  await entered.promise;await auth.logout();pending.resolve(session());await rejected;
  assert.equal(auth.public().authenticated,false);assert.equal(writes.at(-1),null);
});

test('an in-flight validation cannot restore a logged-out session',async()=>{
  const pending=deferred(),entered=deferred();
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async()=>{},request:async url=>{if(url.endsWith('/logout'))return {ok:true};entered.resolve();return pending.promise;}});
  const validating=auth.validate();const rejected=assert.rejects(validating,rejectCode('AUTH_REQUIRED',401));
  await entered.promise;await auth.logout();pending.resolve({user:USER});await rejected;
  assert.equal(auth.public().authenticated,false);
});

test('parallel current-user checks share one request',async()=>{
  const pending=deferred();let calls=0;
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async()=>{},request:async()=>{calls++;return pending.promise;}});
  const first=auth.validate(),second=auth.validate();pending.resolve({user:USER});
  assert.deepEqual(await Promise.all([first,second]),[USER,USER]);assert.equal(calls,1);
});

test('a late older login cannot replace the newest account',async()=>{
  const old=deferred(),entered=deferred();const nextUser={...USER,id:'cm-account-002',username:'演员乙'};
  const auth=await createTdlAuth({now:()=>NOW,request:async(_url,options)=>{if(options.body.username==='演员甲'){entered.resolve();return old.promise;}return session({user:nextUser});}});
  const first=auth.login(INPUT);const rejected=assert.rejects(first,rejectCode('AUTH_REQUIRED',401));
  await entered.promise;await auth.login({...INPUT,username:'演员乙'});old.resolve(session());await rejected;
  assert.equal(auth.public().user.id,nextUser.id);
});

test('pending secure writes are ordered so logout cannot be overwritten by an earlier login',async()=>{
  const writing=deferred(),written=deferred();let stored=null;
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>null,request:async()=>session(),save:async value=>{if(value){writing.resolve();await written.promise;}stored=value;}});
  const login=auth.login({...INPUT,remember:true});const rejected=assert.rejects(login,rejectCode('AUTH_REQUIRED',401));
  await writing.promise;const logout=auth.logout();assert.equal(auth.public().authenticated,false);written.resolve();
  await rejected;await logout;assert.equal(stored,null);assert.equal(auth.public().authenticated,false);
});

test('persistence failures are sanitized and never make a failed remembered login active',async()=>{
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>null,request:async()=>session(),save:async value=>{if(value)throw new Error('private-session-fixture disk path');}});
  await assert.rejects(auth.login({...INPUT,remember:true}),error=>{assert.ok(rejectCode('AUTH_UNAVAILABLE',503)(error));assert.doesNotMatch(error.message,/private-session|disk path/);return true;});
  assert.equal(auth.public().authenticated,false);
});

test('a partial secure write is erased when remembered login persistence fails',async()=>{
  let stored=null;
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>null,request:async()=>session(),save:async value=>{stored=value;if(value)throw new Error('private-session-fixture partial write');}});
  await assert.rejects(auth.login({...INPUT,remember:true}),rejectCode('AUTH_UNAVAILABLE',503));
  assert.equal(stored,null);assert.equal(auth.public().authenticated,false);
});

test('expiry while current-user verification is in flight does not authenticate the user',async()=>{
  let time=NOW;const pending=deferred(),entered=deferred();
  const auth=await createTdlAuth({now:()=>time,load:async()=>session({expiresAt:new Date(NOW+1000).toISOString()}),save:async()=>{},request:async()=>{entered.resolve();return pending.promise;}});
  const checking=auth.validate();const rejected=assert.rejects(checking,rejectCode('AUTH_INVALID',401));
  await entered.promise;time+=1000;pending.resolve({user:USER});await rejected;assert.equal(auth.public().authenticated,false);
});

test('a rejected old verification cannot clear a newer account session',async()=>{
  const pending=deferred(),entered=deferred();const nextUser={...USER,id:'cm-account-002',username:'演员乙'};
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async()=>{},request:async url=>{if(url.endsWith('/me')){entered.resolve();return pending.promise;}return session({user:nextUser});}});
  const checking=auth.validate();const rejected=assert.rejects(checking,rejectCode('AUTH_REQUIRED',401));
  await entered.promise;await auth.login({...INPUT,username:'演员乙'});pending.reject(upstream(401));await rejected;
  assert.equal(auth.public().user.id,nextUser.id);assert.equal(auth.public().authenticated,true);
});

test('malformed login or mismatched current-user responses never unlock the account',async()=>{
  for(const data of [{},session({token:''}),session({expiresAt:'invalid'}),session({expiresAt:new Date(NOW).toISOString()}),session({user:{...USER,id:'../../data'}})]){
    const auth=await createTdlAuth({now:()=>NOW,request:async()=>data});
    await assert.rejects(auth.login(INPUT),rejectCode('AUTH_UNAVAILABLE',503));assert.equal(auth.public().authenticated,false);
  }
  const auth=await createTdlAuth({now:()=>NOW,load:async()=>session(),save:async()=>{},request:async()=>({user:{...USER,id:'different-account'}})});
  await assert.rejects(auth.validate(),rejectCode('AUTH_INVALID',401));assert.equal(auth.public().authenticated,false);
});

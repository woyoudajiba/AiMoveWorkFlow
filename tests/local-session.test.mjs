import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalSession} from '../server/local-session.mjs';

const response=()=>({headers:{},setHeader(key,value){this.headers[key]=value;}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('an old validation rejection cannot clear a new local account or its cookie',async()=>{
  let user=null,waiting=null;
  const auth={public:()=>({authenticated:!!user,user}),login:async({username})=>{user={id:username};return {user};},logout:async()=>{user=null;return {ok:true};},validate:()=>waiting?waiting.promise:Promise.resolve(user)};
  const local=createLocalSession(auth),res=response(),key=x=>x;
  const a=await local.login({username:'a'},res,key);waiting=deferred();
  const oldResponse=response();const old=local.require({headers:{'x-studio-session':a.sessionId}},oldResponse);
  const rejected=assert.rejects(old,e=>e.code==='SESSION_CHANGED');
  await local.logout({headers:{'x-studio-session':a.sessionId}},res);
  const b=await local.login({username:'b'},res,key);waiting.reject(Object.assign(new Error('old'),{status:401}));waiting=null;await rejected;
  assert.equal(oldResponse.headers['Set-Cookie'],undefined);
  assert.equal((await local.require({headers:{'x-studio-session':b.sessionId}},response())).user.id,'b');
});
test('status polling cannot cancel an in-flight login',async()=>{
  const pending=deferred();let user=null;
  const auth={login:async()=>{await pending.promise;user={id:'a'};return {user};},public:()=>({authenticated:!!user,user})};
  const local=createLocalSession(auth);const login=local.login({},response(),x=>x);
  await assert.rejects(local.status({headers:{}},response(),x=>x),e=>e.code==='AUTH_IN_PROGRESS');
  pending.resolve();assert.equal((await login).authenticated,true);
});

test('the same TDL account can keep two local sessions without sharing logout',async()=>{
  let user=null;
  const auth={
    login:async({username})=>{user={id:`account-${username}`,username};return {user};},
    public:()=>({authenticated:!!user,user}),
    validate:async()=>user,
    logout:async()=>{user=null;return {ok:true};},
  };
  const local=createLocalSession(auth),first=await local.login({username:'alice'},response(),x=>x);
  const second=await local.login({username:'alice'},response(),x=>x);
  assert.notEqual(first.sessionId,second.sessionId);
  await local.logout({'headers':{'x-studio-session':first.sessionId}},response());
  assert.equal((await local.require({'headers':{'x-studio-session':second.sessionId}},response())).user.id,'account-alice');
  await assert.rejects(local.require({'headers':{'x-studio-session':first.sessionId}},response()),e=>e.code==='SESSION_CHANGED');
  const bob=await local.login({username:'bob'},response(),x=>x);
  assert.equal((await local.require({'headers':{'x-studio-session':bob.sessionId}},response())).user.id,'account-bob');
  await assert.rejects(local.require({'headers':{'x-studio-session':second.sessionId}},response()),e=>e.code==='SESSION_CHANGED');
});

test('media requests accept the client session header without a browser cookie',async()=>{
  const user={id:'account-alice',username:'alice'};
  const auth={
    login:async()=>({user}),
    public:()=>({authenticated:true,user}),
    validate:async()=>user,
    logout:async()=>({ok:true}),
  };
  const local=createLocalSession(auth);
  const session=await local.login({username:'alice'},response(),x=>x);
  const authorization=await local.require({headers:{'x-studio-session':session.sessionId}},response(),true);
  assert.equal(authorization.user.id,user.id);
  await local.logout({headers:{'x-studio-session':session.sessionId}},response());
  await assert.rejects(local.require({headers:{'x-studio-session':session.sessionId}},response(),true),error => error.status === 401);
});

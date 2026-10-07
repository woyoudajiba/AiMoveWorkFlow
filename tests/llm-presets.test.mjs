import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {createConfig} from '../server/config.mjs';
import {createHttpServer,authenticatedFetch as fetch} from './helpers/http-fixture.mjs';
import {createProviders} from '../server/providers.mjs';
import {safeError} from '../server/network.mjs';

const models=['qwen3.7-plus','qwen3.6-plus','qwen3.8-max','qwen3.8-flash','deepseek-v4.1-flash','deepseek-v4-pro'];
const codingUrl='https://coding.dashscope.aliyuncs.com/v1/chat/completions';
const tokenUrl='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const project={novel:'夜雨停了，车站空无一人。',duration:30,style:'电影写实',aspectRatio:'9:16'};
const analysisResponse=()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({characters:[],scenes:[{id:'station',name:'空车站',description:'雨后'}],looks:[],segments:[{title:'雨停',summary:'车站空景',duration:30,shots:Array.from({length:9},(_,index)=>({sceneId:'station',scene:'空车站',action:'雨停',camera:'远景',dialogue:'',characterIds:[],duration:index===8?6:3}))}]})}}]});

test('all WorkHelper presets persist, expose independent configuration flags and keep credentials write-only',async()=>{
  let stored;
  const config=await createConfig({env:{DASHSCOPE_API_KEY:'coding-private-fixture'},save:async value=>{stored=value;}});
  assert.deepEqual(config.public().llmModels?.map(model=>model.id),models);
  assert.equal(config.public().codingPlanConfigured,true);
  assert.equal(config.public().tokenPlanConfigured,false);
  assert.equal(config.public().llmConfigured,true);
  for(const model of config.public().llmModels){
    assert.ok(model.label&&model.description&&model.providerLabel);
    assert.equal(model.provider,models.indexOf(model.id)<2?'coding-plan':'token-plan');
    assert.equal(model.configured,model.provider==='coding-plan');
    assert.equal(model.recommended,['qwen3.8-flash','deepseek-v4.1-flash'].includes(model.id));
    assert.equal(model.speed,model.recommended?'fast':'standard');
  }
  await config.update({llmModel:'qwen3.8-flash'});
  assert.equal(config.public().llmConfigured,false);
  await config.update({tokenPlanKey:'token-private-fixture'});
  for(const llmModel of models){
    await config.update({llmModel});
    assert.equal(config.public().llmModel,llmModel);
    assert.equal(config.public().llmConfigured,true);
    assert.equal(stored.llmModel,llmModel);
  }
  await config.update({llmKey:'',tokenPlanKey:''});
  const reloaded=await createConfig({env:{},load:async()=>stored});
  assert.equal(reloaded.settings().llmKey,'coding-private-fixture');
  assert.equal(reloaded.settings().tokenPlanKey,'token-private-fixture');
  assert.equal(reloaded.public().llmModel,'deepseek-v4-pro');
  assert.equal(reloaded.public().llmModels.every(model=>model.configured),true);
  assert.doesNotMatch(JSON.stringify(reloaded.public()),/private-fixture|apiKey|tokenPlanKey|llmKey/);
});

test('environment aliases initialize each credential group without cross-provider fallback',async()=>{
  for(const name of ['DASHSCOPE_API_KEY','QWEN_API_KEY','ALIBABA_CODING_PLAN_API_KEY']){
    const config=await createConfig({env:{[name]:'coding-fixture'}});
    assert.equal(config.public().codingPlanConfigured,true,name);
    await config.update({llmModel:'deepseek-v4-pro'});
    assert.equal(config.public().llmConfigured,false,name);
  }
  for(const name of ['TOKEN_PLAN_API_KEY','ALIBABA_TOKEN_PLAN_API_KEY']){
    const config=await createConfig({env:{[name]:'token-fixture'}});
    assert.equal(config.public().tokenPlanConfigured,true,name);
    assert.equal(config.public().codingPlanConfigured,false,name);
    assert.equal(config.public().llmConfigured,false,name);
    await config.update({llmModel:'deepseek-v4.1-flash'});
    assert.equal(config.public().llmConfigured,true,name);
  }
});

test('model and endpoint validation rejects unknown or redirected routes without changing saved selection',async()=>{
  const config=await createConfig({env:{}});
  for(const patch of [{llmModel:'unlisted-model'},{llmBaseUrl:'https://untrusted.example'},{tokenPlanBaseUrl:'https://untrusted.example'},{tokenPlanKey:'bad\nheader'}]){
    await assert.rejects(config.update(patch),error=>error.code==='INVALID_CONFIG');
    assert.equal(config.public().llmModel,'qwen3.7-plus');
    assert.equal(config.public().tokenPlanConfigured,false);
  }
});

test('each preset sends only its own credential to the fixed WorkHelper provider endpoint',async()=>{
  for(const [index,llmModel] of models.entries()){
    const requests=[];
    const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel,llmKey:'coding-private-fixture',tokenPlanKey:'token-private-fixture',llmBaseUrl:'https://untrusted.example',tokenPlanBaseUrl:'https://untrusted.example'}),requestJson:async(url,options)=>{requests.push({url,options});return analysisResponse();}});
    const result=await provider.analyze(project);
    assert.equal(result.segments.length,1);
    assert.equal(requests.length,1);
    assert.equal(requests[0].url,index<2?codingUrl:tokenUrl);
    assert.equal(requests[0].options.headers.Authorization,index<2?'Bearer coding-private-fixture':'Bearer token-private-fixture');
    assert.equal(requests[0].options.body.model,llmModel);
    assert.deepEqual(requests[0].options.body.response_format,{type:'json_object'});
    assert.doesNotMatch(JSON.stringify(requests[0].options.body),/private-fixture|untrusted/);
  }
});

test('missing selected group fails before a request and cannot reuse the other group key',async()=>{
  for(const llmModel of models){
    let calls=0;const token=models.indexOf(llmModel)>=2;
    const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel,llmKey:token?'coding-fixture':'',tokenPlanKey:token?'':'token-fixture'}),requestJson:async()=>{calls++;return analysisResponse();}});
    await assert.rejects(provider.analyze(project),error=>error.code==='NOT_CONFIGURED'&&error.definitive&&error.message.includes(token?'Token Plan':'Coding Plan'));
    assert.equal(calls,0);
  }
  let calls=0;
  const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel:'unlisted-model',llmKey:'coding-fixture',tokenPlanKey:'token-fixture'}),requestJson:async()=>{calls++;return analysisResponse();}});
  await assert.rejects(provider.analyze(project),error=>error.code==='MODEL_UNSUPPORTED'&&error.definitive);
  assert.equal(calls,0);
});

test('one analysis keeps its chosen model across chunks even if the settings change in flight',async()=>{
  let selected='deepseek-v4.1-flash';const requests=[];
  const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel:selected,llmKey:'coding-fixture',tokenPlanKey:'token-fixture'}),requestJson:async(url,options)=>{requests.push({url,options});selected='qwen3.7-plus';return analysisResponse();}});
  await provider.analyze({...project,novel:'雨'.repeat(18001)});
  assert.equal(requests.length,2);
  assert.ok(requests.every(({url,options})=>url===tokenUrl&&options.body.model==='deepseek-v4.1-flash'&&options.headers.Authorization==='Bearer token-fixture'));
});

test('analysis chunks default to a 600-second request timeout',async()=>{
  const previous=process.env.AIFRAME_ANALYSIS_TIMEOUT_MS;
  delete process.env.AIFRAME_ANALYSIS_TIMEOUT_MS;
  try{
    const requests=[];
    const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel:'qwen3.7-plus',llmKey:'coding-fixture'}),requestJson:async(url,options)=>{requests.push(options);return analysisResponse();}});
    await provider.analyze({...project,novel:'雨'.repeat(18001)});
    assert.equal(requests.length,2);
    assert.deepEqual(requests.map(options=>options.timeoutMs),[600000,600000]);
  }finally{
    if(previous===undefined)delete process.env.AIFRAME_ANALYSIS_TIMEOUT_MS;
    else process.env.AIFRAME_ANALYSIS_TIMEOUT_MS=previous;
  }
});

test('Qwen structured analysis disables thinking on original and correction without leaking vendor fields to DeepSeek',async()=>{
  for(const llmModel of models){
    const requests=[];
    const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel,llmKey:'coding-fixture',tokenPlanKey:'token-fixture'}),requestJson:async(_url,options)=>{
      requests.push(options.body);
      return requests.length===1?{choices:[{message:{content:'{}'}}]}:analysisResponse();
    }});
    await provider.analyze(project);
    assert.equal(requests.length,2);
    for(const body of requests){
      assert.equal(body.model,llmModel);
      assert.equal(body.enable_thinking,llmModel.startsWith('qwen')?false:undefined);
    }
  }
});

test('one analysis uses its configured timeout consistently across chunks',async()=>{
  const previous=process.env.AIFRAME_ANALYSIS_TIMEOUT_MS;
  process.env.AIFRAME_ANALYSIS_TIMEOUT_MS='600000';
  try{
    const requests=[];
    const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel:'qwen3.7-plus',llmKey:'coding-fixture'}),requestJson:async(url,options)=>{requests.push(options);return analysisResponse();}});
    await provider.analyze({...project,novel:'雨'.repeat(36001)});
    assert.ok(requests.length > 1);
    assert.ok(requests.every(options=>options.timeoutMs===600000));
  }finally{
    if(previous===undefined)delete process.env.AIFRAME_ANALYSIS_TIMEOUT_MS;
    else process.env.AIFRAME_ANALYSIS_TIMEOUT_MS=previous;
  }
});

test('invalid analysis timeout settings fail before any model request',async()=>{
  const previous=process.env.AIFRAME_ANALYSIS_TIMEOUT_MS;
  try{
    for(const value of ['abc','999','600001','1.5']){
      process.env.AIFRAME_ANALYSIS_TIMEOUT_MS=value;
      let calls=0;
      const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel:'qwen3.7-plus',llmKey:'coding-fixture'}),requestJson:async()=>{calls++;return analysisResponse();}});
      await assert.rejects(provider.analyze(project),error=>error.code==='INVALID_CONFIG');
      assert.equal(calls,0,value);
    }
  }finally{
    if(previous===undefined)delete process.env.AIFRAME_ANALYSIS_TIMEOUT_MS;
    else process.env.AIFRAME_ANALYSIS_TIMEOUT_MS=previous;
  }
});

test('provider refusal does not silently retry using another preset or credential group',async()=>{
  let calls=0;
  const provider=createProviders({mediaRoot:tmpdir(),getSettings:()=>({llmModel:'qwen3.8-max',llmKey:'coding-fixture',tokenPlanKey:'token-fixture'}),requestJson:async()=>{calls++;throw safeError('模型认证失败。','UPSTREAM_HTTP');}});
  await assert.rejects(provider.analyze(project),error=>error.code==='UPSTREAM_HTTP');
  assert.equal(calls,1);
});

test('HTTP configuration publishes all presets and saves Token Plan selection through the protected write boundary',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'aiframe-llm-http-'));
  const config=await createConfig({env:{DASHSCOPE_API_KEY:'coding-http-private-fixture'}});
  const server=await createHttpServer({service:{list:async()=>[]},config,dataDir:dir,distDir:path.join(dir,'dist')});
  t.after(async()=>{await server.close();await rm(dir,{recursive:true,force:true});});
  const endpoint=`${server.url}/api/config`;
  const initial=await (await fetch(endpoint)).json();
  assert.deepEqual(initial.llmModels.map(model=>model.id),models);
  const patch={llmModel:'qwen3.8-flash',tokenPlanKey:'token-http-private-fixture'};
  const denied=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)});
  assert.equal(denied.status,403);
  const accepted=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','X-Local-Client':'aiframe'},body:JSON.stringify(patch)});
  assert.equal(accepted.status,200);
  const result=await accepted.json();
  assert.equal(result.llmModel,'qwen3.8-flash');
  assert.equal(result.llmConfigured,true);
  assert.equal(result.codingPlanConfigured,true);
  assert.equal(result.tokenPlanConfigured,true);
  assert.doesNotMatch(JSON.stringify(result),/private-fixture|tokenPlanKey|llmKey/);
  const state=await (await fetch(`${server.url}/api/state`)).json();
  assert.equal(state.config.llmModel,'qwen3.8-flash');
  assert.doesNotMatch(JSON.stringify(state),/private-fixture|tokenPlanKey|llmKey/);
});

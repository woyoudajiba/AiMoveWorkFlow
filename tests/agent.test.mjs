import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAgent, listAgentTools } from '../agent/tools.mjs';
import { createLocalClient } from '../agent/client.mjs';

async function fixture(t, handler) {
  const server=http.createServer((req,res)=>{
    if(req.url==='/api/auth/status'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({authenticated:true,sessionId:'a'.repeat(64)}));return;}
    return handler(req,res);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
}
const response=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
function sample(){return {id:'p1',title:'测试',novel:'原文',characters:[{id:'c1',name:'人物',version:3,reference:'/media/p1/c.png',referenceVersion:3,approved:false}],segments:[{id:'seg1',number:1,duration:30,shots:[{id:'s1',number:1,version:4,image:'/media/p1/s.png',imageVersion:4,video:null,videoVersion:null,approved:false}]}],jobs:[],exports:[]};}

test('Agent only accepts a literal loopback HTTP origin and never follows redirects',async t=>{
  for(const url of ['https://127.0.0.1:4318','http://localhost:4318','http://127.1:4318','http://127.0.0.1:4318/path','http://127.0.0.1:4318?key=secret','http://user:pass@127.0.0.1:4318','http://192.168.1.3:4318','http://127.0.0.1:65536']) assert.throws(()=>createLocalClient({baseUrl:url}),/127\.0\.0\.1/);
  let targetCalls=0;
  const target=await fixture(t,(_req,res)=>{targetCalls++;response(res,{});});
  const source=await fixture(t,(_req,res)=>{res.writeHead(307,{Location:target});res.end();});
  await assert.rejects(createAgent({baseUrl:source}).execute('studio_status',{}),e=>e.code==='REDIRECT_BLOCKED');
  assert.equal(targetCalls,0);
});

test('malformed local JSON responses reject cleanly without crashing the Agent process',async t=>{
  let body=null;
  const url=await fixture(t,(_req,res)=>response(res,body,400));
  const client=createLocalClient({baseUrl:url});
  await assert.rejects(client.request('/api/state'),e=>e.code==='INVALID_RESPONSE');
  body=[];
  await assert.rejects(client.request('/api/projects','POST',{}),e=>e.code==='SUBMISSION_UNKNOWN');
  body={code:'TEST_FAILURE',error:'受控错误'};
  await assert.rejects(client.request('/api/state'),e=>e.code==='TEST_FAILURE');
});

test('all Agent inputs use strict allowlists and credentials are never returned',async t=>{
  let calls=0;
  const url=await fixture(t,(_req,res)=>{calls++;response(res,{projects:[],config:{llmConfigured:true,llmKey:'private-secret',nested:{apiKey:'other-secret',tokenPlanKey:'token-plan-private-value'}}});});
  const agent=createAgent({baseUrl:url});
  await assert.rejects(agent.execute('studio_status',{apiKey:'not-accepted'}),e=>e.code==='INVALID_INPUT');
  await assert.rejects(agent.execute('get_project',{projectId:'../config'}),e=>e.code==='INVALID_INPUT');
  await assert.rejects(agent.execute('update_character',{projectId:'p',characterId:'c',patch:{approved:true}}),e=>e.code==='INVALID_INPUT');
  await assert.rejects(agent.execute('update_shot',{projectId:'p',shotId:'s',patch:{}}),e=>e.code==='INVALID_INPUT');
  assert.equal(calls,0);
  const result=await agent.execute('studio_status',{});
  assert.equal(JSON.stringify(result).includes('private-secret'),false);assert.equal(JSON.stringify(result).includes('other-secret'),false);
  assert.equal(JSON.stringify(result).includes('token-plan-private-value'),false);
  assert.ok(listAgentTools().every(tool=>tool.inputSchema.additionalProperties===false));
});

test('Agent creates universal projects with source type and selected aspect ratio', async t => {
  let body;
  const url = await fixture(t, async (req, res) => {
    if (req.method === 'POST') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
      response(res, { id: 'paper-project', title: body?.title ?? '研究报告', novel: body?.novel ?? '', sourceType: body?.sourceType, narrativeMode: body?.narrativeMode, aspectRatio: body?.aspectRatio, generationMode: body?.generationMode, characters: [], segments: [], jobs: [], exports: [] });
  });
  const result = await createAgent({ baseUrl: url }).execute('create_project', { title: '研究报告视频', novel: '样本在三个月内下降。', sourceType: 'paper', narrativeMode: 'narrator', aspectRatio: '16:9' });
  assert.equal(body.sourceType, 'paper');
  assert.equal(body.aspectRatio, '16:9');
  assert.equal(body.narrativeMode, 'narrator');
  assert.equal(body.generationMode, 'segment-board');
  assert.equal(result.project.aspectRatio, '16:9');
});

test('default generation reuses current assets and unknown tasks; explicit redo uses atomic version guards',async t=>{
  let project=sample();const writes=[];
  const url=await fixture(t,async(req,res)=>{
    if(req.method==='GET'){response(res,project);return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    writes.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString()),client:req.headers['x-local-client']});response(res,project);
  });
  const agent=createAgent({baseUrl:url});
  assert.equal((await agent.execute('generate_character',{projectId:'p1',characterId:'c1'})).reused,true);
  assert.equal((await agent.execute('generate_shot',{projectId:'p1',shotId:'s1'})).reused,true);
  assert.equal(writes.length,0);
  await agent.execute('generate_character',{projectId:'p1',characterId:'c1',regenerate:true});
  assert.deepEqual(writes[0].body,{reuseExisting:false,expectedVersion:3});assert.equal(writes[0].client,'aiframe');
  project.characters[0].referenceVersion=2;
  await assert.rejects(agent.execute('generate_character',{projectId:'p1',characterId:'c1'}),e=>e.code==='STALE_ASSET');
  project.characters[0].reference=null;
  project.jobs=[{id:'job1',kind:'character',targetId:'c1',inputVersion:3,status:'unknown'}];
  assert.equal((await agent.execute('generate_character',{projectId:'p1',characterId:'c1',regenerate:true})).reused,true);
  assert.equal(writes.length,1);
  project.jobs=[];
  await agent.execute('generate_character',{projectId:'p1',characterId:'c1'});
  assert.deepEqual(writes[1].body,{reuseExisting:true,expectedVersion:3});
});

test('approval requires explicit inspected version and never implies video submission',async t=>{
  const project=sample();const writes=[];
  const url=await fixture(t,async(req,res)=>{if(req.method==='GET'){response(res,project);return;}const chunks=[];for await(const c of req)chunks.push(c);writes.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString())});response(res,project);});
  const agent=createAgent({baseUrl:url});
  await assert.rejects(agent.execute('approve_shot',{projectId:'p1',shotId:'s1'}),e=>e.code==='INVALID_INPUT');
  await assert.rejects(agent.execute('approve_shot',{projectId:'p1',shotId:'s1',reviewedVersion:3}),e=>e.code==='STALE_INPUT');
  assert.equal(writes.length,0);
  await agent.execute('approve_shot',{projectId:'p1',shotId:'s1',reviewedVersion:4});
  assert.deepEqual(writes,[{path:'/api/projects/p1/shots/s1/approve',body:{reviewedVersion:4}}]);
});

test('a paid POST with uncertain transport outcome is sent once and never automatically retried',async t=>{
  const project=sample();project.characters[0].reference=null;let posts=0;
  const url=await fixture(t,(req,res)=>{if(req.method==='GET'){response(res,project);return;}posts++;req.socket.destroy();});
  await assert.rejects(createAgent({baseUrl:url}).execute('generate_character',{projectId:'p1',characterId:'c1'}),e=>e.code==='SUBMISSION_UNKNOWN');
  assert.equal(posts,1);
});

test('batch generation with complete images reuses them and preview is an independent non-approval action',async t=>{
  const project=sample();let writes=0;
  const url=await fixture(t,(req,res)=>{if(req.method==='GET'){response(res,project);return;}writes++;assert.equal(req.url,'/api/projects/p1/segments/seg1/preview');response(res,{kind:'storyboard-preview',gridUrl:'/media/p1/preview/001.jpg',requiresReview:true});});
  const agent=createAgent({baseUrl:url});
  assert.equal((await agent.execute('generate_segment_images',{projectId:'p1',segmentId:'seg1'})).reused,true);
  const preview=await agent.execute('storyboard_preview',{projectId:'p1',segmentId:'seg1'});
  assert.equal(preview.requiresReview,true);assert.equal(project.segments[0].shots[0].approved,false);assert.equal(writes,1);
});

test('batch images reject stale or unversioned assets before any paid submission',async t=>{
  const project=sample();let writes=0;
  const url=await fixture(t,(req,res)=>{if(req.method!=='GET')writes++;response(res,project);});
  const agent=createAgent({baseUrl:url});
  for(const stamp of [3,undefined]){
    project.segments[0].shots[0].imageVersion=stamp;
    await assert.rejects(agent.execute('generate_segment_images',{projectId:'p1',segmentId:'seg1'}),e=>e.code==='STALE_ASSET');
  }
  assert.equal(writes,0);
});

test('batch generation submits only snapshot missing shots with atomic guards and reuses current tasks',async t=>{
  for(const kind of ['image','video'])await t.test(kind,async t=>{
    const project=sample();const first=project.segments[0].shots[0];
    first[kind]='/media/p1/current';first[`${kind}Version`]=first.version;
    project.segments[0].shots.push(...[2,3,4].map(number=>({...first,id:`s${number}`,number,version:number+4,[kind]:null})));
    project.jobs=[{id:'existing',kind,targetId:'s3',inputVersion:7,status:'unknown'}];
    const writes=[];
    const url=await fixture(t,async(req,res)=>{
      if(req.method==='GET'){response(res,project);return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      writes.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString())});
      response(res,project);
    });
    const agent=createAgent({baseUrl:url});
    const output=await agent.execute(kind==='image'?'generate_segment_images':'generate_segment_videos',{projectId:'p1',segmentId:'seg1'});
    assert.equal(output.reused,false);
    const action=kind==='image'?'generate':'video';
    assert.deepEqual(writes,[
      {path:`/api/projects/p1/shots/s2/${action}`,body:{reuseExisting:true,expectedVersion:6}},
      {path:`/api/projects/p1/shots/s4/${action}`,body:{reuseExisting:true,expectedVersion:8}},
    ]);
    project.jobs.push(...[2,4].map(number=>({id:`active${number}`,kind,targetId:`s${number}`,inputVersion:number+4,status:'running'})));
    assert.equal((await agent.execute(kind==='image'?'generate_segment_images':'generate_segment_videos',{projectId:'p1',segmentId:'seg1'})).reused,true);
    assert.equal(writes.length,2);
  });
});

test('batch stops on an atomic version conflict without retrying or silently submitting later shots',async t=>{
  const project=sample();const first=project.segments[0].shots[0];first.image=null;
  project.segments[0].shots.push(...[2,3].map(number=>({...first,id:`s${number}`,number,version:number+4})));
  const writes=[];
  const url=await fixture(t,async(req,res)=>{
    if(req.method==='GET'){response(res,project);return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());writes.push({path:req.url,body});
    if(writes.length===1){project.segments[0].shots[1].version++;response(res,project);return;}
    response(res,{code:'VERSION_CONFLICT',error:'分镜已修改，请重新读取。'},409);
  });
  await assert.rejects(createAgent({baseUrl:url}).execute('generate_segment_images',{projectId:'p1',segmentId:'seg1'}),e=>e.code==='VERSION_CONFLICT');
  assert.deepEqual(writes,[
    {path:'/api/projects/p1/shots/s1/generate',body:{reuseExisting:true,expectedVersion:4}},
    {path:'/api/projects/p1/shots/s2/generate',body:{reuseExisting:true,expectedVersion:6}},
  ]);
});

test('segment-board Agent generation submits one storyboard task and approves the inspected board version',async t=>{
  const project=sample();
  project.generationMode='segment-board';
  project.segments[0].shots=[1,2,3].map(number=>({id:`s${number}`,number,version:number,image:null,imageVersion:null,approved:false,video:null,videoVersion:null}));
  project.segments[0].storyboardImage=null;
  project.segments[0].storyboardImageVersion=null;
  project.segments[0].storyboardApproved=false;
  const writes=[];
  const url=await fixture(t,async(req,res)=>{
    if(req.method==='GET'){response(res,project);return;}
    const chunks=[];for await(const c of req)chunks.push(c);
    writes.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString())});
    response(res,project);
  });
  const agent=createAgent({baseUrl:url});
  const submitted=await agent.execute('generate_segment_images',{projectId:'p1',segmentId:'seg1'});
  assert.equal(submitted.reused,false);
  assert.deepEqual(writes,[{path:'/api/projects/p1/segments/seg1/generate-images',body:{reuseExisting:true}}]);

  const boardVersion='{"templateId":"classic-nine","shots":[["s1",1,3,null],["s2",1,3,null],["s3",1,3,null]]}';
  project.segments[0].storyboardImage='/media/p1/board.png';
  project.segments[0].storyboardImageVersion=boardVersion;
  project.segments[0].shots.forEach(shot=>{shot.image=`/media/p1/${shot.id}.png`;shot.imageVersion=shot.version;});
  await assert.rejects(agent.execute('approve_segment_board',{projectId:'p1',segmentId:'seg1',reviewedVersion:'stale'}),e=>e.code==='STALE_INPUT');
  await agent.execute('approve_segment_board',{projectId:'p1',segmentId:'seg1',reviewedVersion:boardVersion});
  assert.deepEqual(writes[1],{path:'/api/projects/p1/segments/seg1/approve',body:{reviewedVersion:boardVersion}});
});

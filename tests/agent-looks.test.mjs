import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAgent,listAgentTools} from '../agent/tools.mjs';

test('Agent scene looks carry version guards, reuse assets, block stale approval and allow scene assignment',async t=>{
  const writes=[];const project={id:'p',looks:[{id:'l',sceneId:'s',characterId:'c',version:4,referenceVersion:4,reference:'/media/p/look.png',approved:false}],jobs:[]};
  const server=http.createServer(async(req,res)=>{if(req.url==='/api/auth/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({authenticated:true,sessionId:'a'.repeat(64)}));return;}if(req.method!=='GET'){const chunks=[];for await(const chunk of req)chunks.push(chunk);writes.push({path:req.url,body:JSON.parse(Buffer.concat(chunks))});}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(project));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const agent=createAgent({baseUrl:`http://127.0.0.1:${server.address().port}`});
  assert.equal((await agent.execute('generate_look',{projectId:'p',lookId:'l'})).reused,true);assert.equal(writes.length,0);
  await agent.execute('generate_look',{projectId:'p',lookId:'l',regenerate:true});assert.deepEqual(writes[0],{path:'/api/projects/p/looks/l/generate',body:{expectedVersion:4,reuseExisting:false}});
  await assert.rejects(agent.execute('approve_look',{projectId:'p',lookId:'l',reviewedVersion:3}),e=>e.code==='STALE_INPUT');
  await agent.execute('approve_look',{projectId:'p',lookId:'l',reviewedVersion:4});assert.equal(writes[1].body.reviewedVersion,4);
  await agent.execute('update_shot',{projectId:'p',shotId:'shot',patch:{sceneId:'s'}});assert.equal(writes[2].body.sceneId,'s');
  await agent.execute('create_scene',{projectId:'p',name:'办公室',description:'次日白天'});assert.equal(writes[3].path,'/api/projects/p/scenes');
  await agent.execute('create_look',{projectId:'p',sceneId:'s',characterId:'c',name:'衬衫',appearance:'白衬衫'});assert.equal(writes[4].path,'/api/projects/p/looks');
  project.looks[0].referenceVersion=3;await assert.rejects(agent.execute('generate_look',{projectId:'p',lookId:'l'}),e=>e.code==='STALE_ASSET');
  assert.equal(listAgentTools().length,28);
  await assert.rejects(agent.execute('update_look',{projectId:'p',lookId:'l',patch:{approved:true}}),e=>e.code==='INVALID_INPUT');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createAgent,listAgentTools} from '../agent/tools.mjs';

async function fixture(t){
  const project={id:'p',segments:[{id:'seg',boardTemplateId:'eight-one',shots:[]}],jobs:[],exports:[]};
  const writes=[];let preview={templateId:'three-three',gridUrl:'/media/p/preview/001-01.jpg',pages:[{number:1,gridUrl:'/media/p/preview/001-01.jpg'},{number:2,gridUrl:'/media/p/preview/001-02.jpg'}]};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/api/auth/status'){res.end(JSON.stringify({authenticated:true,sessionId:'a'.repeat(64)}));return;}
    if(req.url==='/api/board-templates'){res.end(JSON.stringify({defaultTemplateId:'classic-nine',templates:[{id:'classic-nine'},{id:'eight-one'},{id:'three-three'}]}));return;}
    if(req.method!=='GET'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));writes.push({path:req.url,method:req.method,body});
      if(req.url.endsWith('/preview')){res.end(JSON.stringify(preview));return;}
      if(req.method==='PATCH')project.segments[0].boardTemplateId=body.boardTemplateId;
    }
    res.end(JSON.stringify(project));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {agent:createAgent({baseUrl:`http://127.0.0.1:${server.address().port}`}),project,writes,setPreview:value=>{preview=value;}};
}

test('Agent discovers templates, saves a preference, and forwards preview overrides without model calls',async t=>{
  const {agent,writes}=await fixture(t);
  const tools=listAgentTools();assert.equal(tools.length,28);assert.equal(tools.find(tool=>tool.name==='list_board_templates').annotations.readOnlyHint,true);
  assert.equal((await agent.execute('list_board_templates')).templates.length,3);
  await agent.execute('set_board_template',{projectId:'p',segmentId:'seg',templateId:'eight-one'});
  const preview=await agent.execute('storyboard_preview',{projectId:'p',segmentId:'seg',templateId:'three-three'});
  assert.equal(preview.pages.length,2);
  assert.deepEqual(writes,[{path:'/api/projects/p/segments/seg',method:'PATCH',body:{boardTemplateId:'eight-one'}},{path:'/api/projects/p/segments/seg/preview',method:'POST',body:{templateId:'three-three'}}]);
  await assert.rejects(agent.execute('set_board_template',{projectId:'p',segmentId:'seg',templateId:'unknown'}),e=>e.code==='INVALID_INPUT');
  await assert.rejects(agent.execute('storyboard_preview',{projectId:'p',segmentId:'seg',templateId:null}),e=>e.code==='INVALID_INPUT');assert.equal(writes.length,2);
});

test('Agent export only reuses the latest artifact for the current template, not unmarked or different layouts',async t=>{
  const {agent,project,writes}=await fixture(t);
  project.exports=[{id:'old',segmentId:'seg',gridUrl:'/media/p/old.jpg'},{id:'classic',segmentId:'seg',templateId:'classic-nine',gridUrl:'/media/p/classic.jpg'}];
  assert.equal((await agent.execute('export_segment',{projectId:'p',segmentId:'seg'})).reused,false);assert.equal(writes.length,1);
  project.exports.push({id:'first-eight',segmentId:'seg',templateId:'eight-one',gridUrl:'/media/p/eight-first.jpg'},{id:'latest-eight',segmentId:'seg',templateId:'eight-one',gridUrl:'/media/p/eight-latest.jpg',pages:[{number:1,gridUrl:'/media/p/eight-latest.jpg'}]});
  const reused=await agent.execute('export_segment',{projectId:'p',segmentId:'seg'});assert.equal(reused.reused,true);assert.equal(reused.export.id,'latest-eight');assert.equal(writes.length,1);
  delete project.segments[0].boardTemplateId;assert.equal((await agent.execute('export_segment',{projectId:'p',segmentId:'seg'})).export.id,'classic');
});

test('Agent rejects a malicious secondary preview or export page URL',async t=>{
  const {agent,project,setPreview}=await fixture(t);
  for(const url of ['https://outside.invalid/second.jpg','/media/other/second.jpg','/media/p/%2e%2e/other/second.jpg']){
    const artifact={templateId:'eight-one',gridUrl:'/media/p/first.jpg',pages:[{gridUrl:'/media/p/first.jpg'},{gridUrl:url}]};
    setPreview(artifact);await assert.rejects(agent.execute('storyboard_preview',{projectId:'p',segmentId:'seg'}),e=>e.code==='INVALID_MEDIA');
    project.exports=[{...artifact,segmentId:'seg'}];await assert.rejects(agent.execute('export_segment',{projectId:'p',segmentId:'seg'}),e=>e.code==='INVALID_MEDIA');
  }
});

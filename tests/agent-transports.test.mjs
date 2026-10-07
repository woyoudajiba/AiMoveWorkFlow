import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHttpServer, authenticatedFetch as fetch } from './helpers/http-fixture.mjs';
import { createService } from '../server/service.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function workspace(t){
  const dir=await mkdtemp(path.join(tmpdir(),'aiframe-agent-transport-'));
  await mkdir(path.join(dir,'dist'));await writeFile(path.join(dir,'dist','index.html'),'fixture');
  const service=await createService({dataDir:dir,providers:{}});
  const server=await createHttpServer({service,config:{public:()=>({llmConfigured:false,grsaiConfigured:false,minimaxConfigured:false,arkConfigured:false})},dataDir:dir,distDir:path.join(dir,'dist')});
  t.after(async()=>{await server.close();await service.close();await rm(dir,{recursive:true,force:true});});
  return {dir,service,url:server.url};
}
function cli(args,stdin=''){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(root,'scripts','agent-cli.mjs'),...args],{cwd:root,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(stdin);
  });
}

test('JSON CLI lists shared tools and creates/reads a real local project through HTTP',async t=>{
  const {url,service,dir}=await workspace(t);
  const listed=await cli(['--url',url,'list']);
  assert.equal(listed.code,0);assert.equal(listed.stderr,'');
  const discovery=JSON.parse(listed.stdout);assert.equal(discovery.ok,true);assert.ok(discovery.tools.some(tool=>tool.name==='storyboard_preview'));
  assert.equal(discovery.tools.length,27);
  const templates=await cli(['--url',url,'call','list_board_templates'],'{}');assert.equal(templates.code,0);assert.equal(JSON.parse(templates.stdout).result.templates.length,3);
  const input={title:'CLI 原创故事',novel:'灯亮起时，林遥推开书店的门。',durationMode:'auto'};
  const created=await cli(['--url',url,'call','create_project'],JSON.stringify(input));
  assert.equal(created.code,0);const project=JSON.parse(created.stdout).result.project;assert.equal(project.title,input.title);assert.equal('novel' in project,false);assert.equal((await service.get(project.id)).generationMode,'segment-board');
  assert.equal((await service.get(project.id)).novel,input.novel);
  const file=path.join(dir,'read.json');await writeFile(file,JSON.stringify({projectId:project.id,includeNovel:true}));
  const read=await cli(['--url',url,'call','get_project','--input',file]);
  assert.equal(read.code,0);assert.equal(JSON.parse(read.stdout).result.novel,input.novel);
  const invalid=await cli(['--url',url,'call','studio_status'],JSON.stringify({legacyVideoKey:'must-not-be-used'}));
  assert.equal(invalid.code,1);assert.equal(JSON.parse(invalid.stdout).error.code,'INVALID_INPUT');assert.equal(invalid.stdout.includes('must-not-be-used'),false);
  const forbidden=await cli(['--url','https://example.com','call','studio_status'],'{}');
  assert.equal(forbidden.code,1);assert.equal(JSON.parse(forbidden.stdout).error.code,'INVALID_URL');
});

test('official MCP SDK performs stdio initialize, tools/list and tools/call against the actual local application',async t=>{
  const {url,service}=await workspace(t);
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'scripts','agent-mcp.mjs'),'--url',url],cwd:root,stderr:'pipe'});
  let stderr='';transport.stderr.on('data',chunk=>stderr+=chunk);
  const client=new Client({name:'aiframe-integration-client',version:'1.0.0'},{capabilities:{}});
  t.after(async()=>{await client.close();});
  await client.connect(transport);
  assert.equal(client.getServerVersion().name,'aiframe-studio');
  const discovery=await client.listTools();assert.equal(discovery.tools.length,27);
  assert.equal(discovery.tools.find(tool=>tool.name==='approve_shot').inputSchema.additionalProperties,false);
  const status=await client.callTool({name:'studio_status',arguments:{}});
  assert.equal(status.isError,undefined);assert.equal(status.structuredContent.ok,true);
  const templates=await client.callTool({name:'list_board_templates',arguments:{}});assert.equal(templates.structuredContent.result.templates.length,3);
  const boardProject=await service.demo();const preference=await client.callTool({name:'set_board_template',arguments:{projectId:boardProject.id,segmentId:boardProject.segments[0].id,templateId:'three-three'}});
  assert.equal(preference.isError,undefined);assert.equal((await service.get(boardProject.id)).segments[0].boardTemplateId,'three-three');
  const created=await client.callTool({name:'create_project',arguments:{title:'MCP 原创故事',novel:'书店打烊前，陈默收到了迟来的明信片。',durationMode:'auto'}});
  assert.equal(created.isError,undefined);const project=created.structuredContent.result.project;
  assert.equal((await service.get(project.id)).durationMode,'auto');assert.equal((await service.get(project.id)).generationMode,'segment-board');
  const read=await client.callTool({name:'get_project',arguments:{projectId:project.id}});
  assert.equal(read.structuredContent.result.title,'MCP 原创故事');
  const denied=await client.callTool({name:'approve_shot',arguments:{projectId:project.id,shotId:'missing'}});
  assert.equal(denied.isError,true);
  assert.equal(stderr,'', 'stdio stdout must remain valid protocol and normal startup must be quiet');
  await client.close();
});

import path from 'node:path';
import {mkdir,readFile,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {LLM_MODELS} from '../server/llm-models.mjs';

const executable=path.resolve(process.argv[2]||'release/win-unpacked/YingXu.exe');
const directory=path.resolve(process.argv[3]||`output/package-smoke/${Date.now()}`);
await mkdir(directory,{recursive:true});
await rm(path.join(directory,'result.json'),{force:true});
const env={...process.env,AI_FRAME_SMOKE_DIR:directory};
delete env.ELECTRON_RUN_AS_NODE;
for(const key of ['DASHSCOPE_API_KEY','QWEN_API_KEY','ALIBABA_CODING_PLAN_API_KEY','TOKEN_PLAN_API_KEY','ALIBABA_TOKEN_PLAN_API_KEY','GRSAI_API_KEY','MINIMAX_API_KEY','XIONGMAO_API_KEY','XIONGMAO_MINIMAXH3_API_KEY','ARK_API_KEY'])delete env[key];
delete env.FFMPEG_BIN;
const child=spawn(executable,[],{env,windowsHide:true,stdio:'ignore'});
const result=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{
    if(process.platform==='win32'&&child.pid)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    else child.kill();
    reject(new Error('Packaged Electron smoke test timed out.'));
  },90000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);resolve(code);});
});
const report=JSON.parse(await readFile(path.join(directory,'result.json'),'utf8'));
if(result!==0||!report.ok)throw new Error(`Packaged Electron smoke test failed: ${report.code||result}`);
assert.equal(report.packaged,true,'The smoke target must be a packaged application.');
assert.equal(report.auth?.authenticated,false);
assert.equal(report.auth?.protectedRoutes,true);
assert.equal(report.auth?.rememberAvailable,true);
assert.equal(report.page.screen,'login');
assert.deepEqual(report.config.llmModels.map(({id,recommended})=>({id,recommended})),LLM_MODELS.map(({id,recommended})=>({id,recommended})),'Packaged model presets must match the complete catalog.');
assert.equal(report.config.llmModels.some(model=>model.configured),false,'Smoke model credentials must remain empty.');
console.log(JSON.stringify({executable,directory,...report},null,2));

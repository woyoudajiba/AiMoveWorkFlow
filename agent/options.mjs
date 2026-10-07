import { readFile, stat } from 'node:fs/promises';
import { agentError } from './client.mjs';

export function launchOptions(argv,{mcp=false}={}){
  const options={baseUrl:'http://127.0.0.1:4318',positionals:[]};const seen=new Set();
  for(let i=0;i<argv.length;i++){
    const value=argv[i];
    if(value==='--url'||(!mcp&&value==='--input')){
      if(seen.has(value)||!argv[i+1]||argv[i+1].startsWith('--'))throw agentError('INVALID_INPUT','启动参数重复或缺少值。');
      seen.add(value);options[value==='--url'?'baseUrl':'inputFile']=argv[++i];
    }else if(value.startsWith('-'))throw agentError('INVALID_INPUT','未知启动参数；仅接受 --url，以及 CLI 的 --input。');
    else options.positionals.push(value);
  }
  if(mcp&&options.positionals.length)throw agentError('INVALID_INPUT','MCP 启动不接受额外位置参数。');
  return options;
}

export async function readArguments(inputFile){
  let text;
  if(inputFile){
    try{const info=await stat(inputFile);if(!info.isFile()||info.size>1024*1024)throw agentError('INPUT_TOO_LARGE','输入文件必须是小于 1 MiB 的 JSON 文件。');text=await readFile(inputFile,'utf8');}
    catch(error){if(error.agentSafe)throw error;throw agentError('INVALID_INPUT','无法读取 JSON 输入文件。');}
  }else{
    if(process.stdin.isTTY)return {};
    const chunks=[];let size=0;
    for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw agentError('INPUT_TOO_LARGE','标准输入超过 1 MiB。');chunks.push(chunk);}
    text=Buffer.concat(chunks).toString('utf8');
  }
  try{return JSON.parse(text.replace(/^\uFEFF/,'').trim()||'{}');}
  catch{throw agentError('INVALID_INPUT','参数必须是有效 JSON 对象；可通过标准输入或 --input 文件传入。');}
}

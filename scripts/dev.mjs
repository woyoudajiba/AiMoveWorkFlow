import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const children=[spawn(process.execPath,['server/index.mjs'],{cwd:root,stdio:'inherit'}),spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','4317','--strictPort'],{cwd:root,stdio:'inherit'})];
let closing=false;
function stop(code=0){if(closing)return;closing=true;for(const child of children)child.kill();process.exitCode=code;}
for(const child of children)child.on('exit',code=>stop(code??0));
process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());

import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
for(const file of await readdir('agent')){
  if(!file.endsWith('.mjs'))continue;
  const result=spawnSync(process.execPath,['--check',path.join('agent',file)],{stdio:'inherit',shell:false,windowsHide:true});
  if(result.status!==0)process.exit(result.status||1);
}
console.log('Agent modules syntax checked.');

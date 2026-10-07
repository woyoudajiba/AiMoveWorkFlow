import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
for(const dir of ['server','electron','scripts']){
  for(const file of await readdir(dir)){
    if(!/\.(mjs|cjs)$/.test(file))continue;
    const result=spawnSync(process.execPath,['--check',path.join(dir,file)],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status||1);
  }
}
console.log('Node modules syntax checked.');

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {acquireDataLock} from '../server/lock.mjs';
test('a data directory has one owner even if servers choose different HTTP ports',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'aiframe-lock-'));
  try{
    const release=await acquireDataLock(dir);
    await assert.rejects(acquireDataLock(dir),/已在使用/);
    await release();
    const again=await acquireDataLock(dir);await again();
  }finally{await rm(dir,{recursive:true,force:true});}
});

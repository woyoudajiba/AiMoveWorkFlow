import net from 'node:net';
import {realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';

// A Windows named pipe is owned by the OS, so a crashed process leaves no stale
// lock file. Acquire before loading projects: loading can resume paid jobs.
export async function acquireDataLock(dataDir){
  const resolved=await realpath(dataDir);
  const digest=createHash('sha256').update(process.platform==='win32'?resolved.toLowerCase():resolved).digest('hex');
  const server=net.createServer(socket=>socket.end());
  const options=process.platform==='win32'?{path:`\\\\.\\pipe\\aiframe-${digest.slice(0,40)}`}:{host:'127.0.0.1',port:30000+(parseInt(digest.slice(0,6),16)%25000),exclusive:true};
  await new Promise((resolve,reject)=>{
    server.once('error',()=>reject(Object.assign(new Error('该数据目录已在使用，请关闭另一个映序窗口或服务后重试。'),{code:'DATA_IN_USE',status:409})));
    server.listen(options,resolve);
  });
  let released=false;
  return ()=>new Promise((resolve,reject)=>{if(released)return resolve();released=true;server.close(error=>error?reject(error):resolve());});
}

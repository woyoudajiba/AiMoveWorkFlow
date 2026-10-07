import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import {createHttpServer} from './http.mjs';
import {acquireDataLock} from './lock.mjs';
import {createWorkspaces} from './workspaces.mjs';
import {createTdlAuth} from './tdl-auth.mjs';
import {createFileAuthStore} from './auth-store.mjs';
import {createAdminAuth} from './admin-auth.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function startApp({dataDir=process.env.AI_FRAME_DATA_DIR||path.join(root,'data'),outputRoot=process.env.AI_FRAME_OUTPUT_DIR||null,downloadsDir=path.join(root,'client'),port=0,loadCredentials,saveCredentials,loadAuth,saveAuth,configEnv={},allowDevOrigin=false}={}){
  await mkdir(path.join(dataDir,'media'),{recursive:true});
  const release=await acquireDataLock(dataDir);
  let workspaces;
  try {
  const fileAuth = !loadAuth && !saveAuth && process.env.AI_FRAME_AUTH_FILE ? createFileAuthStore(process.env.AI_FRAME_AUTH_FILE) : null;
  const auth=await createTdlAuth({load:loadAuth || fileAuth?.load,save:saveAuth || fileAuth?.save,persistLogin:Boolean(fileAuth && process.env.AI_FRAME_PERSIST_AUTH === '1')});
  workspaces=await createWorkspaces({dataDir,outputRoot,loadCredentials,saveCredentials,configEnv,ffmpegAvailable:Boolean(ffmpeg&&existsSync(ffmpeg)&&existsSync(ffprobe.path))});
  const httpServer=await createHttpServer({auth,workspaces,distDir:path.join(root,'dist'),downloadsDir,adminAuth:createAdminAuth() ,port,allowDevOrigin});
  return {...httpServer,close:async()=>{try{await httpServer.close();await workspaces.close();}finally{await release();}}};
  }catch(error){if(workspaces)await workspaces.close();await release();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const configEnv=process.env.AI_FRAME_CONFIG_FROM_ENV==='1'?process.env:{};
  const app=await startApp({port:Number(process.env.PORT||4318),configEnv,allowDevOrigin:process.env.NODE_ENV!=='production'});
  console.log(`映序本地工作台：${app.url}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close().finally(()=>process.exit(0));});
}

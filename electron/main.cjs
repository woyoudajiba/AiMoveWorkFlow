const {app,BrowserWindow,safeStorage,dialog,ipcMain,Notification}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {resolveClientTarget}=require('./runtime-config.cjs');
const {createUpdater}=require('./updater.cjs');
const {createProjectFolderStore,createLocalProjectStorage}=require('./local-project.cjs');
const packageInfo=require('../package.json');
const clientDisplayVersion=typeof packageInfo.clientVersion==='string'&&packageInfo.clientVersion.trim()?packageInfo.clientVersion.trim():app.getVersion();
let backend;
// Keep development and packaged data at the same stable location.
app.setPath('userData',path.join(app.getPath('appData'),'aiframe-studio'));
const smokeDirectory=process.env.AI_FRAME_SMOKE_DIR;
if(smokeDirectory){
  if(!path.isAbsolute(smokeDirectory))throw new Error('AI_FRAME_SMOKE_DIR must be an absolute path.');
  app.setPath('userData',path.join(smokeDirectory,'user-data'));
  for(const key of ['DASHSCOPE_API_KEY','QWEN_API_KEY','ALIBABA_CODING_PLAN_API_KEY','TOKEN_PLAN_API_KEY','ALIBABA_TOKEN_PLAN_API_KEY','GRSAI_API_KEY','MINIMAX_API_KEY','XIONGMAO_API_KEY','XIONGMAO_MINIMAXH3_API_KEY','ARK_API_KEY'])delete process.env[key];
  delete process.env.FFMPEG_BIN;
}
const gotLock=app.requestSingleInstanceLock();
if(!gotLock)app.quit();
else {
  app.on('second-instance',()=>{const win=BrowserWindow.getAllWindows()[0];if(win){if(win.isMinimized())win.restore();win.focus();}});
  app.whenReady().then(async()=>{
    const target=resolveClientTarget({isPackaged:app.isPackaged,smokeDirectory});
    if(target.mode==='local'){
      const dataDir=path.join(app.getPath('userData'),'studio');
      // Local mode is used for development and isolated smoke tests. Packaged
      // releases use the cloud target so web and desktop share one workspace.
      const applicationRoot=app.isPackaged?path.dirname(process.execPath):path.resolve(__dirname,'..');
      let outputDir=process.env.AI_FRAME_OUTPUT_DIR|| (smokeDirectory?path.join(smokeDirectory,'output'):path.join(applicationRoot,'output'));
      if(!path.isAbsolute(outputDir))throw new Error('AI_FRAME_OUTPUT_DIR must be an absolute path.');
      try{await fs.mkdir(outputDir,{recursive:true});}catch{outputDir=path.join(app.getPath('userData'),'output');await fs.mkdir(outputDir,{recursive:true});}
      await fs.mkdir(dataDir,{recursive:true});
      const secure=safeStorage.isEncryptionAvailable()&&process.platform==='win32';
      const accountFile=key=>{if(!/^[a-f0-9]{64}$/.test(key))throw new Error('Invalid account storage key');return path.join(dataDir,'accounts',key,'credentials.enc');};
      const saveEncrypted=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.tmp';await fs.writeFile(temp,safeStorage.encryptString(JSON.stringify(value)));await fs.rename(temp,file);};
      const loadCredentials=secure?async(key)=>{try{return JSON.parse(safeStorage.decryptString(await fs.readFile(accountFile(key))));}catch(e){if(e.code==='ENOENT')return {};throw new Error('无法读取本机加密凭据，请恢复凭据文件后重试。');}}:undefined;
      const saveCredentials=secure?async(key,settings)=>saveEncrypted(accountFile(key),settings):undefined;
      const authFile=path.join(dataDir,'auth-sessions.enc');
      const readAuthSessions=async()=>{try{const value=JSON.parse(safeStorage.decryptString(await fs.readFile(authFile)));return value?.version===2&&value.sessions&&typeof value.sessions==='object'&&!Array.isArray(value.sessions)?value.sessions:{};}catch(error){if(error.code==='ENOENT')return {};return {};}};
      let authWrite=Promise.resolve();
      const updateAuthSessions=operation=>{const result=authWrite.then(async()=>{const sessions=await readAuthSessions();await operation(sessions);if(Object.keys(sessions).length)await saveEncrypted(authFile,{version:2,sessions});else await fs.rm(authFile,{force:true});});authWrite=result.catch(()=>{});return result;};
      const loadAuth=secure?async(sessionId)=>{if(!/^[a-f0-9]{64}$/.test(sessionId))throw new Error('Invalid local session ID.');return (await readAuthSessions())[sessionId]||null;}:undefined;
      const saveAuth=secure?async(sessionId,session)=>{if(!/^[a-f0-9]{64}$/.test(sessionId))throw new Error('Invalid local session ID.');return updateAuthSessions(sessions=>{if(session===null)delete sessions[sessionId];else sessions[sessionId]=session;});}:undefined;
      const {startApp}=await import(pathToFileURL(path.join(__dirname,'../server/index.mjs')).href);
      backend=await startApp({dataDir,outputRoot:outputDir,loadCredentials,saveCredentials,loadAuth,saveAuth});
    }
    const targetUrl=backend?.url||target.url;
    const updater=createUpdater({currentVersion:app.getVersion()});
    const projectFolderStore=createProjectFolderStore(path.join(app.getPath('userData'),'project-folders.json'));
    const localProjectStorage=createLocalProjectStorage();
    let pendingUpdate=null;
    ipcMain.on('app:get-version-sync',event=>{event.returnValue=app.getVersion();});
    ipcMain.on('app:get-display-version-sync',event=>{event.returnValue=clientDisplayVersion;});
    ipcMain.handle('app:check-update',async()=>{pendingUpdate=await updater.checkForUpdate();return pendingUpdate;});
    ipcMain.handle('app:install-update',async()=>{
      if(!pendingUpdate?.available)throw new Error('当前没有可安装的更新');
      const result=await updater.installUpdate(pendingUpdate);
      setTimeout(()=>app.quit(),1000);
      return result;
    });
    ipcMain.handle('notification:show',async(_event,payload)=>{
      const title=typeof payload?.title==='string'&&payload.title.trim()?payload.title.trim():'映序任务通知';
      const body=typeof payload?.body==='string'&&payload.body.trim()?payload.body.trim():'任务状态已更新。';
      const tag=typeof payload?.tag==='string'&&payload.tag.trim()?payload.tag.trim():'aiframe-task';
      new Notification({title,body,silent:true}).show();
      return Boolean(tag);
    });
    const titleBarOverlay=process.platform==='win32'?{color:'#171b18',symbolColor:'#bcedce',height:36}:null;
    const win=new BrowserWindow({width:1520,height:980,minWidth:960,minHeight:680,show:!smokeDirectory,backgroundColor:'#171b18',title:'映序 · 小说短剧工作台',autoHideMenuBar:true,titleBarStyle:process.platform==='win32'?'hidden':'default',titleBarOverlay:titleBarOverlay||false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    // Re-apply the overlay after construction for packaged Windows builds.
    // Some Windows/Electron combinations otherwise paint the native area white.
    if(titleBarOverlay&&typeof win.setTitleBarOverlay==='function'){
      try{win.setTitleBarOverlay(titleBarOverlay);}catch{}
    }
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    const targetOrigin=new URL(targetUrl).origin;
    win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==targetOrigin)event.preventDefault();});
    ipcMain.handle('project:get-folder',async(_event,payload)=>projectFolderStore.get(payload?.accountKey,payload?.projectId));
    ipcMain.handle('project:choose-folder',async(_event,payload)=>{
      const previous=await projectFolderStore.get(payload?.accountKey,payload?.projectId);
      const result=await dialog.showOpenDialog(win,{title:`选择“${typeof payload?.projectTitle==='string'&&payload.projectTitle.trim()?payload.projectTitle.trim():'项目'}”本地文件夹`,defaultPath:previous?.path,properties:['openDirectory','createDirectory']});
      if(result.canceled||!result.filePaths[0])return null;
      await localProjectStorage.prepare(result.filePaths[0]);
      return projectFolderStore.set(payload.accountKey,payload.projectId,result.filePaths[0]);
    });
    ipcMain.handle('project:sync-assets',async(_event,payload)=>{
      const folder=await projectFolderStore.get(payload?.accountKey,payload?.projectId);
      if(!folder)throw new Error('请先选择本地项目文件夹。');
      const result=await localProjectStorage.sync({...payload,root:folder.path,targetBaseUrl:targetUrl});
      const updated=await projectFolderStore.update(payload.accountKey,payload.projectId,{lastSyncAt:result.syncedAt,remoteVideoCleanupAt:null});
      return {...result,folder:updated};
    });
    ipcMain.handle('project:mark-cleaned',async(_event,payload)=>{
      const folder=await projectFolderStore.get(payload?.accountKey,payload?.projectId);
      if(!folder)throw new Error('请先选择本地项目文件夹。');
      const status=await localProjectStorage.markCleaned(folder.path,payload.projectId,Number(payload.videoCount)||0,payload.snapshot);
      return {status,folder:await projectFolderStore.update(payload.accountKey,payload.projectId,{remoteVideoCleanupAt:status.cleanedAt})};
    });
    await win.loadURL(targetUrl);
    if(smokeDirectory){
      await require('./smoke.cjs')({app,win,backend,directory:smokeDirectory});
      app.quit();
    }
  }).catch(async error=>{
    if(smokeDirectory){
      await fs.mkdir(smokeDirectory,{recursive:true});
      await fs.writeFile(path.join(smokeDirectory,'result.json'),JSON.stringify({ok:false,code:error.code||error.message?.match(/^SMOKE_[A-Z_]+$/)?.[0]||'SMOKE_STARTUP_FAILED'}));
    }else dialog.showErrorBox('映序启动失败',error.message?.includes('凭据')||error.code==='DATA_IN_USE'?error.message:app.isPackaged?'请检查本机数据目录是否可读写，或重新下载完整应用。':'请先执行 npm run build，并检查本机数据目录是否可读写。');
    app.quit();
  });
  app.on('window-all-closed',()=>app.quit());
  let closing=false;
  app.on('before-quit',event=>{if(backend&&!closing){event.preventDefault();closing=true;backend.close().finally(()=>app.quit());}});
}

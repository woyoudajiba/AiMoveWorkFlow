const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');

// Explicit local diagnostics only: use fresh userData and never submit model jobs.
module.exports=async function runSmoke({app,win,backend,directory}){
  const headers={'X-Local-Client':'aiframe'};
  const authResponse=await fetch(`${backend.url}/api/auth/status`,{headers});
  if(!authResponse.ok)throw new Error('SMOKE_AUTH_HTTP');
  const auth=await authResponse.json();
  if(auth.authenticated||auth.user||auth.sessionId||auth.remembered||!auth.rememberAvailable)throw new Error('SMOKE_AUTH_ISOLATION');
  for(const route of ['/api/config','/api/state','/api/board-templates','/media/missing.png']){
    if((await fetch(`${backend.url}${route}`,{headers})).status!==401)throw new Error('SMOKE_AUTH_BOUNDARY');
  }
  // Inspect packaged catalog code separately. Production HTTP is never bypassed for smoke tests.
  const {createConfig}=await import(pathToFileURL(path.join(__dirname,'../server/config.mjs')).href);
  const config=(await createConfig({env:{}})).public();
  if(config.llmConfigured||config.codingPlanConfigured||config.tokenPlanConfigured||config.grsaiConfigured||config.minimaxConfigured||config.xiongmaoMinimaxH3Configured||config.arkConfigured)throw new Error('SMOKE_CREDENTIAL_ISOLATION');
  const sharp=require('sharp');
  const png=await sharp({create:{width:64,height:96,channels:4,background:'#c8f28c'}}).png().toBuffer();
  const metadata=await sharp(png).metadata();
  if(metadata.width!==64||metadata.height!==96||metadata.format!=='png')throw new Error('SMOKE_SHARP');
  await fs.writeFile(path.join(directory,'test-image.png'),png);
  const {runProcess,probeVideo}=await import(pathToFileURL(path.join(__dirname,'../server/media.mjs')).href);
  const videoPath=path.join(directory,'test-video.mp4');
  await runProcess(require('ffmpeg-static'),['-v','error','-y','-f','lavfi','-i','color=c=black:s=144x256:r=30','-t','1','-an','-c:v','libx264','-pix_fmt','yuv420p',videoPath]);
  const video=await probeVideo(videoPath,{decode:true});
  if(video.width!==144||video.height!==256||video.duration<0.9)throw new Error('SMOKE_FFMPEG');
  const deadline=Date.now()+15000;
  let page;
  do {
    page=await win.webContents.executeJavaScript(`({title:document.title,text:document.querySelector('#root')?.innerText||'',ready:Boolean(document.querySelector('input[type=password]')),desktop:Boolean(window.aiframeDesktop&&typeof window.aiframeDesktop.checkForUpdate==='function'&&typeof window.aiframeDesktop.installUpdate==='function'),version:window.aiframeDesktop?.version||''})`);
    if(page.ready&&page.text.length>50)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }while(Date.now()<deadline);
  if(!page.ready||page.text.length<=50||!page.desktop||page.version!==app.getVersion())throw new Error('SMOKE_UI_RENDER');
  await fs.writeFile(path.join(directory,'window.png'),(await win.webContents.capturePage()).toPNG());
  await fs.writeFile(path.join(directory,'result.json'),JSON.stringify({ok:true,packaged:app.isPackaged,appVersion:app.getVersion(),userData:app.getPath('userData'),auth:{authenticated:false,rememberAvailable:auth.rememberAvailable,protectedRoutes:true},config:{llmModel:config.llmModel,llmModels:config.llmModels},png:{width:metadata.width,height:metadata.height},video,page:{title:page.title,rendered:true,screen:'login'}},null,2));
};

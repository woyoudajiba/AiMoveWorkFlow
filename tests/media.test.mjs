import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, rename, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { createMediaStore, resolveMediaPath, runProcess, probeVideo } from '../server/media.mjs';

test('uploads decode images and refuse traversal, cross-project assets and disguised files',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-media-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createMediaStore(root); const project={id:'one'};
  await assert.rejects(store.importImage(project,'data:image/png;base64,PGh0bWw+YmFkPC9odG1sPg=='),/图片/);
  const png=await sharp({create:{width:256,height:256,channels:3,background:'#b36f53'}}).png().toBuffer();
  const url=await store.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const disk=await resolveMediaPath(root,'one',url);
  assert.equal((await sharp(disk).metadata()).format,'png');
  for(const evil of ['/media/one/../two/x.png','/media/two/x.png','/media/one/%2e%2e/x.png','C:/private.png']) await assert.rejects(resolveMediaPath(root,'one',evil));
  assert.ok((await store.imageDataUrl(project,url)).startsWith('data:image/png;base64,'));
});

test('downloaded provider videos are normalized to browser-compatible H264 MP4', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-video-normalize-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'provider-video.mp4');
  await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=24:d=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  const store = createMediaStore(path.join(root, 'media'), { download: async () => readFile(source) });
  const project = { id: 'normalize-project' };
  const url = await store.downloadVideo(project, 'https://provider.example/video', { duration: 1, trimStart: 0 }, { minDuration: 1 });
  const file = await resolveMediaPath(path.join(root, 'media'), project.id, url);
  const streams = JSON.parse(await runProcess(ffprobeStatic.path, ['-v', 'error', '-show_streams', '-of', 'json', file])).streams;
  const video = streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal((await readdir(path.dirname(file))).some(name => name.includes('.tmp')), false);
});

test('provider audio is retained during local normalization', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-video-mute-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'provider-video-with-audio.mp4');
  await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=24:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  const store = createMediaStore(path.join(root, 'media'), { download: async () => readFile(source) });
  const project = { id: 'audio-preserved-project' };
  const url = await store.downloadVideo(project, 'https://provider.example/video', { duration: 1, trimStart: 0 }, { minDuration: 1 });
  const file = await resolveMediaPath(path.join(root, 'media'), project.id, url);
  const streams = JSON.parse(await runProcess(ffprobeStatic.path, ['-v', 'error', '-show_streams', '-of', 'json', file])).streams;
  assert.equal(streams.some(stream => stream.codec_type === 'audio'), true);
});

test('declared dialogue audio is retained during local normalization', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-video-audio-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'provider-video-with-dialogue.mp4');
  await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=24:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  const store = createMediaStore(path.join(root, 'media'), { download: async () => readFile(source) });
  const project = { id: 'audio-project' };
  const url = await store.downloadVideo(project, 'https://provider.example/video', { duration: 1, trimStart: 0 }, { minDuration: 1 });
  const file = await resolveMediaPath(path.join(root, 'media'), project.id, url);
  const streams = JSON.parse(await runProcess(ffprobeStatic.path, ['-v', 'error', '-show_streams', '-of', 'json', file])).streams;
  assert.equal(streams.some(stream => stream.codec_type === 'audio'), true);
});

test('project export preserves provider audio across segment-board parts', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-project-audio-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMediaStore(root);
  const project = { id: 'project-audio', title: '有声项目', aspectRatio: '16:9', generationMode: 'segment-board' };
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#46716b' } }).png().toBuffer();
  const image = await store.importImage(project, `data:image/png;base64,${png.toString('base64')}`);
  const withAudio = path.join(root, project.id, 'with-audio.mp4');
  const silent = path.join(root, project.id, 'silent.mp4');
  await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', withAudio]);
  await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  const segments = [
    { id: 'seg-1', number: 1, title: '有声片段', duration: 2, video: `/media/${project.id}/with-audio.mp4`, videoVersion: 1, shots: [{ id: 'shot-1', number: 1, image, duration: 2, dialogue: '开始', scene: '场景', action: '动作', camera: '中景' }] },
    { id: 'seg-2', number: 2, title: '无对白片段', duration: 2, video: `/media/${project.id}/silent.mp4`, videoVersion: 1, shots: [{ id: 'shot-2', number: 1, image, duration: 2, dialogue: '', scene: '场景', action: '动作', camera: '中景' }] },
  ];
  const result = await store.exportProject(project, segments);
  const output = await resolveMediaPath(root, project.id, result.videoUrl);
  const info = await probeVideo(output, { decode: true, minDuration: 3.9 });
  assert.ok(info.hasAudio);
  const manifest = JSON.parse(await readFile(await resolveMediaPath(root, project.id, result.manifestUrl), 'utf8'));
  assert.equal(manifest.audio, 'present');
  assert.ok(Math.abs(info.duration - 4) < 0.15);
});

test('legacy project export preserves audio while concatenating shot clips', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-legacy-project-audio-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMediaStore(root);
  const project = { id: 'legacy-project-audio', title: '旧式有声项目', aspectRatio: '16:9' };
  const png = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#46716b' } }).png().toBuffer();
  const image = await store.importImage(project, `data:image/png;base64,${png.toString('base64')}`);
  const withAudio = path.join(root, project.id, 'shot-audio.mp4');
  const silent = path.join(root, project.id, 'shot-silent.mp4');
  await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', withAudio]);
  await runProcess(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
  const segment = { id: 'legacy-segment', number: 1, title: '旧式片段', duration: 2, shots: [
    { id: 'legacy-shot-1', number: 1, duration: 1, trimStart: 0, image, video: `/media/${project.id}/shot-audio.mp4`, version: 1, videoVersion: 1, approved: true, scene: '场景', action: '动作', camera: '中景', dialogue: '开始', characterIds: [] },
    { id: 'legacy-shot-2', number: 2, duration: 1, trimStart: 0, image, video: `/media/${project.id}/shot-silent.mp4`, version: 1, videoVersion: 1, approved: true, scene: '场景', action: '动作', camera: '中景', dialogue: '', characterIds: [] },
  ] };
  const result = await store.exportProject(project, [segment]);
  const output = await resolveMediaPath(root, project.id, result.videoUrl);
  const info = await probeVideo(output, { decode: true, minDuration: 1.9 });
  assert.ok(info.hasAudio);
  const manifest = JSON.parse(await readFile(await resolveMediaPath(root, project.id, result.manifestUrl), 'utf8'));
  assert.equal(manifest.audio, 'present');
  assert.ok(Math.abs(info.duration - 2) < 0.15);
});

test('export requires all nine current shots and creates decodable numbered files plus mapping',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-export-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createMediaStore(root);const project={id:'export-project',title:'测试小说',aspectRatio:'16:9'};
  const png=await sharp({create:{width:320,height:180,channels:3,background:'#46716b'}}).png().toBuffer();
  const image=await store.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const source=path.join(root,project.id,'source.mp4');
  await runProcess(ffmpeg,['-y','-f','lavfi','-i','color=c=red:s=320x180:r=30:d=2.5','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const shots=Array.from({length:9},(_,index)=>({id:`s${index}`,number:index+1,duration:index===8?1.64:1.67,trimStart:0.4,scene:'巷口',action:'回头',camera:'近景',dialogue:index?'你好':'=危险公式',characterIds:[],image,video:`/media/${project.id}/source.mp4`,version:1,videoVersion:1,approved:true}));
  const segment={id:'seg1',number:1,title:'第一段',duration:15,shots};
  await assert.rejects(store.exportSegment(project,{...segment,shots:shots.slice(0,8)}),/9/);
  await assert.rejects(store.exportSegment(project,{...segment,shots:shots.map((s,i)=>i? s:{...s,videoVersion:0})}),/版本/);
  const result=await store.exportSegment(project,segment);
  assert.ok(result.videoUrl.endsWith('/001.mp4')); assert.ok(result.gridUrl.endsWith('/001.jpg'));
  const info=await probeVideo(await resolveMediaPath(root,project.id,result.videoUrl));
  assert.ok(Math.abs(info.duration-15)<0.1);assert.equal(info.width,1280);assert.equal(info.height,720);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  assert.equal(manifest.shots.length,9);assert.equal(manifest.audio,'muted');
  assert.equal(manifest.layout.kind,'landscape-scene-board');assert.ok(manifest.layout.width>manifest.layout.height);
  const csv=await readFile(await resolveMediaPath(root,project.id,result.csvUrl),'utf8');assert.ok(csv.includes("'=危险公式"));
  assert.equal((await sharp(await resolveMediaPath(root,project.id,result.gridUrl)).metadata()).format,'jpeg');
  await writeFile(source,'not video');
  await assert.rejects(store.exportSegment(project,segment),/视频/);
});

test('segment-board preview accepts a content-sized automatic duration below fifteen seconds', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'aiframe-auto-duration-preview-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createMediaStore(root);
  const project = { id: 'auto-preview', title: '短片段', aspectRatio: '9:16', generationMode: 'segment-board', durationMode: 'auto', style: '电影', characters: [], scenes: [{ id: 's1', name: '车站', description: '夜晚站台' }], looks: [] };
  const png = await sharp({ create: { width: 180, height: 320, channels: 3, background: '#46716b' } }).png().toBuffer();
  const image = await store.importImage(project, `data:image/png;base64,${png.toString('base64')}`);
  const segment = { id: 'seg-auto', number: 1, title: '三镜头', summary: '短促动作', duration: 9, boardTemplateId: 'classic-nine', shots: Array.from({ length: 3 }, (_, index) => ({ id: `shot-${index + 1}`, number: index + 1, sceneId: 's1', scene: '车站', action: '回头', camera: '近景', dialogue: '', characterIds: [], duration: 3, image, approved: false, version: 1, imageVersion: 1 })) };
  const preview = await store.exportStoryboardPreview(project, segment);
  assert.equal(preview.duration, 9);
  assert.ok(preview.gridUrl.endsWith('.jpg'));
});

test('completed exports can be mirrored into an output root without moving server media',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-output-media-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const output=path.join(root,'output');
  const store=createMediaStore(path.join(root,'media'),{outputRoot:output});
  const project={id:'output-project',title:'输出保留',aspectRatio:'9:16'};
  const png=await sharp({create:{width:180,height:320,channels:3,background:'#46716b'}}).png().toBuffer();
  const mediaUrl=await store.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const source=path.join(root,'media',project.id,'source.mp4');
  await runProcess(ffmpeg,['-y','-f','lavfi','-i','color=c=red:s=180x320:r=30:d=2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const shots=Array.from({length:9},(_,index)=>({id:`s${index}`,number:index+1,duration:index===8?1.64:1.67,trimStart:0,scene:'巷口',action:'回头',camera:'近景',dialogue:'',characterIds:[],image:mediaUrl,video:`/media/${project.id}/source.mp4`,version:1,videoVersion:1,approved:true}));
  const result=await store.exportSegment(project,{id:'seg-output',number:1,title:'第一段',duration:15,shots});
  const mirrored=await store.copyExport(project,result);
  assert.equal(mirrored.status,'saved');
  assert.match(mirrored.directory,/^output\/output-project\/export-[A-Za-z0-9-]+$/);
  for(const file of mirrored.files)assert.ok((await stat(path.join(root,file))).isFile(),file);
  assert.ok((await stat(await resolveMediaPath(path.join(root,'media'),project.id,result.videoUrl))).isFile());
  const repeated=await store.copyExport(project,result);assert.deepEqual(repeated,mirrored);
  // A prior interrupted copy must be rebuilt instead of being accepted merely
  // because its destination directory exists.
  await rm(path.join(root,mirrored.files[0]),{force:true});
  const repaired=await store.copyExport(project,result);
  assert.deepEqual(repaired,mirrored);
  for(const file of mirrored.files)assert.ok((await stat(path.join(root,file))).isFile(),file);
  const retryOutput=path.join(root,'retry-output');let renameCalls=0;
  const retryStore=createMediaStore(path.join(root,'media'),{outputRoot:retryOutput,renameDirectory:async(from,to)=>{
    if(++renameCalls===1){const error=new Error('scanner lock');error.code='EPERM';throw error;}
    return rename(from,to);
  }});
  const retried=await retryStore.copyExport(project,result);
  assert.deepEqual(retried,repaired);
  assert.equal(renameCalls,2);
  assert.ok((await stat(path.join(retryOutput,project.id,result.videoUrl.split('/').at(-2),result.videoUrl.split('/').at(-1)))).isFile());
  assert.deepEqual((await readdir(path.join(retryOutput,project.id))).filter(name=>name.includes('.tmp')),[]);
  const failedOutput=path.join(root,'failed-output');let failedRenameCalls=0;
  const failedStore=createMediaStore(path.join(root,'media'),{outputRoot:failedOutput,renameDirectory:async(from,to)=>{
    if(++failedRenameCalls===1){const error=new Error('scanner lock');error.code='EPERM';throw error;}
    return rename(from,to);
  },copyFileImpl:async(from,to)=>{
    if(to.includes('.publish.tmp'))throw new Error('copy interrupted');
    return copyFile(from,to);
  }});
  await assert.rejects(failedStore.copyExport(project,result));
  assert.deepEqual((await readdir(path.join(failedOutput,project.id))).filter(name=>name.startsWith('export-')||name.includes('.tmp')),[]);
  const unsafe=createMediaStore(path.join(root,'media'),{outputRoot:path.join(root,'media','output')});
  await assert.rejects(unsafe.copyExport(project,result),error=>error.code==='OUTPUT_COPY_FAILED');
});

test('storyboard preview exports nine unapproved stills and a complete review mapping without videos',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createMediaStore(root);
  const project={id:'preview-project',title:'人审预览',style:'电影',aspectRatio:'9:16',characters:[{id:'hero',name:'林遥',role:'protagonist',aliases:['小林'],appearance:'蓝色外套',evidence:'原文',reference:null,approved:false,version:2}]};
  const png=await sharp({create:{width:180,height:320,channels:3,background:'#3165ad'}}).png().toBuffer();
  const image=await store.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const shots=Array.from({length:9},(_,i)=>({id:`s${i+1}`,number:i+1,duration:i===8?1.64:1.67,trimStart:0,scene:`场景${i+1}`,action:'拿起旧车票',camera:'近景',dialogue:i?'你回来了': '=待审台词',characterIds:['hero'],image,video:null,version:i+1,videoVersion:null,approved:false}));
  const segment={id:'seg-preview',number:3,title:'第三段',summary:'雨停之前',duration:15,shots:[...shots].reverse()};
  const before=structuredClone({project,segment});
  const result=await store.exportStoryboardPreview(project,segment);
  assert.equal(result.number,3);assert.equal(result.segmentId,'seg-preview');
  assert.ok(result.gridUrl.endsWith('/003-01.jpg'));assert.equal('videoUrl' in result,false);
  assert.equal(result.pages.length,9);assert.deepEqual(result.pages.flatMap(page=>page.shotNumbers),[1,2,3,4,5,6,7,8,9]);
  const grid=await sharp(await resolveMediaPath(root,project.id,result.gridUrl)).metadata();
  assert.equal(grid.format,'jpeg');assert.ok(grid.width>grid.height);assert.ok(grid.width*grid.height<=12_000_000);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  assert.equal(manifest.kind,'storyboard-preview');assert.equal(manifest.requiresReview,true);
  assert.deepEqual(manifest.shots.map(s=>s.number),[1,2,3,4,5,6,7,8,9]);
  assert.equal(manifest.shots[0].scene,'场景1');assert.equal(manifest.shots[0].action,'拿起旧车票');
  assert.equal(manifest.shots[0].camera,'近景');assert.equal(manifest.shots[0].dialogue,'=待审台词');
  assert.deepEqual(manifest.shots[0].characterIds,['hero']);assert.equal(manifest.shots[0].approved,false);
  assert.equal(manifest.characters[0].name,'林遥');assert.equal(manifest.characters[0].version,2);assert.equal(manifest.characters[0].approved,false);
  assert.equal(manifest.layout.kind,'landscape-scene-board');assert.equal(manifest.layout.shotAspectRatio,'9:16');
  assert.equal(manifest.looks[0].id,null);assert.equal(manifest.looks[0].reference,null);assert.equal(manifest.looks[0].missingReason,'scene_missing');
  const csv=await readFile(await resolveMediaPath(root,project.id,result.csvUrl),'utf8');
  assert.match(csv,/林遥/);assert.match(csv,/未审核/);assert.match(csv,/'=待审台词/);
  assert.deepEqual({project,segment},before);
  const entries=await readdir(path.dirname(await resolveMediaPath(root,project.id,result.gridUrl)));
  assert.equal(entries.length,result.pages.length+2);assert.ok(entries.every(name=>!name.endsWith('.mp4')));
});

async function sceneBoardFixture(t,prefix='scene-board-'){
  const root=await mkdtemp(path.join(tmpdir(),prefix));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createMediaStore(root);
  const project={id:'scene-board',workflowVersion:2,title:'换装 & 三视图 <检查>',aspectRatio:'9:16',style:'电影',characters:[],scenes:[{id:'station',name:'雨夜车站',description:'第一场，蓝外套'},{id:'home',name:'清晨家中',description:'第二场，白衬衣'}],looks:[]};
  const png=await sharp({create:{width:180,height:320,channels:3,background:'#365f92'}}).png().toBuffer();
  const image=await store.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const sheet=await sharp({create:{width:960,height:400,channels:3,background:'#e4ccb5'}}).png().toBuffer();
  const reference=await store.importImage(project,`data:image/png;base64,${sheet.toString('base64')}`);
  project.characters=[{id:'hero',name:'林遥',role:'protagonist',appearance:'固定身份',reference:image,referenceVersion:1,version:1,approved:true},{id:'support',name:'顾川',role:'supporting',reference:image,referenceVersion:1,version:1,approved:true}];
  project.looks=project.scenes.flatMap(scene=>project.characters.map(character=>({id:`${scene.id}-${character.id}`,sceneId:scene.id,characterId:character.id,name:`${scene.name}造型`,appearance:scene.id==='station'?'深蓝色外套，侧身挎包':'白衬衣，袖口卷起',reference,referenceVersion:2,version:2,approved:true})));
  const segment={id:'segment',number:1,title:'雨停之后',duration:15,shots:Array.from({length:9},(_,i)=>({id:`s${i+1}`,number:i+1,duration:i===8?1.64:1.67,trimStart:0,sceneId:i<5?'station':'home',scene:i<5?'雨夜车站':'清晨家中',action:'抬头看向站牌 & <远处的人> '.repeat(18),camera:'近景，缓慢向前推',dialogue:i?'车要来了':'=台词 <script> & "原文"',characterIds:i<5?['hero','support']:['hero'],image,imageVersion:1,version:1,approved:true}))};
  return {root,store,project,segment,image};
}

test('landscape board includes every used scene look, full escaped text and current review evidence',async t=>{
  const {root,store,project,segment}=await sceneBoardFixture(t);
  const result=await store.exportStoryboardPreview(project,segment);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  const image=await sharp(await resolveMediaPath(root,project.id,result.gridUrl)).metadata();
  assert.ok(image.width>image.height);assert.equal(manifest.layout.width,image.width);assert.equal(manifest.layout.height,image.height);
  assert.equal(manifest.layout.lookColumns,1);assert.equal(manifest.layout.lookRows,2);
  assert.deepEqual(manifest.pages.map(page=>page.shotNumbers),[[1,2,3,4,5],[6,7,8,9]]);
  assert.ok(manifest.layout.tileWidth>=300);assert.ok(manifest.layout.leftWidth/image.width>0.5);
  assert.equal(manifest.layout.shotAspectRatio,'9:16');assert.equal(manifest.layout.imageFit,'contain');
  assert.deepEqual(manifest.scenes.map(scene=>scene.id),['station','home']);
  assert.deepEqual(manifest.looks.map(look=>look.id),['station-hero','station-support','home-hero']);
  assert.deepEqual(manifest.shots[5].lookIds,['home-hero']);assert.equal(manifest.shots[5].sceneId,'home');
  assert.equal(manifest.looks[0].characterName,'林遥');assert.equal(manifest.looks[0].sceneName,'雨夜车站');
  assert.equal(manifest.looks[0].referenceStatus,'current');assert.equal(manifest.requiresReview,false);
  assert.equal(manifest.shots[0].action,segment.shots[0].action);assert.equal(manifest.shots[0].dialogue,segment.shots[0].dialogue);
  assert.ok(manifest.layout.truncatedFields.some(item=>item.kind==='shot'&&item.id==='s1'&&item.field==='action'));
  const csv=await readFile(await resolveMediaPath(root,project.id,result.csvUrl),'utf8');
  assert.ok(csv.includes(segment.shots[0].action));assert.match(csv,/深蓝色外套，侧身挎包/);assert.match(csv,/home-hero/);assert.match(csv,/'=台词 <script> &/);
});

test('two scene looks use one full-height column while ordinary camera and action text remains readable',async t=>{
  const {root,store,project,segment}=await sceneBoardFixture(t);
  segment.shots.forEach(shot=>{shot.sceneId='station';shot.characterIds=['hero','support'];shot.camera='中近景，缓推，暖黄台灯光映照他的面部，背景是旧木质钟表与工具。';shot.action='顾川站在木柜台后，手中拿着软布正在擦拭怀表，他抬眼看见门外的林晚，将软布轻轻放在柜台上。';});
  const result=await store.exportStoryboardPreview(project,segment);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  assert.equal(manifest.layout.lookColumns,1);assert.equal(manifest.layout.lookRows,2);
  assert.ok(manifest.layout.lookCardHeight>manifest.layout.cardHeight);
  assert.equal(manifest.layout.textPlacement,'beside-shot-image');
  assert.ok(!manifest.layout.truncatedFields.some(field=>field.kind==='shot'&&['camera','action'].includes(field.field)));
  assert.ok(manifest.layout.width/manifest.layout.height<1.35);
});

test('missing, stale and unapproved looks cannot appear reviewed and identity portraits are never substituted',async t=>{
  const {root,store,project,segment}=await sceneBoardFixture(t);
  project.looks[0].reference=null;
  project.looks[1].referenceVersion=1;
  project.looks[2].approved=false;
  const result=await store.exportStoryboardPreview(project,segment);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  assert.equal(result.requiresReview,true);assert.equal(manifest.hasMissingReferences,true);assert.equal(manifest.hasStaleAssets,true);
  assert.equal(manifest.looks[0].reference,null);assert.equal(manifest.looks[0].referenceStatus,'missing');
  assert.equal(manifest.looks[1].referenceStatus,'stale');assert.equal(manifest.shots[0].reviewStatus,'needs_review');
  assert.equal(manifest.shots[5].reviewStatus,'needs_review');assert.equal(manifest.looks[2].approved,false);
});

test('current scene board still requires review if the base character identity is not confirmed',async t=>{
  const {root,store,project,segment}=await sceneBoardFixture(t);
  project.characters[0].approved=false;
  const result=await store.exportStoryboardPreview(project,segment);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  assert.equal(manifest.assetsCurrent,true);assert.equal(manifest.requiresReview,true);
  assert.equal(manifest.characters[0].reviewStatus,'needs_review');assert.equal(manifest.looks[0].identityApproved,false);
  assert.equal(manifest.looks[0].reviewStatus,'needs_review');assert.equal(manifest.shots[0].reviewStatus,'needs_review');
});

test('final portrait video export shares the scene board mapping and keeps text out of the video frame',async t=>{
  const {root,store,project,segment}=await sceneBoardFixture(t);
  segment.boardTemplateId='three-three';
  const source=path.join(root,project.id,'source.mp4');
  await runProcess(ffmpeg,['-y','-f','lavfi','-i','color=c=blue:s=180x320:r=30:d=2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  segment.shots.forEach(shot=>{shot.video=`/media/${project.id}/source.mp4`;shot.videoVersion=shot.version;});
  const result=await store.exportSegment(project,segment);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  assert.equal(manifest.width,720);assert.equal(manifest.height,1280);assert.equal(manifest.requiresReview,false);
  assert.equal(result.templateId,'three-three');assert.equal(result.pages.length,4);assert.ok(result.gridUrl.endsWith('/001-01.jpg'));assert.ok(result.videoUrl.endsWith('/001.mp4'));
  assert.deepEqual(result.pages.map(page=>page.shotNumbers),[[1,2,3],[4,5],[6,7,8],[9]]);
  assert.equal(manifest.layout.kind,'landscape-scene-board');assert.deepEqual(manifest.shots[5].lookIds,['home-hero']);
  assert.equal(manifest.shots[0].action,segment.shots[0].action);assert.equal(manifest.shots[0].plannedDuration,1.67);
  const frameFile=path.join(root,'video-frame.png');
  await runProcess(ffmpeg,['-v','error','-i',await resolveMediaPath(root,project.id,result.videoUrl),'-frames:v','1',frameFile]);
  const frame=sharp(frameFile);assert.equal((await frame.metadata()).width,720);
  assert.ok((await frame.stats()).channels.every(channel=>channel.stdev<1),'solid source video must remain uniform without board text, references or borders');
  project.looks[0].approved=false;
  await assert.rejects(store.exportSegment(project,segment),e=>e.code==='EXPORT_STALE');
});

test('board preserves all mappings across scene pages and rejects segment capacity or invalid references before publication',async t=>{
  const {root,store,project,segment}=await sceneBoardFixture(t);
  project.scenes=Array.from({length:9},(_,i)=>({id:`scene${i}`,name:`场景${i}`,description:''}));
  project.looks=project.scenes.flatMap(scene=>project.characters.map(character=>({...project.looks[0],id:`${scene.id}-${character.id}`,sceneId:scene.id,characterId:character.id})));
  segment.shots.forEach((shot,i)=>{shot.sceneId=project.scenes[i].id;shot.characterIds=['hero','support'];});
  const result=await store.exportStoryboardPreview(project,segment);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  assert.equal(manifest.looks.length,18);assert.equal(manifest.pages.length,9);assert.equal(manifest.layout.lookColumns,1);
  assert.equal(new Set(manifest.pages.flatMap(page=>page.lookIds)).size,18);
  assert.ok(manifest.layout.width*manifest.layout.height<=12_000_000);assert.ok(manifest.layout.width<=6144);
  const before=await readdir(path.join(root,project.id));
  project.characters.push({...project.characters[0],id:'third'});segment.shots[0].characterIds.push('third');
  await assert.rejects(store.exportStoryboardPreview(project,segment),e=>e.code==='BOARD_CAPACITY');
  assert.deepEqual(await readdir(path.join(root,project.id)),before);
  segment.shots[0].characterIds.pop();segment.shots[0].sceneId='unknown';
  await assert.rejects(store.exportStoryboardPreview(project,segment),e=>e.code==='INVALID_INPUT');
});

test('preview rejects incomplete or invalid media without publishing a partial artifact directory',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-preview-boundary-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createMediaStore(root);const project={id:'p',aspectRatio:'16:9',characters:[]};
  const png=await sharp({create:{width:64,height:64,channels:3,background:'red'}}).png().toBuffer();
  const image=await store.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  const segment={id:'s',number:1,title:'预览',duration:30,shots:Array.from({length:9},(_,i)=>({id:`s${i}`,number:i+1,duration:i===8?6:3,scene:'',action:'',camera:'',dialogue:'',characterIds:[],image,approved:false,version:1}))};
  await assert.rejects(store.exportStoryboardPreview(project,{...segment,shots:segment.shots.slice(0,8)}),/9/);
  await assert.rejects(store.exportStoryboardPreview(project,{...segment,shots:segment.shots.map((s,i)=>i?s:{...s,image:'/media/other/image.png'})}),/项目/);
  await writeFile(await resolveMediaPath(root,project.id,image),'corrupt image');
  await assert.rejects(store.exportStoryboardPreview(project,segment));
  assert.deepEqual((await readdir(path.join(root,project.id))).filter(name=>name.includes('preview-')),[]);
});

test('preview marks stale and unverified approved assets for review instead of presenting them as current',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'aiframe-preview-stale-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createMediaStore(root);const project={id:'p',title:'陈旧图片预览',aspectRatio:'16:9',characters:[]};
  const png=await sharp({create:{width:64,height:64,channels:3,background:'blue'}}).png().toBuffer();
  const image=await store.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  project.characters=[{id:'old-reference',name:'旧定妆',role:'protagonist',reference:image,version:2,referenceVersion:1,approved:true},{id:'unknown-reference',name:'未知定妆版本',role:'supporting',reference:image,version:1,approved:true}];
  const segment={id:'s',number:1,title:'预览',duration:30,shots:Array.from({length:9},(_,i)=>({id:`s${i}`,number:i+1,duration:i===8?6:3,scene:'',action:'',camera:'',dialogue:'',characterIds:['old-reference','unknown-reference'],image,approved:true,version:2,...(i===1?{}:{imageVersion:i===0?1:2})}))};
  const result=await store.exportStoryboardPreview(project,segment);
  const manifest=JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  assert.equal(result.requiresReview,true);assert.equal(manifest.requiresReview,true);assert.equal(manifest.reviewStatus,'needs_review');
  assert.equal(manifest.assetsCurrent,false);assert.equal(manifest.hasStaleAssets,true);assert.equal(manifest.hasUnverifiedAssets,true);
  assert.equal(manifest.shots[0].imageCurrent,false);assert.equal(manifest.shots[0].imageStatus,'stale');assert.equal(manifest.shots[0].reviewStatus,'needs_review');
  assert.equal(manifest.shots[1].imageStatus,'unverified');assert.equal(manifest.shots[2].imageCurrent,true);
  assert.equal(manifest.characters[0].referenceCurrent,false);assert.equal(manifest.characters[0].referenceStatus,'stale');
  assert.equal(manifest.characters[1].referenceStatus,'unverified');
  const csv=await readFile(await resolveMediaPath(root,project.id,result.csvUrl),'utf8');
  assert.match(csv,/旧版图片/);assert.match(csv,/未验证版本/);
});

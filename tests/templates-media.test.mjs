import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {BOARD_TEMPLATES,DEFAULT_BOARD_TEMPLATE_ID,getBoardTemplate} from '../server/board-templates.mjs';
import {createMediaStore,resolveMediaPath} from '../server/media.mjs';
import {planBoardPages} from '../src/board-plan.ts';

function assertUiPlanMatchesExport(segment,result){
  const plan=planBoardPages(segment.shots,getBoardTemplate(result.templateId));
  assert.deepEqual(plan.pages,result.pages.map(page=>({number:page.number,shotNumbers:page.shotNumbers,lookCount:page.layout.lookCount,continuation:page.continuation,emptyShotSlots:page.layout.emptyShotSlots,emptyLookSlots:page.layout.emptyLookSlots})));
}

test('board template catalog exposes the three fixed choices and rejects unknown identifiers',()=>{
  assert.equal(DEFAULT_BOARD_TEMPLATE_ID,'classic-nine');
  assert.deepEqual(BOARD_TEMPLATES.map(t=>[t.id,t.shotCapacity,t.lookCapacity,t.shotColumns,t.shotRows]),[['classic-nine',9,2,3,3],['eight-one',8,1,4,2],['three-three',3,3,3,1]]);
  assert.equal(getBoardTemplate('classic-nine'),BOARD_TEMPLATES[0]);
  for(const id of ['unknown','../classic-nine',null,{}])assert.throws(()=>getBoardTemplate(id),error=>error.code==='INVALID_INPUT'&&error.status===400);
});

async function fixture(t){
  const root=await mkdtemp(path.join(tmpdir(),'board-template-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createMediaStore(root),project={id:'template-project',workflowVersion:2,title:'固定模板测试',aspectRatio:'9:16',characters:[],scenes:[{id:'a',name:'雨夜车站',description:'深蓝外套'},{id:'b',name:'清晨家中',description:'白衬衣'}],looks:[]};
  const png=await sharp({create:{width:180,height:320,channels:3,background:'#355a7b'}}).png().toBuffer();
  const image=await store.importImage(project,`data:image/png;base64,${png.toString('base64')}`);
  project.characters=['first','second','third'].map((id,i)=>({id,name:`角色${i+1}`,reference:image,referenceVersion:1,version:1,approved:true}));
  project.looks=project.scenes.flatMap(scene=>project.characters.map(c=>({id:`${scene.id}-${c.id}`,sceneId:scene.id,characterId:c.id,name:`${scene.name}造型`,appearance:scene.description,reference:image,referenceVersion:1,version:1,approved:true})));
  const segment={id:'segment',number:1,title:'分镜',duration:15,shots:Array.from({length:9},(_,i)=>({id:`shot${i+1}`,number:i+1,duration:i===8?1.64:1.67,sceneId:'a',scene:'雨夜车站',action:'抬头看向站牌',camera:'近景，固定机位',dialogue:'车快来了。',characterIds:['first'],image,imageVersion:1,version:1,approved:true}))};
  const manifest=async result=>JSON.parse(await readFile(await resolveMediaPath(root,project.id,result.manifestUrl),'utf8'));
  return {root,store,project,segment,manifest};
}

test('eight-one keeps the ninth shot on a second fixed page with explicit empty slots',async t=>{
  const {root,store,project,segment,manifest}=await fixture(t);const before=structuredClone(segment);
  const result=await store.exportStoryboardPreview(project,segment,{templateId:'eight-one'});
  assertUiPlanMatchesExport(segment,result);
  assert.equal(result.templateId,'eight-one');assert.equal(result.pages.length,2);
  assert.deepEqual(result.pages.map(page=>page.shotNumbers),[[1,2,3,4,5,6,7,8],[9]]);
  assert.ok(result.pages[0].gridUrl.endsWith('/001-01.jpg'));assert.ok(result.pages[1].gridUrl.endsWith('/001-02.jpg'));assert.equal(result.gridUrl,result.pages[0].gridUrl);
  assert.deepEqual(result.pages[0].layout.slots,result.pages[1].layout.slots);
  assert.equal(result.pages[1].layout.emptyShotSlots.length,7);assert.equal(result.pages[0].layout.shotCapacity,8);
  for(const page of result.pages){const size=await sharp(await resolveMediaPath(root,project.id,page.gridUrl)).metadata();assert.equal(size.width,page.layout.width);assert.equal(size.height,page.layout.height);assert.ok(size.width>size.height&&size.width*size.height<=12_000_000);}
  assert.equal((await manifest(result)).shots.length,9);assert.deepEqual(segment,before);
});

test('three-three produces three portrait-detail pages with three fixed look slots at the right',async t=>{
  const {store,project,segment}=await fixture(t);segment.boardTemplateId='three-three';
  segment.shots.slice(0,3).forEach(shot=>{shot.characterIds=['first','second','third'];});
  const result=await store.exportStoryboardPreview(project,segment);
  assertUiPlanMatchesExport(segment,result);
  assert.deepEqual(result.pages.map(page=>page.shotNumbers),[[1,2,3],[4,5,6],[7,8,9]]);
  assert.ok(result.pages.every(page=>page.layout.textPlacement==='below-shot-image'&&page.layout.lookCapacity===3));
  assert.deepEqual(result.pages.map(page=>page.lookIds),[['a-first','a-second','a-third'],['a-first'],['a-first']]);
  assert.deepEqual(result.pages.map(page=>page.layout.emptyLookSlots.length),[0,2,2]);
  const layout=result.pages[0].layout;assert.ok(layout.slots.looks.every(slot=>slot.x>layout.slots.shots.at(-1).x));
  assert.ok(layout.tileWidth>=600);for(const page of result.pages)assert.deepEqual(page.layout.slots,layout.slots);
});

test('extra scene looks use clearly marked continuation pages without dropping any actor',async t=>{
  const {store,project,segment,manifest}=await fixture(t);segment.shots.forEach(shot=>{shot.characterIds=['first','second','third'];});
  const result=await store.exportStoryboardPreview(project,segment,{templateId:'classic-nine'});
  assertUiPlanMatchesExport(segment,result);
  assert.equal(result.pages.length,2);assert.deepEqual(result.pages.map(page=>page.continuation),[false,true]);
  assert.deepEqual(result.pages[0].shotNumbers,result.pages[1].shotNumbers);
  assert.deepEqual(result.pages.flatMap(page=>page.lookIds),['a-first','a-second','a-third']);
  assert.equal(result.pages[1].layout.emptyLookSlots.length,1);
  const data=await manifest(result);assert.equal(data.pages.length,2);assert.equal(data.looks.length,3);assert.equal(data.shots.length,9);
});

test('noncontiguous appearances of a scene remain separate pages and never mix its other-scene wardrobe',async t=>{
  const {store,project,segment}=await fixture(t);segment.shots.forEach((shot,i)=>{shot.sceneId=i>=3&&i<6?'b':'a';});
  const result=await store.exportStoryboardPreview(project,segment);
  assertUiPlanMatchesExport(segment,result);
  assert.deepEqual(result.pages.map(page=>page.shotNumbers),[[1,2,3],[4,5,6],[7,8,9]]);
  assert.deepEqual(result.pages.map(page=>page.lookIds),[['a-first'],['b-first'],['a-first']]);
  assert.deepEqual(result.pages.map(page=>page.sceneId),['a','b','a']);
  assert.ok(result.pages.every(page=>!page.continuation));
});

test('per-call template overrides remain temporary and invalid templates publish no files',async t=>{
  const {root,store,project,segment}=await fixture(t);segment.boardTemplateId='three-three';
  const result=await store.exportStoryboardPreview(project,segment,{templateId:'classic-nine'});
  assert.equal(result.pages.length,1);assert.ok(result.gridUrl.endsWith('/001.jpg'));assert.equal(segment.boardTemplateId,'three-three');
  const before=await readdir(path.join(root,project.id));
  await assert.rejects(store.exportStoryboardPreview(project,segment,{templateId:'typo'}),error=>error.code==='INVALID_INPUT');
  assert.deepEqual(await readdir(path.join(root,project.id)),before);
});

test('explicit null template preference is invalid while an absent preference uses the default',async t=>{
  const {root,store,project,segment}=await fixture(t);segment.boardTemplateId=null;
  const before=await readdir(path.join(root,project.id));
  await assert.rejects(store.exportStoryboardPreview(project,segment),error=>error.code==='INVALID_INPUT');
  await assert.rejects(store.exportSegment(project,segment),error=>error.code==='INVALID_INPUT');
  assert.deepEqual(await readdir(path.join(root,project.id)),before);
  delete segment.boardTemplateId;
  assert.equal((await store.exportStoryboardPreview(project,segment)).templateId,'classic-nine');
});

test('wide unbroken names stay inside the character card and leave its next label clear',async t=>{
  const {root,store,project,segment,manifest}=await fixture(t);project.characters[0].name='M'.repeat(100);
  const result=await store.exportStoryboardPreview(project,segment);
  const page=result.pages[0],slot=page.layout.slots.looks[0];
  const file=await resolveMediaPath(root,project.id,page.gridUrl);
  const darkPixels=async region=>{
    const {data,info}=await sharp(file).extract(region).removeAlpha().raw().toBuffer({resolveWithObject:true});
    let count=0;for(let i=0;i<data.length;i+=info.channels)if(data[i]<120&&data[i+1]<120&&data[i+2]<120)count++;
    return count;
  };
  assert.equal(await darkPixels({left:slot.x+slot.width+2,top:slot.y+18,width:28,height:80}),0,'name must not render past the character card');
  assert.equal(await darkPixels({left:slot.x+18,top:slot.y+56,width:slot.width-36,height:4}),0,'name must leave a clear gap before the scene label');
  const data=await manifest(result);
  assert.equal(data.characters[0].name,project.characters[0].name);
  assert.ok(page.layout.truncatedFields.some(field=>field.kind==='look'&&field.field==='characterName'));
});

test('all templates constrain long ASCII headings and shot text while preserving full export text',async t=>{
  const {root,store,project,segment,manifest}=await fixture(t);
  project.title='W'.repeat(300);segment.title='M'.repeat(300);project.scenes[0].name='W'.repeat(100);
  project.characters[0].name='M'.repeat(100);
  project.looks[0].name='W'.repeat(100);project.looks[0].appearance='M'.repeat(2000);
  segment.shots.forEach(shot=>{shot.camera='W'.repeat(200);shot.action='M'.repeat(300);shot.dialogue='W'.repeat(150);});
  for(const template of BOARD_TEMPLATES){
    const result=await store.exportStoryboardPreview(project,segment,{templateId:template.id});
    for(const page of result.pages){
      const file=await resolveMediaPath(root,project.id,page.gridUrl);
      const {data,info}=await sharp(file).extract({left:page.layout.width-28,top:0,width:24,height:page.layout.height}).removeAlpha().raw().toBuffer({resolveWithObject:true});
      let darkPixels=0;for(let i=0;i<data.length;i+=info.channels)if(data[i]<120&&data[i+1]<120&&data[i+2]<120)darkPixels++;
      assert.equal(darkPixels,0,`${template.id} page ${page.number} must keep its outside margin clear`);
      for(const field of ['characterName','sceneName','name','appearance'])assert.ok(page.layout.truncatedFields.some(item=>item.kind==='look'&&item.field===field),`${template.id}: ${field} must be visibly truncated`);
    }
    const data=await manifest(result);
    assert.equal(data.projectTitle,project.title);assert.equal(data.title,segment.title);assert.equal(data.scenes[0].name,project.scenes[0].name);
    assert.equal(data.looks[0].appearance,project.looks[0].appearance);assert.equal(data.shots[0].camera,segment.shots[0].camera);assert.equal(data.shots[0].action,segment.shots[0].action);assert.equal(data.shots[0].dialogue,segment.shots[0].dialogue);
    const csv=await readFile(await resolveMediaPath(root,project.id,result.csvUrl),'utf8');assert.ok(csv.includes(segment.shots[0].action));assert.ok(csv.includes(project.looks[0].appearance));
  }
});

test('a bad reference on a later continuation page leaves no partial board export',async t=>{
  const {root,store,project,segment}=await fixture(t);segment.shots.forEach(shot=>{shot.characterIds=['first','second','third'];});
  project.looks.find(look=>look.id==='a-third').reference='/media/another-project/third.png';
  const before=await readdir(path.join(root,project.id));
  await assert.rejects(store.exportStoryboardPreview(project,segment),error=>error.code==='INVALID_PATH');
  assert.deepEqual(await readdir(path.join(root,project.id)),before);
});

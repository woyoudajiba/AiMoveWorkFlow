import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../server/config.mjs';

test('credentials are write-only and empty fields preserve existing keys', async () => {
  let stored;
  const config = await createConfig({env:{},save:async value=>{stored=value;},load:async()=>({}),ffmpegAvailable:true});
  await config.update({llmKey:'secret-fixture-value',llmModel:'qwen3.7-plus'});
  assert.equal(config.public().llmConfigured,true);
  assert.equal(config.public().credentialStorage,'encrypted');
  assert.equal(JSON.stringify(config.public()).includes('secret-fixture-value'),false);
  await config.update({llmKey:'',imageModel:'nano-banana-pro'});
  assert.equal(config.settings().llmKey,'secret-fixture-value');
  assert.equal(stored.llmKey,'secret-fixture-value');
});

test('invalid configuration cannot redirect credential-bearing requests', async () => {
  const config=await createConfig({env:{}});
  await assert.rejects(config.update({llmBaseUrl:'https://unexpected.test'}),/配置字段/);
  await assert.rejects(config.update({videoModel:'unsupported'}),/模型/);
  assert.equal(config.public().minimaxConfigured,false);
  assert.equal(config.public().minimaxConfigured,false);
  assert.equal(config.public().credentialStorage,'session');
});

test('MiniMax credentials are selectable without exposing the key', async () => {
  let stored;
  const config=await createConfig({env:{MINIMAX_API_KEY:'env-minimax-fixture'},save:async value=>{stored=value;}});
  assert.equal(config.public().minimaxConfigured,true);
  await config.update({videoModel:'MiniMax-H3-Max'});
  assert.equal(config.settings().videoModel,'MiniMax-H3-Max');
  assert.equal(stored.videoModel,'MiniMax-H3-Max');
  assert.equal(JSON.stringify(config.public()).includes('env-minimax-fixture'),false);
  const reloaded=await createConfig({env:{},load:async()=>stored});
  assert.equal(reloaded.public().minimaxConfigured,true);
  assert.equal(reloaded.public().videoModel,'MiniMax-H3-Max');
});

test('video model can be selected from the protected service environment', async () => {
  const config=await createConfig({env:{MINIMAX_API_KEY:'private-minimax-fixture',AIFRAME_VIDEO_MODEL:'MiniMax-H3'}});
  assert.equal(config.public().videoModel,'MiniMax-H3');
  await assert.rejects(createConfig({env:{AIFRAME_VIDEO_MODEL:'unknown-video-model'}}),/AIFRAME_VIDEO_MODEL/);
});

test('legacy video model settings fall back to MiniMax H3', async () => {
  const envConfig = await createConfig({ env: { AIFRAME_VIDEO_MODEL: 'seedance-2' } });
  assert.equal(envConfig.public().videoModel, 'MiniMax-H3');
  const storedConfig = await createConfig({ env: {}, load: async () => ({ videoModel: 'seedance-2' }) });
  assert.equal(storedConfig.public().videoModel, 'MiniMax-H3');
});

test('failed secure storage does not leave an apparently saved setting in memory', async () => {
  const config=await createConfig({env:{},save:async()=>{throw new Error('disk failed');}});
  await assert.rejects(config.update({minimaxKey:'test-value'}));
  assert.equal(config.public().minimaxConfigured,false);
});

test('concurrent credential changes preserve both services',async()=>{
  const config=await createConfig({env:{},save:async()=>{await new Promise(resolve=>setTimeout(resolve,5));}});
  await Promise.all([config.update({grsaiKey:'image-fixture'}),config.update({minimaxKey:'video-fixture'})]);
  assert.equal(config.public().grsaiConfigured,true);
  assert.equal(config.public().minimaxConfigured,true);
});

test('MiniMax credentials are write-only and H3 models are valid video presets',async()=>{
  let stored;
  const config=await createConfig({env:{MINIMAX_API_KEY:'private-minimax-fixture'},save:async value=>{stored=value;}});
  assert.equal(config.public().minimaxConfigured,true);
  for(const id of ['MiniMax-H3','MiniMax-H3-Max']) {
    await config.update({videoModel:id});
    assert.equal(config.settings().videoModel,id);
    assert.equal(stored.videoModel,id);
  }
  assert.equal(JSON.stringify(config.public()).includes('private-minimax-fixture'),false);
  await assert.rejects(config.update({videoModel:'minimax-h4'}),/模型/);
  await config.update({minimaxKey:''});
  assert.equal(config.settings().minimaxKey,'private-minimax-fixture');
  const reloaded=await createConfig({env:{},load:async()=>stored});
  assert.equal(reloaded.public().minimaxConfigured,true);
  assert.equal(reloaded.public().videoModel,'MiniMax-H3-Max');
});

test('Xiongmao MiniMax H3 credentials and model selection stay isolated', async () => {
  let stored;
  const config = await createConfig({ env: { XIONGMAO_MINIMAXH3_API_KEY: 'private-xiongmao-fixture' }, save: async value => { stored = value; } });
  assert.equal(config.public().xiongmaoMinimaxH3Configured, true);
  assert.ok(config.public().videoOptions.some(option => option.id === 'xiongmao-minimaxh3' && option.provider === '熊猫Ai'));
  await config.update({ videoModel: 'xiongmao-minimaxh3' });
  assert.equal(config.settings().videoModel, 'xiongmao-minimaxh3');
  assert.equal(stored.videoModel, 'xiongmao-minimaxh3');
  assert.equal(JSON.stringify(config.public()).includes('private-xiongmao-fixture'), false);
  const reloaded = await createConfig({ env: {}, load: async () => stored });
  assert.equal(reloaded.public().xiongmaoMinimaxH3Configured, true);
  assert.equal(reloaded.settings().xiongmaoMinimaxH3Key, 'private-xiongmao-fixture');
  await assert.rejects(reloaded.update({ xiongmaoMinimaxH3Key: 'bad\nkey' }), /密钥/);
});

test('Xiongmao Seedance official variants share the relay credential and remain write-only', async () => {
  let stored;
  const config = await createConfig({ env: { XIONGMAO_API_KEY: 'private-xiongmao-seedance-fixture' }, save: async value => { stored = value; } });
  for (const id of [
    'xiongmao-seedance-2-0-official', 'xiongmao-seedance-2-0-official-fast', 'xiongmao-seedance-2-0-official-mini',
    'xiongmao-seedance-2-0-promo', 'xiongmao-seedance-2-0-promo-fast', 'xiongmao-seedance-2-0-promo-mini',
    'xiongmao-seedance-2-0-special', 'xiongmao-seedance-2-0-special-fast', 'xiongmao-seedance-2-0-special-mini',
    'xiongmao-seedance-2-5-special',
  ]) {
    await config.update({ videoModel: id });
    assert.equal(config.settings().videoModel, id);
    assert.equal(stored.videoModel, id);
  }
  assert.equal(config.public().xiongmaoMinimaxH3Configured, true);
  assert.equal(JSON.stringify(config.public()).includes('private-xiongmao-seedance-fixture'), false);
});

test('Ark credentials are isolated and Seedance model presets are valid', async () => {
  let stored;
  const config=await createConfig({env:{ARK_API_KEY:'private-ark-fixture'},save:async value=>{stored=value;}});
  assert.equal(config.public().arkConfigured,true);
  for(const id of ['doubao-seedance-2-5','doubao-seedance-2-0-pro','doubao-seedance-2-0-fast','doubao-seedance-2-0-mini']) {
    await config.update({videoModel:id});
    assert.equal(config.settings().videoModel,id);
    assert.equal(stored.videoModel,id);
  }
  assert.equal(JSON.stringify(config.public()).includes('private-ark-fixture'),false);
  const reloaded=await createConfig({env:{},load:async()=>stored});
  assert.equal(reloaded.public().arkConfigured,true);
  assert.equal(reloaded.public().videoModel,'doubao-seedance-2-0-mini');
  await assert.rejects(config.update({videoModel:'doubao-seedance-1-0-pro-250528'}),/模型/);
  await assert.rejects(config.update({videoModel:'doubao-unknown-video'}),/模型/);
});

test('Zhitou image models are selectable from the same public catalog and persist without exposing credentials',async()=>{
  let stored;
  const config=await createConfig({env:{GRSAI_API_KEY:'private-image-fixture'},save:async value=>{stored=value;}});
  assert.equal(config.public().imageModel,'gpt-image-2.5');
  const models=config.public().imageModels;
  for(const id of ['gpt-image-2.5','gpt-image-2.5-sunburst','gpt-image-2','gpt-image-2-vip','nano-banana-pro','nano-banana-fast','nano-banana-2']) {
    assert.ok(models.some(model=>model.id===id&&model.label&&model.description),id);
    await config.update({imageModel:id});
    assert.equal(config.settings().imageModel,id);
    assert.equal(stored.imageModel,id);
  }
  await config.update({imageModel:'gpt-image-2.5-sunburst'});
  const reloaded=await createConfig({env:{},load:async()=>stored});
  assert.equal(reloaded.public().imageModel,'gpt-image-2.5-sunburst');
  assert.equal(reloaded.public().grsaiConfigured,true);
  assert.equal(JSON.stringify(reloaded.public()).includes('private-image-fixture'),false);
  await assert.rejects(config.update({imageModel:'gpt-image-2.5-vip'}),/模型/);
  assert.equal(config.public().imageModel,'gpt-image-2.5-sunburst');
});

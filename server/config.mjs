import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from './image-models.mjs';
import { DEFAULT_LLM_MODEL, LLM_MODELS, listLlmModels, llmCredentialsFromEnv } from './llm-models.mjs';
import { listVideoOptions } from './video-options.mjs';

const MODELS = {
  llmModel:LLM_MODELS.map(model=>model.id),
  imageModel:IMAGE_MODELS.map(model=>model.id),
  videoModel:['MiniMax-H3','MiniMax-H3-Max',
    'xiongmao-minimaxh3',
    'xiongmao-seedance-2-0-official','xiongmao-seedance-2-0-official-fast','xiongmao-seedance-2-0-official-mini',
    'xiongmao-seedance-2-0-promo','xiongmao-seedance-2-0-promo-fast','xiongmao-seedance-2-0-promo-mini',
    'xiongmao-seedance-2-0-special','xiongmao-seedance-2-0-special-fast','xiongmao-seedance-2-0-special-mini',
    'doubao-seedance-2-5','doubao-seedance-2-0-pro','doubao-seedance-2-0-fast','doubao-seedance-2-0-mini',
    'doubao-seedance-1-0-pro-250528','doubao-seedance-1-0-pro-fast-250528'],
};
const DEFAULT_VIDEO_MODEL='MiniMax-H3';
const LEGACY_VIDEO_MODELS=new Set(['seedance-2','seedance-2-fast']);
const KEYS=['llmKey','tokenPlanKey','grsaiKey','minimaxKey','xiongmaoMinimaxH3Key','arkKey'];
function invalid(message){return Object.assign(new Error(message),{status:400,code:'INVALID_CONFIG'});}
function videoModelFromEnv(env){
  const value=typeof env.AIFRAME_VIDEO_MODEL==='string'&&env.AIFRAME_VIDEO_MODEL.trim()?env.AIFRAME_VIDEO_MODEL.trim():DEFAULT_VIDEO_MODEL;
  if(LEGACY_VIDEO_MODELS.has(value))return DEFAULT_VIDEO_MODEL;
  if(!MODELS.videoModel.includes(value))throw invalid('AIFRAME_VIDEO_MODEL 不是已接入的视频模型。');
  return value;
}

export async function createConfig({env=process.env,load,save,ffmpegAvailable=false}={}) {
  let pending=Promise.resolve();
  const initial = load ? await load() : {};
  let settings={
    ...llmCredentialsFromEnv(env),
    grsaiKey:env.GRSAI_API_KEY || '',minimaxKey:env.MINIMAX_API_KEY || '',xiongmaoMinimaxH3Key:env.XIONGMAO_API_KEY || env.XIONGMAO_MINIMAXH3_API_KEY || '',arkKey:env.ARK_API_KEY || '',
    llmModel:DEFAULT_LLM_MODEL,imageModel:DEFAULT_IMAGE_MODEL,videoModel:videoModelFromEnv(env),
  };
  // Only known fields from the encrypted credential store are accepted.
  for(const key of KEYS) if(typeof initial[key]==='string' && initial[key]) settings[key]=initial[key];
  for(const [key,values] of Object.entries(MODELS)) if(values.includes(initial[key])) settings[key]=initial[key];
  function publicConfig(){
    const llmModels=listLlmModels(settings);
    return {llmConfigured:llmModels.find(model=>model.id===settings.llmModel)?.configured??false,codingPlanConfigured:Boolean(settings.llmKey.trim()),tokenPlanConfigured:Boolean(settings.tokenPlanKey.trim()),llmModels,grsaiConfigured:Boolean(settings.grsaiKey),minimaxConfigured:Boolean(settings.minimaxKey),xiongmaoMinimaxH3Configured:Boolean(settings.xiongmaoMinimaxH3Key),arkConfigured:Boolean(settings.arkKey),llmModel:settings.llmModel,imageModel:settings.imageModel,imageModels:IMAGE_MODELS,videoModel:settings.videoModel,videoOptions:listVideoOptions(),credentialStorage:save?'encrypted':'session',ffmpegAvailable};
  }
  return {
    public:publicConfig,
    settings:()=>({...settings}),
    update(input){
      const operation=pending.then(async()=>{
      if(!input || typeof input!=='object' || Array.isArray(input)) throw invalid('配置必须为对象');
      const next={...settings};
      for(const [key,value] of Object.entries(input)) {
        if(!KEYS.includes(key) && !Object.hasOwn(MODELS,key)) throw invalid('不支持该配置字段');
        if(typeof value!=='string') throw invalid('配置必须使用文本');
        if(KEYS.includes(key)) {
          if(value.length>4096 || /[\r\n\x00]/.test(value)) throw invalid('密钥格式不正确');
          if(value.trim()) next[key]=value.trim();
        } else {
          if(!MODELS[key].includes(value)) throw invalid('不支持该模型');
          next[key]=value;
        }
      }
      if(save) await save(next);
      settings=next;
      return publicConfig();
      });
      pending=operation.catch(()=>{});
      return operation;
    }
  };
}

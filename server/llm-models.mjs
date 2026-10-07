import {safeError} from './network.mjs';

export const DEFAULT_LLM_MODEL='qwen3.7-plus';

// Presets and provider routes follow WorkHelper app/main/model-presets.js and
// cloud_server src/lib/tdl-models.ts. This catalog contains public metadata only.
export const LLM_MODELS=Object.freeze([
  {id:'qwen3.7-plus',label:'Qwen 3.7 Plus',provider:'coding-plan',providerLabel:'阿里云 Coding Plan',description:'高质量通用模型，适合复杂剧情和正式分镜。',speed:'standard',recommended:false},
  {id:'qwen3.6-plus',label:'Qwen 3.6 Plus',provider:'coding-plan',providerLabel:'阿里云 Coding Plan',description:'稳定的日常通用模型。',speed:'standard',recommended:false},
  {id:'qwen3.8-max',label:'Qwen 3.8 Max',provider:'token-plan',providerLabel:'阿里云 Token Plan',description:'高质量模型，适合长篇小说和复杂剧情分析。',speed:'standard',recommended:false},
  {id:'qwen3.8-flash',label:'Qwen 3.8 Flash',provider:'token-plan',providerLabel:'阿里云 Token Plan',description:'生成速度快，适合快速分析和分镜草稿。',speed:'fast',recommended:true},
  {id:'deepseek-v4.1-flash',label:'DeepSeek V4.1 Flash',provider:'token-plan',providerLabel:'阿里云 Token Plan',description:'生成速度快，适合快速整理和多次修改。',speed:'fast',recommended:true},
  {id:'deepseek-v4-pro',label:'DeepSeek V4 Pro',provider:'token-plan',providerLabel:'阿里云 Token Plan',description:'适合需要更完整推理和人物关系分析的内容。',speed:'standard',recommended:false},
].map(Object.freeze));

const ROUTES=Object.freeze({
  'coding-plan':Object.freeze({url:'https://coding.dashscope.aliyuncs.com/v1/chat/completions',keyField:'llmKey'}),
  'token-plan':Object.freeze({url:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions',keyField:'tokenPlanKey'}),
});
const clean=value=>typeof value==='string'?value.trim():'';

export function llmCredentialsFromEnv(env=process.env){
  return {
    llmKey:clean(env.DASHSCOPE_API_KEY)||clean(env.QWEN_API_KEY)||clean(env.ALIBABA_CODING_PLAN_API_KEY),
    tokenPlanKey:clean(env.TOKEN_PLAN_API_KEY)||clean(env.ALIBABA_TOKEN_PLAN_API_KEY),
  };
}

export function listLlmModels(settings={}){
  return LLM_MODELS.map(model=>({...model,configured:Boolean(clean(settings[ROUTES[model.provider].keyField]))}));
}

export function resolveLlmModel(settings={}){
  const model=LLM_MODELS.find(item=>item.id===settings.llmModel);
  if(!model)throw safeError('大模型不在已接入的预设列表中。','MODEL_UNSUPPORTED');
  const route=ROUTES[model.provider];const key=clean(settings[route.keyField]);
  if(!key)throw safeError(`请在模型设置中配置${model.providerLabel}密钥。`,'NOT_CONFIGURED');
  return {model:model.id,url:route.url,key};
}

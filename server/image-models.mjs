import { safeError } from './network.mjs';

export const DEFAULT_IMAGE_MODEL='gpt-image-2.5';
export const GRSAI_GENERATE_URL='https://grsai.dakka.com.cn/v1/api/generate';
export const GRSAI_RESULT_URL='https://grsai.dakka.com.cn/v1/api/result';

// Source: SF智投 MainImageController and the portrait/poster VIP size mapping.
// Public metadata only; credentials and user prompts never belong in this catalog.
export const IMAGE_MODELS=Object.freeze([
  {id:'gpt-image-2.5',label:'GPT Image 2.5',description:'智投默认图片模型，按作品横竖画幅生成。'},
  {id:'gpt-image-2.5-sunburst',label:'GPT Image 2.5 Sunburst',description:'智投提供的 Sunburst 版本，按作品横竖画幅生成。'},
  {id:'gpt-image-2',label:'GPT Image 2',description:'GPT Image 2 标准版，适用于角色定妆与分镜草稿。'},
  {id:'gpt-image-2-vip',label:'GPT Image 2 VIP',description:'当前生成 720×1280 竖图或 1280×720 横图。'},
  {id:'nano-banana-pro',label:'Nano Banana Pro',description:'用于角色参考与复杂构图，当前使用 1K 草稿分辨率。'},
  {id:'nano-banana-fast',label:'Nano Banana Fast',description:'快速预览与提示词试验，当前使用 1K 草稿分辨率。'},
  {id:'nano-banana-2',label:'Nano Banana 2',description:'参考图生成与日常迭代，当前使用 1K 草稿分辨率。'},
].map(Object.freeze));

export function buildImageRequest({model,prompt,images,aspectRatio,replyType='json'}) {
  if(!IMAGE_MODELS.some(item=>item.id===model))throw safeError('图片模型不在已接入列表中。','MODEL_UNSUPPORTED');
  if(!['9:16','16:9'].includes(aspectRatio))throw safeError('图片画幅必须为 9:16 或 16:9。','INVALID_INPUT');
  if(!['json','async'].includes(replyType))throw safeError('图片服务回复模式无效。','INVALID_INPUT');
  // `images` is optional in the Grsai contract. Omitting it for a text-only
  // request avoids routing an empty array through providers that interpret
  // the presence of the field as an image-edit request.
  const body={model,prompt,aspectRatio,replyType};
  if(Array.isArray(images)&&images.length)body.images=images;
  if(model.startsWith('nano-banana'))body.imageSize='1K';
  if(model==='gpt-image-2-vip')body.aspectRatio=aspectRatio==='16:9'?'1280x720':'720x1280';
  return body;
}

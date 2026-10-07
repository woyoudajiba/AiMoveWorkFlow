import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';

export function safeError(message, code = 'PROVIDER_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.safe = true;
  const localStatuses={
    NOT_CONFIGURED:409,INVALID_INPUT:400,MODEL_UNSUPPORTED:400,CHARACTER_NOT_APPROVED:409,LOOK_NOT_APPROVED:409,BOARD_CAPACITY:400,
    INVALID_PATH:400,MEDIA_MISSING:404,INVALID_URL:400,UNSAFE_URL:400,IMAGE_INVALID:400,IMAGE_TOO_LARGE:400,
    EXPORT_INCOMPLETE:409,EXPORT_STALE:409,EXPORT_DURATION:400,INVALID_EXPORT:400,
    SUBMISSION_UNKNOWN:409,RESULT_EXPIRED:409,RESULT_DOWNLOAD_FAILED:409,FFMPEG_UNAVAILABLE:503
  };
  error.status=localStatuses[code]??502;error.statusCode=error.status;
  if (['NOT_CONFIGURED','INVALID_INPUT','MODEL_UNSUPPORTED','CHARACTER_NOT_APPROVED','LOOK_NOT_APPROVED','PROVIDER_REJECTED','ANALYSIS_INVALID','INVALID_PATH','MEDIA_MISSING','IMAGE_INVALID','IMAGE_TOO_LARGE','BOARD_CAPACITY'].includes(code)) error.definitive=true;
  return error;
}

function safeUpstreamHint(value){
  if(typeof value!=='string')return '';
  const text=value.replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();
  if(!text||/sk-[a-z0-9]|bearer\s|data:|https?:\/\/|api.?key|token\s*[=:]/i.test(text))return '';
  return text.slice(0,180);
}

export function isPublicAddress(address) {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(ip) === 4) {
    const [a,b,c] = ip.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127)
      || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99)))
      || (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
  }
  if (isIP(ip) !== 6 || ip.includes('%')) return false;
  // Only ordinary global-unicast IPv6. Reject mapped, NAT64, 6to4, Teredo,
  // documentation and benchmark ranges rather than trusting transition routing.
  const first = Number.parseInt(ip.split(':')[0],16);
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff || first===0x2002) return false;
  const second = Number.parseInt(ip.split(':')[1] || '0',16);
  if (first===0x2001 && (second<0x0200 || second===0x0db8)) return false;
  if (first===0x3fff) return false;
  return true;
}

export async function validateRemoteUrl(value, lookup = dnsLookup) {
  let url;
  try { url = new URL(value); } catch { throw safeError('外部素材地址无效。','INVALID_URL'); }
  if (url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443')) {
    throw safeError('外部素材仅允许标准 HTTPS 地址。','INVALID_URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g,'');
  if (hostname==='localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw safeError('禁止访问本地或内网地址。','UNSAFE_URL');
  let addresses;
  try { addresses = isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await lookup(hostname,{all:true,verbatim:true}); }
  catch { throw safeError('外部地址解析失败，请检查网络。','NETWORK_ERROR'); }
  if (!addresses.length || addresses.some(x=>!isPublicAddress(x.address))) throw safeError('禁止访问本地、内网或保留地址。','UNSAFE_URL');
  return {url,addresses};
}

export async function requestBuffer(value, {method='GET',headers={},body,timeoutMs=60000,maxBytes=30*1024*1024,lookup=dnsLookup} = {}) {
  const started=Date.now();
  let timer;
  const resolved = await Promise.race([
    validateRemoteUrl(value,lookup),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(safeError('地址解析超时。','NETWORK_TIMEOUT')),Math.min(timeoutMs,15000));})
  ]).finally(()=>clearTimeout(timer));
  const {url,addresses}=resolved;
  const payload=body===undefined
    ? undefined
    : Buffer.isBuffer(body)
      ? body
      : body instanceof Uint8Array
        ? Buffer.from(body)
        : Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  if (payload && payload.length>48*1024*1024) {
    const error=safeError('参考素材请求过大，请减少图片大小。','PAYLOAD_TOO_LARGE');error.definitive=true;throw error;
  }
  return new Promise((resolve,reject)=>{
    let done=false; let total=0; const chunks=[];
    const finish=(error,result)=>{ if(done)return; done=true; clearTimeout(deadline); error?reject(error):resolve(result); };
    // Pin the validated DNS answer to this socket. No second DNS resolution and
    // no pooled socket can bypass the address check. TLS still validates hostname.
    const request=https.request(url,{
      method,agent:false,headers:{'User-Agent':'AIFrameStudio/0.1',...headers,...(payload?{'Content-Length':String(payload.length)}:{})},
      lookup:(_host,options,callback)=>{
        if(options?.all) callback(null,addresses);
        else callback(null,addresses[0].address,addresses[0].family);
      }
    },response=>{
      const status=response.statusCode??0;
      if(status>=300 && status<400){response.destroy();finish(safeError('外部服务返回重定向，已阻止自动跳转。','REDIRECT_BLOCKED'));return;}
      if(status<200 || status>=300){
        const generic=status===401||status===403?'模型认证失败，请检查对应服务密钥和权限。':status===429?'模型服务限流，请稍后再试。':`模型服务请求失败（HTTP ${status}）。`;
        const errorChunks=[];let errorTotal=0;let errorTooLarge=false;
        response.on('data',chunk=>{errorTotal+=chunk.length;if(errorTotal>64*1024){errorTooLarge=true;response.destroy();return;}errorChunks.push(chunk);});
        response.on('end',()=>{
          let parsed;try{parsed=JSON.parse(Buffer.concat(errorChunks).toString('utf8'));}catch{}
          const rawCode=parsed?.code??parsed?.error?.code;
          const rawMessage=typeof parsed?.error==='string'?parsed.error:parsed?.error?.message??parsed?.message??parsed?.msg;
          const hint=errorTooLarge?'':safeUpstreamHint(rawMessage);
          const detail=hint?` 供应商提示：${hint}`:'';
          const error=safeError(`${generic}${detail}`,'UPSTREAM_HTTP');
          error.status=status;error.statusCode=status;error.definitive=method==='POST'&&[400,401,403,404,405,413,422,429].includes(status);
          if (status === 429) {
            const retryAfterHeader = response.headers['retry-after'];
            const retryAfterSeconds = Number(retryAfterHeader);
            const retryAfterDate = typeof retryAfterHeader === 'string' && !Number.isFinite(retryAfterSeconds) ? Date.parse(retryAfterHeader) : NaN;
            const retryAfterMs = Number.isFinite(retryAfterSeconds)
              ? Math.max(0, Math.min(30000, retryAfterSeconds * 1000))
              : Number.isFinite(retryAfterDate)
                ? Math.max(0, Math.min(30000, retryAfterDate - Date.now()))
                : 0;
            error.retryable = true;
            error.retryAfterMs = retryAfterMs;
          }
          if(typeof rawCode==='string'||typeof rawCode==='number')error.upstreamCode=String(rawCode).slice(0,80);
          finish(error);
        });
        response.on('error',()=>{const error=safeError(generic,'UPSTREAM_HTTP');error.status=status;error.statusCode=status;error.definitive=method==='POST'&&[400,401,403,404,405,413,422,429].includes(status);finish(error);});
        return;
      }
      if(Number(response.headers['content-length'])>maxBytes){response.destroy();finish(safeError('外部结果超过允许大小。','PAYLOAD_TOO_LARGE'));return;}
      response.on('data',chunk=>{total+=chunk.length;if(total>maxBytes){response.destroy();finish(safeError('外部结果超过允许大小。','PAYLOAD_TOO_LARGE'));}else chunks.push(chunk);});
      response.on('end',()=>finish(null,Buffer.concat(chunks)));
      response.on('error',()=>finish(safeError('外部结果下载中断。','NETWORK_ERROR')));
    });
    const deadline=setTimeout(()=>{request.destroy();finish(safeError('模型服务请求超时；提交状态可能需要核实。','NETWORK_TIMEOUT'));},Math.max(1,timeoutMs-(Date.now()-started)));
    request.on('error',()=>finish(safeError('无法连接模型服务，请检查网络；已提交任务请先查询状态。','NETWORK_ERROR')));
    if(payload)request.write(payload);
    request.end();
  });
}

export async function requestJson(url, options={}) {
  const bytes=await requestBuffer(url,{...options,headers:{'Content-Type':'application/json',...options.headers},maxBytes:options.maxBytes??4*1024*1024});
  try{return JSON.parse(bytes.toString('utf8'));}catch{throw safeError('模型服务返回了无法解析的结果。','INVALID_RESPONSE');}
}

function multipartHeaderValue(value) {
  return String(value ?? '').replace(/[\r\n\0]/g, ' ').replace(/"/g, '%22');
}

function multipartFilePart(boundary, fieldName, file) {
  if (!file || typeof file !== 'object') throw safeError('上传文件参数无效。', 'INVALID_INPUT');
  const data = Buffer.isBuffer(file.data) ? file.data : file.data instanceof Uint8Array ? Buffer.from(file.data) : null;
  if (!data) throw safeError('上传文件内容无效。', 'INVALID_INPUT');
  const filename = multipartHeaderValue(file.filename || 'upload.bin');
  const contentType = multipartHeaderValue(file.contentType || 'application/octet-stream');
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${multipartHeaderValue(fieldName || 'file')}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8'),
    data,
    Buffer.from('\r\n', 'utf8'),
  ]);
}

export async function requestMultipartJson(url, {fields = {}, file, files = [], headers = {}, ...options} = {}) {
  const boundary = `----AIFrameStudio-${randomUUID()}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (value === undefined || value === null) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${multipartHeaderValue(name)}"\r\n\r\n${String(value)}\r\n`, 'utf8'));
  }
  const allFiles = file ? [file, ...files] : files;
  for (const item of allFiles) parts.push(multipartFilePart(boundary, item.fieldName || 'file', item));
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const bytes = await requestBuffer(url, {
    ...options,
    method: options.method || 'POST',
    headers: { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
    maxBytes: options.maxBytes ?? 4 * 1024 * 1024,
  });
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw safeError('模型服务返回了无法解析的结果。', 'INVALID_RESPONSE'); }
}

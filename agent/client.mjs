import http from 'node:http';

export function agentError(code,message){return Object.assign(new Error(message),{code,agentSafe:true});}

export function redact(value){
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
    .filter(([key])=>!['__proto__','constructor','prototype'].includes(key)&&!/(?:api.?key|password|secret|authorization|access.?token|refresh.?token|private.?key|llmKey|tokenPlanKey|grsaiKey|minimaxKey|arkKey|^token|^sessionId)$/i.test(key))
    .map(([key,item])=>[key,redact(item)]));
  if(typeof value==='string')return value.replace(/\bBearer\s+\S+/gi,'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g,'[redacted]').replace(/([?&](?:token|api_?key|key|signature|credential)=)[^&\s]+/gi,'$1[redacted]');
  return value;
}

export function publicError(error){return {code:error?.agentSafe?error.code:'AGENT_ERROR',message:error?.agentSafe?redact(error.message):'Agent 调用失败，请检查本地服务和参数；已提交任务请查询状态，不要盲目重发。'};}

export function createLocalClient({baseUrl='http://127.0.0.1:4318',timeoutMs=30000}={}){
  const match=typeof baseUrl==='string'&&/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(baseUrl);
  if(!match||Number(match[1])>65535)throw agentError('INVALID_URL','只允许显式本机地址 http://127.0.0.1:<port>，不能包含路径、凭据或查询参数。');
  const origin=`http://127.0.0.1:${match[1]}`;
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw agentError('INVALID_INPUT','本地请求超时设置无效。');
  let sessionId=null,connecting=null;
  async function rawRequest(route,method='GET',body){
    if(!['GET','POST','PATCH'].includes(method)||typeof route!=='string'||!/^\/api\/[A-Za-z0-9_/-]+$/.test(route)||route.includes('..'))throw agentError('INVALID_ROUTE','Agent 只能调用已声明的工作台接口。');
    const payload=method==='GET'?null:Buffer.from(JSON.stringify(body??{}));
    if(payload?.length>1024*1024)throw agentError('INPUT_TOO_LARGE','Agent 请求超过 1 MiB，请拆分文本。');
    return new Promise((resolve,reject)=>{
      let finished=false;
      const finish=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(result);};
      const req=http.request({hostname:'127.0.0.1',port:Number(match[1]),path:route,method,agent:false,headers:{'Content-Type':'application/json','X-Local-Client':'aiframe',Origin:origin,...(sessionId?{'X-Studio-Session':sessionId}:{}),...(payload?{'Content-Length':String(payload.length)}:{})}},res=>{
        if(res.statusCode>=300&&res.statusCode<400){res.destroy();finish(agentError('REDIRECT_BLOCKED','本地服务返回重定向，已拒绝转发小说或素材。'));return;}
        let size=0;const chunks=[];
        res.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024){res.destroy();finish(agentError('RESPONSE_TOO_LARGE','工作台返回结果过大，请按作品拆分。'));}else chunks.push(chunk);});
        res.on('end',()=>{
          try{
            const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid response shape');
            if(res.statusCode<200||res.statusCode>=300){
              const code=typeof result.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(result.code)?result.code:'HTTP_ERROR';
              const message=typeof result.error==='string'?redact(result.error).slice(0,500):`工作台请求失败（HTTP ${res.statusCode}）。`;
              finish(agentError(code,message));return;
            }
            finish(null,result);
          }catch{
            finish(agentError(method==='GET'?'INVALID_RESPONSE':'SUBMISSION_UNKNOWN','工作台响应无法解析。修改请求可能已生效，请读取作品和任务状态核实。'));
          }
        });
        res.on('error',()=>finish(agentError(method==='GET'?'CONNECTION_ERROR':'SUBMISSION_UNKNOWN','工作台连接中断。已提交操作不会自动重发，请先读取任务状态。')));
      });
      const timer=setTimeout(()=>{req.destroy();finish(agentError(method==='GET'?'REQUEST_TIMEOUT':'SUBMISSION_UNKNOWN','工作台请求超时。已提交操作不会自动重发，请先读取任务状态。'));},timeoutMs);
      req.on('error',()=>finish(agentError(method==='GET'?'CONNECTION_ERROR':'SUBMISSION_UNKNOWN','无法连接本地工作台。已提交操作不会自动重发，请检查服务并查询任务。')));
      if(payload)req.write(payload);
      req.end();
    });
  }
  async function request(route,method='GET',body){
    if(typeof route==='string'&&route.startsWith('/api/auth/'))throw agentError('INVALID_ROUTE','请在桌面工作台登录；Agent 不接收账号密码。');
    if(!sessionId){
      if(!connecting)connecting=rawRequest('/api/auth/status').then(status=>{
        if(!status.authenticated||typeof status.sessionId!=='string'||!/^[a-f0-9]{64}$/.test(status.sessionId))throw agentError('AUTH_REQUIRED','请先在映序工作台登录 TDL 账号，再调用 Agent。');
        sessionId=status.sessionId;
      }).finally(()=>{connecting=null;});
      await connecting;
    }
    // Never refresh a bound session automatically: an old Agent must not write to a new account.
    return redact(await rawRequest(route,method,body));
  }
  return {origin,request};
}

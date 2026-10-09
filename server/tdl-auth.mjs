import {requestJson} from './network.mjs';

const AUTH_BASE='https://wsfile.cn/myladmin';
const REQUEST_OPTIONS={timeoutMs:15000,maxBytes:64*1024};
const ROLES=new Set(['ADMIN','INTERNAL','VIP','OPERATOR','MEMBER']);
const MEMBERSHIPS=new Set(['NORMAL','VIP']);
const ERRORS={
  AUTH_REQUIRED:[401,'请先使用 TDL 账号登录。'],
  AUTH_INVALID:[401,'账号、密码或登录状态无效，请重新登录。'],
  AUTH_DISABLED:[403,'当前账号已被停用，请联系管理员。'],
  AUTH_UNAVAILABLE:[503,'账号服务暂时不可用，请检查网络后重试。'],
  AUTH_INPUT_INVALID:[400,'请检查账号、密码和记住登录选项。'],
};

class AuthError extends Error {
  constructor(code){
    super(ERRORS[code][1]);
    this.code=code;this.status=ERRORS[code][0];this.statusCode=this.status;this.safe=true;
  }
}
const authError=code=>new AuthError(code);
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const cleanText=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);

function publicUser(value){
  if(!isObject(value)||typeof value.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value.id))return null;
  if(!cleanText(value.username,64)||!value.username.trim()||!ROLES.has(value.role)||!MEMBERSHIPS.has(value.membershipTier))return null;
  if(value.displayName!==undefined&&!cleanText(value.displayName,128))return null;
  return {id:value.id,username:value.username.trim(),displayName:value.displayName?.trim()||value.username.trim(),role:value.role,membershipTier:value.membershipTier};
}

function validSession(value,now){
  if(!isObject(value)||typeof value.token!=='string'||!/^[a-zA-Z0-9._~-]{1,16384}$/.test(value.token))return null;
  if(typeof value.expiresAt!=='string'||value.expiresAt.length>64)return null;
  const expires=Date.parse(value.expiresAt),user=publicUser(value.user);
  if(!user||!Number.isFinite(expires)||expires<=now)return null;
  return {token:value.token,expiresAt:new Date(expires).toISOString(),user};
}

function loginInput(input,rememberAvailable){
  if(!isObject(input)||Object.keys(input).some(key=>!['username','password','remember'].includes(key)))throw authError('AUTH_INPUT_INVALID');
  if(!cleanText(input.username,256)||!cleanText(input.password,120)||!input.password)throw authError('AUTH_INPUT_INVALID');
  const username=input.username.trim();
  if(!username||username.length>64||input.remember!==undefined&&typeof input.remember!=='boolean')throw authError('AUTH_INPUT_INVALID');
  if(input.remember&&!rememberAvailable)throw authError('AUTH_INPUT_INVALID');
  return {username,password:input.password,remember:input.remember===true};
}

function translateError(error,{login=false}={}){
  if(error instanceof AuthError)return error;
  const status=error?.statusCode??error?.status;
  if(status===401)return authError('AUTH_INVALID');
  if(status===403)return authError('AUTH_DISABLED');
  if(login&&status===400)return authError('AUTH_INPUT_INVALID');
  // Deliberately discard upstream text, causes and request objects containing secrets.
  return authError('AUTH_UNAVAILABLE');
}

export async function createTdlAuth({request=requestJson,load,save,now=Date.now,validationTtlMs=30000,persistLogin=false}={}){
  const rememberAvailable=typeof load==='function'&&typeof save==='function';
  const ttl=Number.isFinite(validationTtlMs)?Math.min(30000,Math.max(0,validationTtlMs)):30000;
  let session=null,authenticated=false,remembered=false,validatedAt=null,generation=0,pendingValidation=null;
  let storagePending=Promise.resolve();

  // A delayed login save must finish before a later logout clears the same file.
  function persist(value){
    if(typeof save!=='function')return Promise.resolve();
    const copy=value?{token:value.token,expiresAt:value.expiresAt,user:{...value.user}}:null;
    const operation=storagePending.then(()=>save(copy));
    storagePending=operation.catch(()=>{});
    return operation;
  }

  function reset(){
    generation++;session=null;authenticated=false;remembered=false;validatedAt=null;pendingValidation=null;
    return generation;
  }

  function expire(){
    if(!session||Date.parse(session.expiresAt)>now())return false;
    reset();persist(null).catch(()=>{});return true;
  }

  function current(expected){
    if(expected!==generation)throw authError('AUTH_REQUIRED');
  }

  function publicState(){
    expire();
    return {authenticated,user:authenticated&&session?{...session.user}:null,expiresAt:session?.expiresAt||'',rememberAvailable,remembered};
  }

  if(typeof load==='function'){
    let stored;
    try{stored=await load();}catch{throw authError('AUTH_UNAVAILABLE');}
    session=validSession(stored,now());remembered=Boolean(session);
    if(stored&&!session)await persist(null).catch(()=>{});
  }

  return {
    public:publicState,
    async login(input){
      const credentials=loginInput(input,rememberAvailable);
      const expected=reset();
      let persistenceAttempted=false;
      try{
        // A failed account switch must not revive a previously remembered account.
        await persist(null);current(expected);
        const response=await request(`${AUTH_BASE}/api/auth/login`,{...REQUEST_OPTIONS,method:'POST',body:{username:credentials.username,password:credentials.password,clientLabel:'映序'}});
        current(expected);
        const candidate=validSession(response,now());
        if(!candidate)throw authError('AUTH_UNAVAILABLE');
        if(credentials.remember || persistLogin){persistenceAttempted=true;await persist(candidate);}
        current(expected);
        if(Date.parse(candidate.expiresAt)<=now())throw authError('AUTH_INVALID');
        session=candidate;remembered=credentials.remember;authenticated=true;validatedAt=now();
        return publicState();
      }catch(error){
        current(expected);
        const safe=translateError(error,{login:true});
        if(persistenceAttempted||safe.code==='AUTH_INVALID'||safe.code==='AUTH_DISABLED')await persist(null).catch(()=>{});
        throw safe;
      }
    },
    async validate({force=false}={}){
      if(expire())throw authError('AUTH_INVALID');
      if(!session)throw authError('AUTH_REQUIRED');
      const elapsed=validatedAt===null?Infinity:now()-validatedAt;
      if(!force&&authenticated&&elapsed>=0&&elapsed<ttl)return {...session.user};
      if(pendingValidation?.generation===generation)return {...await pendingValidation.promise};
      const expected=generation,candidate=session;
      const operation=(async()=>{
        try{
          const response=await request(`${AUTH_BASE}/api/auth/me`,{...REQUEST_OPTIONS,method:'GET',headers:{Authorization:`Bearer ${candidate.token}`}});
          current(expected);
          const user=publicUser(response?.user);
          if(Date.parse(candidate.expiresAt)<=now()||!user||user.id!==candidate.user.id)throw authError('AUTH_INVALID');
          session={...candidate,user};authenticated=true;validatedAt=now();
          return {...user};
        }catch(error){
          current(expected);
          const safe=translateError(error);
          authenticated=false;validatedAt=null;
          if(safe.code==='AUTH_INVALID'||safe.code==='AUTH_DISABLED'){reset();await persist(null).catch(()=>{});}
          throw safe;
        }finally{
          if(pendingValidation?.generation===expected)pendingValidation=null;
        }
      })();
      pendingValidation={generation:expected,promise:operation};
      return {...await operation};
    },
    async logout({remote=true}={}){
      const previous=session;reset();
      let storageFailed=false,remoteRevoked=false;
      try{await persist(null);}catch{storageFailed=true;}
      if(previous&&remote){
        try{
          const response=await request(`${AUTH_BASE}/api/auth/logout`,{...REQUEST_OPTIONS,method:'POST',headers:{Authorization:`Bearer ${previous.token}`}});
          remoteRevoked=response?.ok===true;
        }catch{}
      }
      // If neither local deletion nor remote revocation worked, do not claim a safe logout.
      if(storageFailed&&!remoteRevoked)throw authError('AUTH_UNAVAILABLE');
      return {ok:true,remoteRevoked};
    },
  };
}

// The HTTP service can serve several browser sessions at once. Keep the
// upstream bearer token inside one adapter per local session instead of
// sharing one mutable adapter across every account in the process.
export function createTdlAuthFactory({request=requestJson,load,save,now=Date.now,validationTtlMs=30000,persistLogin=false}={}){
  const canPersist=typeof load==='function'&&typeof save==='function';
  const validId=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  return {
    rememberAvailable:canPersist,
    async create(sessionId){
      if(!validId(sessionId))throw new Error('Invalid local session ID.');
      return createTdlAuth({
        request,
        now,
        validationTtlMs,
        persistLogin,
        ...(canPersist?{load:()=>load(sessionId),save:value=>save(sessionId,value)}:{}),
      });
    },
  };
}

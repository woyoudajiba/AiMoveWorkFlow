import {randomBytes, timingSafeEqual} from 'node:crypto';

const COOKIE='aiframe_session';
const error=(message,code='AUTH_REQUIRED',status=401)=>Object.assign(new Error(message),{code,status});
const equal=(a,b)=>typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const sessionId=()=>randomBytes(32).toString('hex');

function cookie(res,value){res.setHeader('Set-Cookie',`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${value?'':'; Max-Age=0'}`);}
function requestIds(req,media=false){
  const header=typeof req.headers['x-studio-session']==='string'?req.headers['x-studio-session']:'';
  const cookieId=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
  let queryId='';
  if(media){try{queryId=new URL(req.url||'','http://127.0.0.1').searchParams.get('session')||'';}catch{}}
  return {header,cookie:cookieId,query:queryId,supplied:media?(header||queryId||cookieId):header};
}

// Backwards-compatible single-adapter mode used by the local unit fixtures.
// Production creates the scoped mode below through createTdlAuthFactory.
function createLegacyLocalSession(auth){
  const sessions=new Map();
  let revision=0,loginBusy=false;
  const attempts=[];
  function suppliedId(req,media=false){return requestIds(req,media).supplied;}
  function clearAll(res){sessions.clear();revision++;if(res)cookie(res,'');}
  function check(req,media=false){
    const supplied=suppliedId(req,media),session=supplied?sessions.get(supplied):null;
    if(!session){
      const stale=supplied&&!media&&sessions.size>0;
      throw error(stale?'请登录 TDL 账号后继续；旧会话请重新连接。':'请登录 TDL 账号后继续。',stale?'SESSION_CHANGED':'AUTH_REQUIRED',stale?409:401);
    }
    return session;
  }
  async function validate(res){
    const before=revision;
    try{return await auth.validate();}
    catch(e){
      if(before!==revision)throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);
      if(e.status===401||e.status===403)clearAll(res);throw e;
    }
  }
  function publicState(session){return {...auth.public(),sessionId:session?.id??null,accountKey:session?.accountKey??null};}
  return {
    check,
    async status(req,res,keyFor){
      if(loginBusy)throw error('正在登录，请稍候。','AUTH_IN_PROGRESS',409);
      const supplied=suppliedId(req);
      if(supplied&&!sessions.has(supplied))throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);
      const before=revision;let user;
      try{user=await validate(res);}catch(e){if(e.status===401||e.status===403)return {...auth.public(),sessionId:null,accountKey:null};throw e;}
      if(before!==revision)throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);
      let session=supplied?sessions.get(supplied):null;
      if(!session){session={id:sessionId(),userId:user.id,accountKey:keyFor(user.id)};sessions.set(session.id,session);}
      else if(session.userId!==user.id){sessions.delete(session.id);revision++;throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);}
      cookie(res,session.id);
      return publicState(session);
    },
    async login(input,res,keyFor){
      const now=Date.now();while(attempts.length&&attempts[0]<now-60000)attempts.shift();
      if(loginBusy||attempts.length>=5)throw error('登录请求过于频繁，请一分钟后重试。','AUTH_RATE_LIMITED',429);
      attempts.push(now);loginBusy=true;const before=++revision;
      try{
        const state=await auth.login(input);
        if(before!==revision)throw error('登录已取消，请重试。','SESSION_CHANGED',409);
        if([...sessions.values()].some(item=>item.userId!==state.user.id)){sessions.clear();revision++;}
        const session={id:sessionId(),userId:state.user.id,accountKey:keyFor(state.user.id)};
        sessions.set(session.id,session);revision++;cookie(res,session.id);return publicState(session);
      }finally{loginBusy=false;}
    },
    async logout(req,res){
      const current=check(req);
      sessions.delete(current.id);revision++;cookie(res,'');
      if(sessions.size)return {ok:true,remoteRevoked:false};
      return auth.logout();
    },
    async require(req,res,media=false){
      const captured=check(req,media);const user=await validate(res);
      if(!sessions.has(captured.id)||user.id!==captured.userId)throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);
      return {user,assert:()=>{if(!sessions.has(captured.id))throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);}};
    },
  };
}

function createScopedLocalSession(factory){
  const sessions=new Map();
  const revoked=new Set();
  const accountSessions=new Map();
  const attempts=[];
  const rememberAvailable=factory.rememberAvailable===true;
  const signedOut=()=>({authenticated:false,user:null,expiresAt:'',rememberAvailable,remembered:false,sessionId:null,accountKey:null});
  const publicState=session=>({...session.auth.public(),sessionId:session.id,accountKey:session.accountKey});
  const missing=(supplied,media=false)=>error(supplied&&!media&&sessions.size>0?'请登录 TDL 账号后继续；旧会话请重新连接。':'请登录 TDL 账号后继续。',supplied&&!media&&sessions.size>0?'SESSION_CHANGED':'AUTH_REQUIRED',supplied&&!media&&sessions.size>0?409:401);
  function check(req,media=false){
    const supplied=requestIds(req,media).supplied,session=supplied?sessions.get(supplied):null;
    if(!session){
      if(supplied&&revoked.has(supplied))throw error('请登录 TDL 账号后继续。','AUTH_REQUIRED',401);
      throw missing(supplied,media);
    }
    return session;
  }
  function clearLocal(id){
    const session=sessions.get(id);if(!session)return null;
    sessions.delete(id);
    const group=accountSessions.get(session.userId);if(group){group.delete(id);if(!group.size)accountSessions.delete(session.userId);}
    return session;
  }
  function addLocal(session){
    sessions.set(session.id,session);
    const group=accountSessions.get(session.userId)||new Set();group.add(session.id);accountSessions.set(session.userId,group);
  }
  async function open(id){return factory.create(id);}
  return {
    check,
    async status(req,res,keyFor){
      const supplied=requestIds(req).supplied;
      if(!supplied)return signedOut();
      let session=sessions.get(supplied);
      if(!session){
        const auth=await open(supplied);
        try{
          const user=await auth.validate();
          session={id:supplied,userId:user.id,accountKey:keyFor(user.id),auth};
          addLocal(session);
        }catch(failure){
          if(failure.status===401||failure.status===403)return signedOut();
          throw failure;
        }
      }else{
        try{await session.auth.validate();}
        catch(failure){
          if(failure.status===401||failure.status===403){clearLocal(session.id);return signedOut();}
          throw failure;
        }
      }
      const user=session.auth.public().user;
      if(!user||user.id!==session.userId){clearLocal(session.id);throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);}
      res.sessionId=session.id;
      cookie(res,session.id);
      return publicState(session);
    },
    async login(input,res,keyFor){
      const now=Date.now();while(attempts.length&&attempts[0]<now-60000)attempts.shift();
      if(attempts.length>=5)throw error('登录请求过于频繁，请一分钟后重试。','AUTH_RATE_LIMITED',429);
      attempts.push(now);
      const id=sessionId(),auth=await open(id);
      const state=await auth.login(input);
      const user=state.user;
      if(!user?.id)throw error('账号信息暂时无法确认，请重试。','AUTH_UNAVAILABLE',503);
      const session={id,userId:user.id,accountKey:keyFor(user.id),auth};
      addLocal(session);res.sessionId=id;cookie(res,id);return publicState(session);
    },
    async logout(req,res){
      const current=check(req);
      clearLocal(current.id);
      revoked.add(current.id);
      // Local access is revoked before contacting TDL. A failed upstream
      // request cannot leave a usable local session behind.
      const remaining=accountSessions.get(current.userId)?.size>0;
      return current.auth.logout({remote:!remaining});
    },
    async require(req,res,media=false){
      const captured=check(req,media);
      const user=await captured.auth.validate();
      if(!sessions.has(captured.id)||user.id!==captured.userId)throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);
      res.sessionId=captured.id;
      return {user,assert:()=>{if(!sessions.has(captured.id))throw error('账号会话已变化，请重新连接。','SESSION_CHANGED',409);}};
    },
  };
}

export function createLocalSession(auth,{factory=null}={}){
  if(factory)return createScopedLocalSession(factory);
  if(!auth)throw new Error('Authentication adapter is required.');
  return createLegacyLocalSession(auth);
}

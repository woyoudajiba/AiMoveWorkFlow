import {randomBytes, timingSafeEqual} from 'node:crypto';

const COOKIE='aiframe_session';
const error=(message,code='AUTH_REQUIRED',status=401)=>Object.assign(new Error(message),{code,status});
const equal=(a,b)=>typeof a==='string'&&/^[a-f0-9]{64}$/.test(a)&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

// This token is local to this process. The TDL bearer token never reaches HTTP clients.
export function createLocalSession(auth){
  // The TDL auth adapter owns one validated upstream identity, while this
  // process may serve several browser/Electron windows for that identity.
  // Keep local session IDs separate so one client cannot revoke another's
  // local access when both use the same account.
  const sessions=new Map();
  let revision=0,loginBusy=false;
  const attempts=[];
  function cookie(res,value){res.setHeader('Set-Cookie',`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict${value?'':'; Max-Age=0'}`);}
  function clearAll(res){sessions.clear();revision++;if(res)cookie(res,'');}
  function suppliedId(req,media=false){
    const cookieId=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
    // Browser media elements send the HttpOnly cookie, while the Electron
    // project sync worker cannot read that cookie and sends the session header.
    return media?(cookieId||req.headers['x-studio-session']):req.headers['x-studio-session'];
  }
  function check(req,media=false){
    const supplied=suppliedId(req,media),session=supplied?sessions.get(supplied):null;
    if(!session){
      // A cleared cookie/header after the last local session is simply logged
      // out. Once another session exists, an old header is a real stale-tab
      // conflict and remains distinguishable to the auth gate.
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
      if(!session){session={id:randomBytes(32).toString('hex'),userId:user.id,accountKey:keyFor(user.id)};sessions.set(session.id,session);}
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
        // A deliberate account switch invalidates every old local session;
        // same-account sessions remain live and share the canonical workspace.
        if([...sessions.values()].some(item=>item.userId!==state.user.id)){sessions.clear();revision++;}
        const session={id:randomBytes(32).toString('hex'),userId:state.user.id,accountKey:keyFor(state.user.id)};
        sessions.set(session.id,session);
        revision++;cookie(res,session.id);return publicState(session);
      }finally{loginBusy=false;}
    },
    async logout(req,res){
      // Permit clearing an unavailable restored session; existing sessions require their local token.
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

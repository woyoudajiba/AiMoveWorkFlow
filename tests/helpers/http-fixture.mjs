import {createHttpServer as createProtectedServer} from '../../server/http.mjs';
const sessions=new Map();
export function testAuth(){
  const user={id:'fixture-account',username:'fixture',displayName:'Fixture',role:'MEMBER',membershipTier:'NORMAL'};
  return {public:()=>({authenticated:true,user,expiresAt:'2099-01-01T00:00:00Z',rememberAvailable:false,remembered:false}),validate:async()=>user,login:async()=>({user}),logout:async()=>({ok:true})};
}
export async function createHttpServer({service,config,dataDir,...options}){
  const server=await createProtectedServer({...options,auth:testAuth(),workspaces:{get:async()=>({service,config,dataDir})}});
  const status=await globalThis.fetch(server.url+'/api/auth/status',{headers:{'X-Local-Client':'aiframe'}});
  const value=await status.json();sessions.set(server.url,{session:value.sessionId,accountKey:value.accountKey,cookie:status.headers.get('set-cookie').split(';')[0]});
  const close=server.close;server.close=async()=>{sessions.delete(server.url);await close();};
  return server;
}
export function authenticatedFetch(input,options={}){
  const url=new URL(input);const known=sessions.get(url.origin);
  if(!known)return globalThis.fetch(input,options);
  const headers=new Headers(options.headers);headers.set('X-Studio-Session',known.session);headers.set('Cookie',known.cookie);
  if(!options.method||['GET','HEAD'].includes(options.method))headers.set('X-Local-Client','aiframe');
  if(url.pathname.startsWith('/media/')&&!url.searchParams.has('account'))url.searchParams.set('account',known.accountKey);
  return globalThis.fetch(url,{...options,headers});
}

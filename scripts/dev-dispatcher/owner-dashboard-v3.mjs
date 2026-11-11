#!/usr/bin/env node
// Authenticated private dashboard on the Muse host, never GitHub Pages.
// Bind to loopback and access through an owner-controlled SSH tunnel.
// Mutations use the SAME Git-backed CAS ledger, not a new authority.
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {GitHubLedger} from './ledger.mjs';
import {settings} from './settings.mjs';
import {applyOwnerDashboardEdit} from './owner-controls-v3.mjs';
import {readLedgerViaGit} from './git-operations.mjs';

const safeEqual=(a,b)=>{
 const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));
 return x.length===y.length&&timingSafeEqual(x,y);
};
const reply=(res,status,contentType,body)=>{
 res.writeHead(status,{
  'Content-Type':contentType,
  'Cache-Control':'private, no-store, max-age=0',
  'X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY',
  'Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'"
 });
 res.end(body);
};
function roleFor(req,ownerPassword,musePassword){
 const header=req.headers.authorization||'';
 if(!header.startsWith('Basic '))return null;
 const decoded=Buffer.from(header.slice(6),'base64').toString('utf8');
 const point=decoded.indexOf(':');
 if(point<0)return null;
 const user=decoded.slice(0,point),password=decoded.slice(point+1);
 if(user==='owner'&&safeEqual(password,ownerPassword))return 'owner';
 if(user==='muse'&&musePassword&&safeEqual(password,musePassword))return 'muse';
 return null;
}
export function ownerDashboardHandler({readState,editState,ownerPassword,musePassword,
 html=readFileSync(new URL('./owner-dashboard-v3.html',import.meta.url),'utf8')}={}){
 if(typeof readState!=='function'||typeof editState!=='function'||
   typeof ownerPassword!=='string'||ownerPassword.length<16)
   throw Error('Private state, authenticated edits and strong owner password required');
 return async (req,res)=>{
  const role=roleFor(req,ownerPassword,musePassword);
  if(!role){
   res.setHeader('WWW-Authenticate','Basic realm="AI CAFE private owner dashboard"');
   return reply(res,401,'application/json',JSON.stringify({error:'Authentication required'}));
  }
  try{
   if(req.method==='GET'&&req.url==='/')
    return reply(res,200,'text/html; charset=utf-8',html);
   if(req.method==='GET'&&req.url==='/api/state'){
    const state=await readState();
    if(state?.version!==1||!state.tasks||!state.actions)throw Error('Invalid private ledger');
    return reply(res,200,'application/json',JSON.stringify({
     updated_at:state.updated_at||null,
     schedule_health:state.schedule_health||null,
     lifecycle:state.lifecycle_v3?.rows||{},
     owner_controls:state.owner_controls||{revision:0},
     open_owner_notices:Object.values(state.owner_alerts||{}).filter(n=>
       ['planned','claimed','uncertain'].includes(n.status)).length,
     recovery_requests:Object.values(state.recovery_requests||{}).slice(-100)
       .map(r=>({request_id:r.request_id,task_id:r.task_id,
         intent:r.intent,status:r.status,reason:r.reason})),
     recovery_rejections:Object.values(state.recovery_rejections||{}).slice(-100)
       .map(r=>({request_id:r.request_id,reason:r.reason,at:r.at}))
    }));
   }
   if(req.method==='POST'&&req.url==='/api/control'){
    if(role!=='owner')return reply(res,403,'application/json',JSON.stringify({error:'Owner-only controls'}));
    const origin=req.headers.origin;
    if(origin&&!/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(origin))
      return reply(res,403,'application/json',JSON.stringify({error:'Cross-origin edit refused'}));
    const type=req.headers['content-type']||'';
    if(!type.startsWith('application/json'))
      return reply(res,415,'application/json',JSON.stringify({error:'JSON required'}));
    let text='';
    for await(const chunk of req){
      text+=chunk;
      if(text.length>4096)return reply(res,413,'application/json',JSON.stringify({error:'Request too large'}));
    }
    let edit;
    try{edit=JSON.parse(text);}catch{return reply(res,400,'application/json',JSON.stringify({error:'Invalid JSON'}));}
    const result=await editState(edit,{role});
    return reply(res,200,'application/json',JSON.stringify({
      saved:true,revision:result.owner_controls?.revision||0}));
   }
   return reply(res,404,'application/json',JSON.stringify({error:'Unknown route'}));
  }catch(error){
   const message=String(error?.message||'Dashboard request failed').slice(0,140);
   const status=/conflict/i.test(message)?409:
     /invalid|unsupported|required/i.test(message)?400:503;
   return reply(res,status,'application/json',JSON.stringify({error:message}));
  }
 };
}
export function startOwnerDashboard({ownerPassword,musePassword,ledger,port=7359,
   readTransport='git'}={}){
 if(!ledger)throw Error('Private ledger client required');
 const handler=ownerDashboardHandler({
  readState:async()=>readTransport==='git'
    ?readLedgerViaGit({repo:ledger.repo,token:ledger.token})
    :(await ledger.verifyPrivate(),(await ledger.load()).state),
  editState:async(edit,opts)=>{
   const result=await ledger.transaction(state=>{
    const updated=applyOwnerDashboardEdit(state,edit,opts);
    return JSON.stringify(updated)===JSON.stringify(state)?null:updated;
   });
   return result.state;
  },ownerPassword,musePassword
 });
 const server=http.createServer((req,res)=>handler(req,res).catch(()=>{
   if(!res.headersSent)reply(res,503,'application/json',JSON.stringify({error:'Dashboard unavailable'}));
 }));
 server.listen(port,'127.0.0.1');
 return server;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const token=process.env.DISPATCH_LEDGER_TOKEN;
 const ownerPassword=process.env.DASHBOARD_OWNER_PASSWORD;
 if(!token||!ownerPassword){
  console.error('Private ledger token and DASHBOARD_OWNER_PASSWORD required');
  process.exitCode=1;
 }else{
  // Git transport is supported by the existing GitHubLedger transaction API.
  // Never use the public Pages site or a public HTTP bind for this service.
  const ledger=new GitHubLedger({repo:settings.ledger.repo,token,path:settings.ledger.path});
  startOwnerDashboard({ledger,ownerPassword,
   musePassword:process.env.DASHBOARD_MUSE_PASSWORD,
   port:Number(process.env.DASHBOARD_PORT)||7359,
   readTransport:process.env.DASHBOARD_READ_TRANSPORT==='api'?'api':'git'});
  console.log('Private dashboard bound to 127.0.0.1 only');
 }
}

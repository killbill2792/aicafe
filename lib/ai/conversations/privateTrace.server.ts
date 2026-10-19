import "server-only";
import {AsyncLocalStorage} from "node:async_hooks";
import type {ConversationScope} from "./contracts";

/**
 * Owner-scoped full-fidelity pilot investigation trace. The production console
 * remains metadata-only; readable owner content must NEVER enter Vercel logs.
 * Capture is opt-in and stored behind the existing authenticated Supabase RLS.
 * No authorization headers, API keys, passwords, session cookies, or tokens.
 */
export type PrivateTurnTrace={events:Record<string,unknown>[];droppedCount:number};
type State={events:Record<string,unknown>[];bytes:number;droppedCount:number;nextSequence:number};
const context=new AsyncLocalStorage<State>();
const MAX_EVENTS=220,MAX_BYTES=480_000,MAX_EVENT_BYTES=32_000;
const secretKey=/(^|[_-])(authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|service[_-]?role|credential|session[_-]?token)($|[_-])/i;
function redact(value:unknown,depth=0):unknown {
  if(depth>14)return "[depth_limit]";
  if(Array.isArray(value))return value.slice(0,120).map(x=>redact(x,depth+1));
  if(value!==null&&typeof value==="object"){
    const out:Record<string,unknown>={};
    for(const [key,item] of Object.entries(value).slice(0,180))
      out[key]=secretKey.test(key)?"[credential_removed]":redact(item,depth+1);
    return out;
  }
  return typeof value==="string"?value.slice(0,18000):value;
}
export function recordSupervisorPrivateTrace(payload:Record<string,unknown>):void {
  const state=context.getStore();
  if(!state)return;
  const entry={sequence:state.nextSequence++,at:new Date().toISOString(),...(redact(payload) as Record<string,unknown>)};
  let encoded:string;
  try{encoded=JSON.stringify(entry);}catch{state.droppedCount++;return;}
  if(encoded.length>MAX_EVENT_BYTES||state.events.length>=MAX_EVENTS||
    state.bytes+Buffer.byteLength(encoded)>MAX_BYTES){
    state.droppedCount++;
    return;
  }
  state.bytes+=Buffer.byteLength(encoded);
  state.events.push(entry);
}
/** Always finalize and persist even when a provider, renderer, or database step throws. */
export async function withSupervisorPrivateTrace<T>(
  run:()=>Promise<T>,finish:(trace:PrivateTurnTrace)=>Promise<void>,
):Promise<T>{
  if(process.env.SUPERVISOR_PRIVATE_TRACE_ENABLED!=="true")return run();
  return context.run({events:[],bytes:0,droppedCount:0,nextSequence:0},async()=>{
    try{return await run();}
    finally{
      const current=context.getStore()!;
      try{await finish({events:current.events,droppedCount:current.droppedCount});}
      catch{console.info(JSON.stringify({event:"supervisor_private_trace",status:"write_failed"}));}
    }
  });
}
export async function persistSupervisorPrivateTrace(input:{
  scope:ConversationScope;threadId:string;ownerMessageId:string;requestId:string;
  trace:PrivateTurnTrace;
}):Promise<void>{
  const {createServerSupabaseClient}=await import("@/lib/supabase/server");
  const client=await createServerSupabaseClient();
  const {error}=await client.from("supervisor_turn_traces").insert({
    business_id:input.scope.businessId,
    owner_user_id:input.scope.ownerUserId,
    thread_id:input.threadId,
    owner_message_id:input.ownerMessageId,
    request_id:input.requestId,
    events:input.trace.events,
    dropped_count:input.trace.droppedCount,
  });
  if(error)console.info(JSON.stringify({event:"supervisor_private_trace",status:"write_failed"}));
}

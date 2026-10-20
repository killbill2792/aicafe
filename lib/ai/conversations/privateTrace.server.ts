import "server-only";
import {AsyncLocalStorage} from "node:async_hooks";
import {gzipSync} from "node:zlib";
import {createHash} from "node:crypto";
import {aggregateModelCallCosts,type ModelCallCostRecord} from "@/lib/calc/supervisorTokenCost";

/**
 * Ephemeral per-request trace. Never persist a raw trace or emit its payload
 * to Vercel; only operational, allowlisted statistics are sent to console.
 * The console has its own short retention (on Vercel Free), not our database TTL.
 */
export type PrivateTurnTrace={events:Record<string,unknown>[];droppedCount:number};
type State={events:Record<string,unknown>[];bytes:number;droppedCount:number;nextSequence:number};
const context=new AsyncLocalStorage<State>();
const MAX_EVENTS=220,MAX_BYTES=480_000,MAX_EVENT_BYTES=32_000;
const secretKey=/(?:^|[_-])(?:authorization|password|passphrase|secret|api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|cookie|service[_-]?role|credential|session[_-]?token)(?:$|[_-])|(?:clientSecret|clientToken|apiKey|apiToken|accessToken|refreshToken|sessionToken|setCookie)/i;
const restrictedContentKey=/(?:bank.*(?:line|statement|transaction)|(?:receipt|invoice).*(?:image|scan|photo)|raw[_-]?image)/i;
/** Legacy owner-scoped trace-read gate; no new private trace rows are written. */
export function isSupervisorPrivateTraceTester(ownerUserId:string):boolean {
  return process.env.SUPERVISOR_DEBUG_RAW_LOGGING==="true"&&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerUserId);
  // Caller must still be an authenticated thread owner; Supabase RLS
  // independently checks both owner identity and business membership.
}

/** No raw bearer, quoted password or provider-key-shaped token can be retained. */
function redactSecretsInText(value:string):string {
  return value
    // Header bodies (Basic, Bearer, cookies) can contain multiple tokens. An
    // isolated label-value replacement is NOT sufficient for Basic credentials.
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*[^\r\n]+/giu,"[credential_header_removed]")
    // JSON embedded in owner chat (including camelCase clientSecret).
    .replace(/(["'](?:clientSecret|client_secret|password|passphrase|apiKey|api_key|api-token|api_token|accessToken|access_token|refreshToken|refresh_token|sessionToken|session_token|authorization|cookie|secret)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}]+)/giu,
      (_match:string,prefix:string)=>prefix+'"[credential_removed]"')
    .replace(/(\b(?:clientSecret|client_secret|apiKey|apiToken|accessToken|refreshToken|sessionToken)\s*(?:=|:|\bis\b)\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      (_match:string,prefix:string)=>prefix+"[credential_removed]")
    .replace(/\b(?:sk-(?:proj-)?[a-zA-Z0-9_-]{8,}|sb_secret_[a-zA-Z0-9_-]{8,}|github_pat_[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9_]{8,}|vercel_[a-zA-Z0-9_-]{16,})\b/gu,"[credential_removed]")
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/-]{8,}=?\b/giu,"Bearer [credential_removed]")
    .replace(/(\b(?:password|passphrase|api[\s_-]?(?:key|token)|access[\s_-]?token|refresh[\s_-]?token|session[\s_-]?token|authorization|secret)\s*(?:=|:|\bis\b)\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      (_match:string,label:string)=>label+"[credential_removed]")
    .replace(/(https?:\/\/[^/:@\s]+:)[^@\s/]+@/giu,"$1[credential_removed]@")
    // A transaction line must not become a diagnostic log, even when an
    // owner pastes it into a chat request rather than using the bank importer.
    .replace(/(^|[\s:])\s*(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})\s+[^\r\n]{1,160}?\s+(?:-?\s*[$€£]\s*[\d,]+\.\d{2}|-?[\d,]+\.\d{2})(?=\s*(?:\n|$))/gmu,
      "$1[bank_line_removed]")
    .replace(/(^|[\s:])(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2})[,\t;]\s*(?:"[^"\r\n]{1,180}"|[^,\r\n]{1,180})[,\t;]\s*"?-?(?:[$€£]\s*)?[\d,]+\.\d{2}"?(?=\s*(?:[,;\t\r\n]|$))/gmu,
      "$1[bank_line_removed]")
    .replace(/\bdata:image\/[a-z0-9+.-]+;base64,[a-z0-9+/=]+/giu,"[inline_image_removed]");
}
function redact(value:unknown,state:State,depth=0):unknown {
  if(depth>24){state.droppedCount++;return "[depth_limit]";}
  if(Array.isArray(value))return value.map(x=>redact(x,state,depth+1));
  if(value!==null&&typeof value==="object"){
    const out:Record<string,unknown>={};
    for(const [key,item] of Object.entries(value))
      out[key]=secretKey.test(key)?"[credential_removed]":
        restrictedContentKey.test(key)?"[restricted_source_content_removed]":redact(item,state,depth+1);
    return out;
  }
  return typeof value==="string"?redactSecretsInText(value):value;
}
export function recordSupervisorPrivateTrace(payload:Record<string,unknown>):void {
  const state=context.getStore();
  if(!state)return;
  let entry:Record<string,unknown>={sequence:state.nextSequence++,at:new Date().toISOString(),
    ...(redact(payload,state) as Record<string,unknown>)};
  let encoded:string;
  try{
    encoded=JSON.stringify(entry);
    if(Buffer.byteLength(encoded)>4096){
      const originalBytes=Buffer.byteLength(encoded);
      const digest=createHash("sha256").update(encoded).digest("hex");
      // Preserve full redacted content, including every R1/R2/... field, in
      // a compressed event with an integrity checksum for reconstruction.
      // Responses schemas/context often exceed console-sized records. Preserve
      // the ENTIRE credential-filtered event instead of silently dropping it.
      entry={sequence:entry.sequence,at:entry.at,point:entry.point,
        encoding:"gzip-base64",originalBytes,digestSha256:digest,
        data:gzipSync(Buffer.from(encoded,"utf8")).toString("base64")};
      encoded=JSON.stringify(entry);
    }
  }catch{state.droppedCount++;return;}
  const bytes=Buffer.byteLength(encoded);
  if(bytes>MAX_EVENT_BYTES||state.events.length>=MAX_EVENTS||
    state.bytes+bytes>MAX_BYTES){
    state.droppedCount++;
    return;
  }
  state.bytes+=bytes;
  state.events.push(entry);
}
/** Always finalize and persist even when a provider, renderer, or database step throws. */
export async function withSupervisorPrivateTrace<T>(
  run:()=>Promise<T>,finish:(trace:PrivateTurnTrace)=>Promise<void>,
):Promise<T>{
  if(process.env.SUPERVISOR_DEBUG_RAW_LOGGING!=="true")return run();
  const startedAt=Date.now();
  return context.run({events:[],bytes:0,droppedCount:0,nextSequence:0},async()=>{
    try{return await run();}
    finally{
      const current=context.getStore()!;
      const usageEntries=current.events.filter(e=>e.point==="model_usage");
      const rows:ModelCallCostRecord[]=usageEntries.flatMap(e=>{
        if(typeof e.model!=="string"||!e.usage||typeof e.usage!=="object")return [];
        const usage=e.usage as Record<string,unknown>;
        const inputs=["inputTokens","cachedInputTokens","outputTokens","reasoningOutputTokens"] as const;
        if(inputs.some(k=>typeof usage[k]!=="number"||!Number.isSafeInteger(usage[k])||
          (usage[k] as number)<0))return [];
        return [{model:e.model as string,requestName:String(e.requestName??"unknown"),
          inputTokens:usage.inputTokens as number,cachedInputTokens:usage.cachedInputTokens as number,
          outputTokens:usage.outputTokens as number,
          reasoningOutputTokens:usage.reasoningOutputTokens as number,
          estimatedCostMicros:typeof e.estimatedCostMicros==="number"?
            e.estimatedCostMicros:null}];
      });
      const expectedModelRequests=current.events.filter(e=>e.point==="model_request").length;
      const totals=aggregateModelCallCosts(rows);
      const missingUsageResponses=Math.max(0,expectedModelRequests-rows.length);
      const traceDropped=current.droppedCount>0;
      const costCoverageIncomplete=missingUsageResponses>0||totals.unpricedCalls>0;
      recordSupervisorPrivateTrace({point:"trace_summary",durationMs:Date.now()-startedAt,
        costUnit:"USD_micro",pricingKind:"token_rate_estimate_not_invoice",
        ...totals,
        estimatedCostMicros:missingUsageResponses?null:totals.estimatedCostMicros,
        unpricedCalls:totals.unpricedCalls+missingUsageResponses,
        expectedModelRequests,observedUsageResponses:rows.length,
        missingUsageResponses,
        captureComplete:!traceDropped,tokenCostComplete:!costCoverageIncomplete,
        priorDroppedCount:current.droppedCount});
      try{await finish({events:current.events,droppedCount:current.droppedCount});}
      catch{console.info(JSON.stringify({event:"supervisor_private_trace",status:"write_failed"}));}
    }
  });
}

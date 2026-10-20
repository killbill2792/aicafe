import {gunzipSync} from "node:zlib";
import {createHash} from "node:crypto";
import {isSupervisorPrivateTraceTester} from "@/lib/ai/conversations/privateTrace.server";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {conversationError,conversationJson,parseInput} from "@/lib/ai/conversations/http.server";
import {threadIdInput} from "@/lib/ai/conversations/contracts";

export const runtime="nodejs";
export const dynamic="force-dynamic";
type RouteContext={params:Promise<{threadId:string}>};
/**
 * Reconstitute recorded events to exactly their post-redaction source objects.
 * An integrity or size mismatch is an explicit error, not a partial R1 value.
 */
function expandTraceEvent(event:Record<string,unknown>):Record<string,unknown> {
  if(event.encoding!=="gzip-base64")return event;
  try{
    if(typeof event.data!=="string"||typeof event.originalBytes!=="number"||
      typeof event.digestSha256!=="string")throw Error("invalid_compressed_event");
    const compressed=Buffer.from(event.data,"base64");
    const raw=gunzipSync(compressed,{maxOutputLength:8_000_000});
    if(raw.byteLength!==event.originalBytes||
      createHash("sha256").update(raw).digest("hex")!==event.digestSha256)
      throw Error("trace_integrity_mismatch");
    const decoded:unknown=JSON.parse(raw.toString("utf8"));
    if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))
      throw Error("invalid_trace_event");
    return decoded as Record<string,unknown>;
  }catch{
    return {sequence:event.sequence,point:event.point,at:event.at,
      integrity:"failed",reason:"trace_event_corrupted_or_unreadable"};
  }
}

/** Private owner-only diagnostic download. Never expose these traces in console logs. */
export async function GET(request:Request,context:RouteContext){
  try{
    const {threadId}=await context.params;
    const id=parseInput(threadIdInput,threadId);
    const {service,scope}=await authenticatedConversationContext();
    if(!isSupervisorPrivateTraceTester(scope.ownerUserId))
      return conversationJson({error:"not_found"},404);
    await service.getThread(id);
    const client=await createServerSupabaseClient();
    const url=new URL(request.url);
    const requestId=url.searchParams.get("requestId");
    if(requestId!==null&&!/^[a-zA-Z0-9_.:-]{1,80}$/.test(requestId))
      return conversationJson({error:"invalid_request_id"},400);
    let query=client.from("supervisor_turn_traces")
      .select("request_id,created_at,events,dropped_count,owner_message_id")
      .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
      .eq("thread_id",id).order("created_at",{ascending:false}).limit(10);
    if(requestId)query=query.eq("request_id",requestId);
    const {data,error}=await query;
    if(error)throw error;
    // Listing multiple turns is metadata-only to avoid expensive multi-MB
    // transfer. An exact requestId gets its full ordered, expanded event stream.
    const traces=(data??[]).map(t=>{
      const events=Array.isArray(t.events)?t.events:[];
      return {...t,
        eventCount:events.length,
        ...(requestId?{events:events.map(e=>expandTraceEvent(e as Record<string,unknown>))}:
          {events:undefined}),
      };
    });
    return conversationJson({traces},200);
  }catch(error){return conversationError(error);}
}

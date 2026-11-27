import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {noteAvailability,openSourceStream,type Source} from "@/lib/externalData/archive.server";
import {readProviderPages} from "@/lib/externalData/pages";
import {createToastClient,GUID,ToastApiError} from "./client";
import {TOAST_READ_ENDPOINTS} from "./readOperations";

const collections=TOAST_READ_ENDPOINTS.filter(op=>op.path.startsWith("/config/")&&op.scope==="none");
const configObject=z.record(z.string(),z.unknown());
const response=z.union([z.array(configObject),configObject]);
const dayMs=86_400_000;

/** Refresh existing configuration collections through the normal optional POS
 * sync. A persisted next page resumes from the archive's guarded checkpoint. */
export async function refreshToastConfiguration(db:SupabaseClient,source:Source,now:Date,deadlineAt:number) {
  const {data,error}=await db.from("external_resources").select("resource,status,last_complete_at,last_attempt_at,retry_at")
    .eq("business_id",source.businessId).eq("provider",source.provider).eq("source_account",source.account)
    .in("resource",collections.map(op=>op.endpoint));
  if(error)throw new ToastApiError("unavailable");
  const previous=new Map(data?.map(row=>[row.resource,row]));
  const due=collections.filter(op=>{
    const state=previous.get(op.endpoint);
    return !(state?.retry_at&&Date.parse(state.retry_at)>now.getTime()) &&
      !(state?.status==="current"&&state.last_complete_at&&Date.parse(state.last_complete_at)>now.getTime()-dayMs);
  }).sort((a,b)=>(previous.get(a.endpoint)?.last_attempt_at??"")
    .localeCompare(previous.get(b.endpoint)?.last_attempt_at??""));
  const client=createToastClient(db,source.businessId);
  for(const op of due){
    if(Date.now()>=deadlineAt)break;
    const stream=await openSourceStream(db,source,op.endpoint,"current");
    const resume=typeof stream.cursor==="string" ? stream.cursor : null;
    try{
      await readProviderPages(async cursor=>{
        let next:string|null=null;
        const path=cursor ? op.path+"?pageToken="+encodeURIComponent(cursor) : op.path;
        const raw=await client.request(path,source.account,response,{
          deadlineAt,onResponse:meta=>{next=meta.nextPageToken;},
        });
        const list=Array.isArray(raw);
        const records=(list ? raw : [raw]).map(payload=>{
          const guid=GUID.safeParse(payload.guid);
          if(list&&!guid.success)throw new ToastApiError("invalid_response");
          if(typeof payload.restaurantGuid==="string"&&payload.restaurantGuid.toLowerCase()!==source.account.toLowerCase())
            throw new ToastApiError("unauthorized_location");
          return {key:guid.success ? guid.data : "singleton",payload};
        });
        return {items:[],next,commit:()=>stream.commit(records,next,next===null)};
      },undefined,resume);
    }catch(error){
      const failure=error instanceof ToastApiError ? error : null;
      if(resume&&failure?.status===400){
        // Expired provider cursors restart from page one on the next run.
        await stream.commit([],null,false);
      }
      const status=failure?.status===403?"permission_required":failure?.status===204?"unsupported":
        failure?.category==="invalid_response"||failure?.status===400?"incomplete":"unavailable";
      const retryAt=failure?.retryAt??new Date(Date.now()+
        (status==="permission_required"||status==="unsupported" ? dayMs : 900_000)).toISOString();
      await noteAvailability(db,source,op.endpoint,status,new Date().toISOString(),retryAt);
      if(failure?.status===429||failure?.status===401)throw error;
    }
  }
}

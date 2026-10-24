/** Save through the existing owner-authorized route, then run real scope verification.
 * Never claim 'connected' merely because encrypted credentials were stored. */
export type ToastConnectionConfig={
 businessId:string;apiUrl:string;clientId:string;clientSecret:string;
 locations:{location_id:string;restaurant_guid:string}[];
};
type Outcome={saved:boolean;verified:boolean;error?:string};
export async function saveThenVerifyToastConnection(
 config:ToastConnectionConfig,request:typeof fetch=fetch
):Promise<Outcome>{
 const headers={"Content-Type":"application/json"};
 const saved=await request("/api/pos/toast",{
   method:"POST",headers,body:JSON.stringify(config)
 });
 const first=await saved.json().catch(()=>({})) as {error?:string};
 if(!saved.ok)return {saved:false,verified:false,error:first.error??"unavailable"};
 try{
   const tested=await request("/api/pos/toast/test",{
     method:"POST",headers,body:JSON.stringify({businessId:config.businessId})
   });
   const result=await tested.json().catch(()=>({})) as {error?:string;state?:string};
   if(!tested.ok||result.state!=="verified")
     return {saved:true,verified:false,error:result.error??"unavailable"};
   return {saved:true,verified:true};
 }catch{
   return {saved:true,verified:false,error:"unavailable"};
 }
}

/** One truthful owner-facing status regardless of backend diagnostic state. */
export function toastStatus(state:string|null|undefined,hasSyncFailure=false):"notConnected"|"connected"|"needsAttention" {
 if(!state||state==="not_connected"||state==="disconnected")return "notConnected";
 return state==="verified"&&!hasSyncFailure?"connected":"needsAttention";
}
export function latestToastSync(locations:{
 last_order_fetch_at:string|null;last_time_entry_fetch_at:string|null;
 last_schedule_fetch_at:string|null;last_menu_fetch_at:string|null
}[]|undefined):string|null {
 const timestamps=(locations??[]).flatMap(row=>
  [row.last_order_fetch_at,row.last_time_entry_fetch_at,row.last_schedule_fetch_at,row.last_menu_fetch_at])
  .filter((value):value is string=>value!==null&&Number.isFinite(Date.parse(value)));
 return timestamps.sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??null;
}

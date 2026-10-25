import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {decryptToken,encryptToken} from "@/lib/security/tokenCrypto";

export type ToastFailure = "invalid_host"|"authentication"|"missing_permissions"|"missing_scope_or_location"|"unauthorized_location"|"rate_limited"|"timeout"|"unavailable"|"invalid_response"|"not_configured";
export class ToastApiError extends Error {
  constructor(public readonly category:ToastFailure, public readonly status?:number, public readonly retryAt?:string) {
    super("Toast request failed: "+category);
    this.name="ToastApiError";
  }
}
// Toast identifiers are RFC-4122-formatted UUIDs of more than one version.
export const GUID=z.uuid();
const tokenSchema=z.object({token:z.object({accessToken:z.string().min(1),expiresIn:z.number().positive()})});
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Toast requires a numeric timezone offset without the ISO colon; query-string
 * plus signs must be percent-encoded. The existing UTC-offset convention is safe. */
export function toToastTimestamp(date:Date,offsetMinutes=0):string {
 if(!Number.isFinite(date.getTime())||!Number.isInteger(offsetMinutes)||Math.abs(offsetMinutes)>14*60)
   throw new ToastApiError("invalid_response");
 const shifted=new Date(date.getTime()+offsetMinutes*60000);
 const hh=String(Math.floor(Math.abs(offsetMinutes)/60)).padStart(2,"0");
 const mm=String(Math.abs(offsetMinutes)%60).padStart(2,"0");
 return encodeURIComponent(shifted.toISOString().slice(0,-1)+(offsetMinutes<0?"-":"+")+hh+mm);
}
const lastRequestAt=new Map<string,number>();
async function throttle(bucket:string,gapMs:number,deadlineAt?:number) {
 const now=Date.now(),until=Math.max(now,lastRequestAt.get(bucket)??0)+gapMs;
 if(deadlineAt&&until>=deadlineAt)throw new ToastApiError("rate_limited",429,new Date(until).toISOString());
 lastRequestAt.set(bucket,until);
 if(until>now)await wait(until-now);
}

/** HTTPS, explicit operator-controlled hostnames, no redirects or arbitrary server-side URLs. */
export function trustedToastOrigin(input:string,allowed=process.env.TOAST_ALLOWED_API_HOSTS??""):string {
  let u:URL;
  try {u=new URL(input.includes("://")?input:"https://"+input);}catch {throw new ToastApiError("invalid_host");}
  const allow=allowed.split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
  if(u.protocol!=="https:"||u.username||u.password||u.port||u.pathname!=="/"||u.search||u.hash||
    !u.hostname.endsWith(".toasttab.com")||!allow.includes(u.hostname.toLowerCase()))
    throw new ToastApiError("invalid_host");
  return u.origin;
}
function failure(status:number,context:"authentication"|"restaurant"|"resource"="resource"):ToastApiError {
  if(status===401)return new ToastApiError("authentication",status);
  if(status===403)return new ToastApiError(context==="restaurant"?"unauthorized_location":"missing_permissions",status);
  if(status===429)return new ToastApiError("rate_limited",status);
  return new ToastApiError("unavailable",status);
}
export function toastRetryAt(response:Response,now=Date.now()):string {
  const raw=response.headers.get("retry-after");
  let ms=Number.NaN;
  if(raw&&/^\d+(?:\.\d+)?$/.test(raw))ms=now+Number(raw)*1000;
  else if(raw)ms=Date.parse(raw);
  const reset=response.headers.get("x-toast-ratelimit-reset");
  if(reset&&/^\d+(?:\.\d+)?$/.test(reset))ms=Math.max(ms||0,Number(reset)*1000);
  if(!Number.isFinite(ms)||ms<now)ms=now+1500;
  // Invalid enormous reset dates must not crash Date.toISOString or cause an early retry.
  if(ms>8640000000000000)throw new ToastApiError("invalid_response",429);
  return new Date(ms).toISOString();
}
type Credential={api_origin:string;client_id:string;client_secret_enc:string;
  bearer_token_enc:string|null;bearer_expires_at:string|null;retry_after:string|null};
const MIN_VALIDITY_MS=600000;
const inflight=new Map<string,Promise<string>>();
/** Persisted encrypted tokens + a nonce lease across isolated Vercel invocations. */
export function createToastClient(db:SupabaseClient,businessId:string) {
  async function row():Promise<Credential> {
    const {data,error}=await db.from("toast_api_credentials")
      .select("api_origin,client_id,client_secret_enc,bearer_token_enc,bearer_expires_at,retry_after")
      .eq("business_id",businessId).neq("state","disconnected").maybeSingle();
    if(error||!data)throw new ToastApiError("not_configured");
    trustedToastOrigin(data.api_origin);
    return data as Credential;
  }
  function validCached(current:Credential):string|null {
    return current.bearer_token_enc&&current.bearer_expires_at&&
      Date.parse(current.bearer_expires_at)>Date.now()+MIN_VALIDITY_MS
      ?decryptToken(current.bearer_token_enc):null;
  }
  async function token():Promise<string> {
    const initial=await row();
    const cached=validCached(initial);
    if(cached)return cached;
    if(initial.retry_after&&Date.parse(initial.retry_after)>Date.now())
      throw new ToastApiError("rate_limited",429,initial.retry_after);
    const existing=inflight.get(businessId);
    if(existing)return existing;
    const refresh=(async()=>{
      for(let attempt=0;attempt<22;attempt++){
        const current=await row();
        const reuse=validCached(current);
        if(reuse)return reuse;
        if(current.retry_after&&Date.parse(current.retry_after)>Date.now())
          throw new ToastApiError("rate_limited",429,current.retry_after);
        const {data:claimed,error:claimError}=await db.rpc("toast_claim_auth_lease",{p_business_id:businessId});
        if(claimError)throw new ToastApiError("unavailable");
        if(!claimed){await wait(400);continue;}
        try{
          // A token may have been refreshed while this worker claimed its lease.
          const latest=await row(),already=validCached(latest);
          if(already)return already;
          const origin=trustedToastOrigin(latest.api_origin);
          let res:Response;
          try {
            res=await fetch(origin+"/authentication/v1/authentication/login",{
              method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({clientId:latest.client_id,
                clientSecret:decryptToken(latest.client_secret_enc),
                userAccessType:"TOAST_MACHINE_CLIENT"}),
            });
          }catch {throw new ToastApiError("timeout");}
          if(!res.ok){
            if(res.status===429){
              const retryAt=toastRetryAt(res);
              const {error:saveError}=await db.from("toast_api_credentials")
                .update({retry_after:retryAt}).eq("business_id",businessId);
              if(saveError)throw new ToastApiError("unavailable");
              throw new ToastApiError("rate_limited",429,retryAt);
            }
            throw failure(res.status,"authentication");
          }
          const parsed=tokenSchema.safeParse(await res.json().catch(()=>null));
          if(!parsed.success)throw new ToastApiError("invalid_response");
          const {accessToken,expiresIn}=parsed.data.token;
          const {data:committed,error:saveError}=await db.rpc("toast_commit_auth_token",{
            p_business_id:businessId,p_lease_nonce:claimed,
            p_ciphertext:encryptToken(accessToken),
            p_expires_at:new Date(Date.now()+expiresIn*1000).toISOString(),
          });
          if(saveError)throw new ToastApiError("unavailable");
          if(!committed)continue; // Lease expired or credential rotated. Never use stale token.
          return accessToken;
        } finally {
          await db.rpc("toast_release_auth_lease",{p_business_id:businessId,p_lease_nonce:claimed});
        }
      }
      throw new ToastApiError("unavailable");
    })();
    inflight.set(businessId,refresh);
    try{return await refresh;}finally{inflight.delete(businessId);}
  }
  async function request<T>(path:string,restaurantGuid:string,schema:z.ZodType<T>,
     opts:{allowUnverified?:boolean;deadlineAt?:number}={}):Promise<T> {
    const guid=GUID.safeParse(restaurantGuid);
    if(!guid.success||!path.startsWith("/")||path.startsWith("//")||path.includes("..")||path.includes("://")||
      path.includes("#")||path.includes("\\"))
      throw new ToastApiError("unauthorized_location");
    const {data:mapping,error:mapError}=await db.from("toast_location_mappings")
      .select("verified_at").eq("business_id",businessId).eq("restaurant_guid",guid.data).maybeSingle();
    if(mapError||!mapping||(!opts.allowUnverified&&!mapping.verified_at))
      throw new ToastApiError("unauthorized_location");
    const credentials=await row(),origin=trustedToastOrigin(credentials.api_origin);
    if(credentials.retry_after&&Date.parse(credentials.retry_after)>Date.now())
      throw new ToastApiError("rate_limited",429,credentials.retry_after);
    let bearer=await token();
    for(let attempt=0,authRetry=false;attempt<5;attempt++) {
      if(opts.deadlineAt&&Date.now()>=opts.deadlineAt)throw new ToastApiError("timeout");
      const bucket=path.startsWith("/orders/v2/ordersBulk")?"bulk":
        path.startsWith("/menus")?"menus":"other";
      await throttle(businessId+":"+guid.data+":"+bucket,
        bucket==="bulk"?250:bucket==="menus"?1000:100,opts.deadlineAt);
      let res:Response;
      try {
        res=await fetch(origin+path,{method:"GET",redirect:"error",signal:AbortSignal.timeout(path.startsWith("/orders/v2/ordersBulk")?30000:12000),
          headers:{"Authorization":"Bearer "+bearer,"Toast-Restaurant-External-ID":guid.data,
            "Accept":"application/json"}});
      }catch {if(attempt<4){await wait(500*2**attempt+Math.random()*200);continue;}throw new ToastApiError("unavailable");}
      if(res.status===401&&!authRetry){
        authRetry=true;
        const latest=await row();
        if(latest.bearer_token_enc&&decryptToken(latest.bearer_token_enc)!==bearer) {
          // Another instance replaced the token. Never invalidate that replacement,
          // including when the replacement is itself near expiry.
          bearer=await token();
        } else {
          // Invalidate ONLY the token actually rejected by Toast.
          const {error}=await db.rpc("toast_invalidate_token_if_match",{
            p_business_id:businessId,p_expected_ciphertext:latest.bearer_token_enc,
          });
          if(error)throw new ToastApiError("unavailable");
          bearer=await token();
        }
        continue;
      }
      if(res.status===429) {
        const retryAt=toastRetryAt(res);
        const {error:saveError}=await db.from("toast_api_credentials")
          .update({retry_after:retryAt}).eq("business_id",businessId);
        if(saveError)throw new ToastApiError("unavailable");
        const ms=Date.parse(retryAt)-Date.now();
        if(ms<=60000&&(!opts.deadlineAt||Date.now()+ms<opts.deadlineAt)){
          await wait(Math.max(0,ms));continue;
        }
        throw new ToastApiError("rate_limited",429,retryAt);
      }
      if(res.status>=500&&attempt<4){await wait(500*2**attempt+Math.random()*200);continue;}
      if(res.status===403)throw new ToastApiError("missing_scope_or_location",403);
      if(!res.ok)throw failure(res.status,path.startsWith("/restaurants/v1/")?"restaurant":"resource");
      const remaining=Number(res.headers.get("x-toast-ratelimit-remaining"));
      const reset=Number(res.headers.get("x-toast-ratelimit-reset"));
      if(res.headers.has("x-toast-ratelimit-remaining")&&remaining<3&&Number.isFinite(reset)&&reset*1000>Date.now()) {
        const next=reset*1000;
        if(next>Date.now()+60000||opts.deadlineAt&&next>=opts.deadlineAt)
          throw new ToastApiError("rate_limited",429,new Date(next).toISOString());
        await wait(Math.max(0,next-Date.now()));
      }
      const raw=await res.json().catch(()=>{throw new ToastApiError("invalid_response");});
      const parsed=schema.safeParse(raw);
      if(!parsed.success)throw new ToastApiError("invalid_response");
      return parsed.data;
    }
    throw new ToastApiError("unavailable");
  }
  async function fetchRestaurantInfo(restaurantGuid:string,allowUnverified=false,deadlineAt?:number) {
    return request("/restaurants/v1/restaurants/"+restaurantGuid,restaurantGuid,
      z.object({guid:GUID,general:z.object({timeZone:z.string().min(1),
      closeoutHour:z.number().int().min(0).max(12),
      name:z.string().nullish()})}),{allowUnverified,deadlineAt});
  }
  return {request,fetchRestaurantInfo};
}

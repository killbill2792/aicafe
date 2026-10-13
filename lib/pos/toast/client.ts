import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import {decryptToken,encryptToken} from "@/lib/security/tokenCrypto";

export type ToastFailure = "invalid_host"|"authentication"|"missing_permissions"|"unauthorized_location"|"rate_limited"|"timeout"|"unavailable"|"invalid_response"|"not_configured";
export class ToastApiError extends Error {
  constructor(public readonly category:ToastFailure, public readonly status?:number) {
    super("Toast request failed: "+category);
    this.name="ToastApiError";
  }
}
export const GUID = z.uuid();
const tokenSchema=z.object({token:z.object({accessToken:z.string().min(1),expiresIn:z.number().positive()})});
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Enforce HTTPS, no credentials/query/path, Toast ownership, and operator-controlled exact host list. */
export function trustedToastOrigin(input:string,allowed=process.env.TOAST_ALLOWED_API_HOSTS??""):string {
  let u:URL;
  try {u=new URL(input.includes("://")?input:"https://"+input);}catch {throw new ToastApiError("invalid_host");}
  const allow=allowed.split(",").map(v=>v.trim().toLowerCase()).filter(Boolean);
  if(u.protocol!=="https:"||u.username||u.password||u.port||u.pathname!=="/"||u.search||u.hash||
    !u.hostname.endsWith(".toasttab.com")||!allow.includes(u.hostname.toLowerCase()))
    throw new ToastApiError("invalid_host");
  return u.origin;
}
function failure(status:number):ToastApiError {
  if(status===401)return new ToastApiError("authentication",status);
  if(status===403)return new ToastApiError("missing_permissions",status);
  if(status===404)return new ToastApiError("unauthorized_location",status);
  if(status===429)return new ToastApiError("rate_limited",status);
  return new ToastApiError("unavailable",status);
}
function retryMs(response:Response,attempt:number) {
  const header=response.headers.get("retry-after");
  const seconds=header&&/^\d+$/.test(header)?Number(header):null;
  return Math.min(10000,seconds===null?300*2**attempt:seconds*1000);
}
type Credential={api_origin:string;client_id:string;client_secret_enc:string;bearer_token_enc:string|null;bearer_expires_at:string|null};
const MIN_VALIDITY_MS=120000;
const inflight=new Map<string,Promise<string>>();
/** Uses encrypted persisted bearer tokens and an atomic DB lease across Vercel instances. */
export function createToastClient(db:SupabaseClient,businessId:string) {
  async function row():Promise<Credential> {
    const {data,error}=await db.from("toast_api_credentials")
      .select("api_origin,client_id,client_secret_enc,bearer_token_enc,bearer_expires_at")
      .eq("business_id",businessId).neq("state","disconnected").maybeSingle();
    if(error||!data)throw new ToastApiError("not_configured");
    trustedToastOrigin(data.api_origin);
    return data as Credential;
  }
  async function token(force=false):Promise<string> {
    const initial=await row();
    if(!force&&initial.bearer_token_enc&&initial.bearer_expires_at&&
       Date.parse(initial.bearer_expires_at)>Date.now()+MIN_VALIDITY_MS)
      return decryptToken(initial.bearer_token_enc);
    const existing=inflight.get(businessId);
    if(existing)return existing;
    const refresh=(async()=>{
      for(let attempt=0;attempt<20;attempt++){
        const current=await row();
        if((!force||attempt>0)&&current.bearer_token_enc&&current.bearer_expires_at&&
           Date.parse(current.bearer_expires_at)>Date.now()+MIN_VALIDITY_MS)
          return decryptToken(current.bearer_token_enc);
        const {data:claimed,error:claimError}=await db.rpc("toast_claim_auth_lease",{p_business_id:businessId});
        if(claimError)throw new ToastApiError("unavailable");
        if(!claimed){await wait(450);continue;}
        try{
          const origin=trustedToastOrigin(current.api_origin);
          let res:Response;
          try {
            res=await fetch(origin+"/authentication/v1/authentication/login",{
              method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),
              headers:{"Content-Type":"application/json"},
              body:JSON.stringify({clientId:current.client_id,
                clientSecret:decryptToken(current.client_secret_enc),
                userAccessType:"TOAST_MACHINE_CLIENT"}),
            });
          }catch {throw new ToastApiError("timeout");}
          if(!res.ok)throw failure(res.status);
          const parsed=tokenSchema.safeParse(await res.json().catch(()=>null));
          if(!parsed.success)throw new ToastApiError("invalid_response");
          const {accessToken,expiresIn}=parsed.data.token;
          const {data:committed,error:saveError}=await db.rpc("toast_commit_auth_token",{
            p_business_id:businessId,p_lease_nonce:claimed,
            p_ciphertext:encryptToken(accessToken),
            p_expires_at:new Date(Date.now()+expiresIn*1000).toISOString(),
          });
          if(saveError||!committed)throw new ToastApiError("unavailable");
          return accessToken;
        } finally {
          // Clear the lease after failed logins too; a later attempt may retry.
          await db.rpc("toast_release_auth_lease",{p_business_id:businessId,p_lease_nonce:claimed});
        }
      }
      throw new ToastApiError("unavailable");
    })();
    inflight.set(businessId,refresh);
    try{return await refresh;}finally{inflight.delete(businessId);}
  }
  async function request<T>(path:string,restaurantGuid:string,schema:z.ZodType<T>,
     opts:{allowUnverified?:boolean}={}):Promise<T> {
    const guid=GUID.safeParse(restaurantGuid);
    if(!guid.success||!path.startsWith("/")||path.startsWith("//")||path.includes("..")||path.includes("://"))
      throw new ToastApiError("unauthorized_location");
    const {data:mapping,error:mapError}=await db.from("toast_location_mappings")
      .select("verified_at").eq("business_id",businessId).eq("restaurant_guid",guid.data).maybeSingle();
    if(mapError||!mapping||(!opts.allowUnverified&&!mapping.verified_at))
      throw new ToastApiError("unauthorized_location");
    const origin=trustedToastOrigin((await row()).api_origin);
    let bearer=await token();
    for(let attempt=0;attempt<4;attempt++) {
      let res:Response;
      try {
        res=await fetch(origin+path,{method:"GET",redirect:"error",signal:AbortSignal.timeout(12000),
          headers:{"Authorization":"Bearer "+bearer,"Toast-Restaurant-External-ID":guid.data,
            "Accept":"application/json"}});
      }catch {if(attempt<2){await wait(300*2**attempt);continue;}throw new ToastApiError("timeout");}
      if(res.status===401&&attempt===0){
        await db.from("toast_api_credentials").update({bearer_token_enc:null,bearer_expires_at:null}).eq("business_id",businessId);
        bearer=await token(true);continue;
      }
      if((res.status===429||res.status>=500)&&attempt<3){await wait(retryMs(res,attempt));continue;}
      if(!res.ok)throw failure(res.status);
      const raw=await res.json().catch(()=>{throw new ToastApiError("invalid_response");});
      const parsed=schema.safeParse(raw);
      if(!parsed.success)throw new ToastApiError("invalid_response");
      return parsed.data;
    }
    throw new ToastApiError("unavailable");
  }
  return {request};
}

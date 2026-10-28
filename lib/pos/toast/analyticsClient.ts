import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createHash} from "node:crypto";
import {z} from "zod";
import {decryptToken,encryptToken} from "@/lib/security/tokenCrypto";
import {GUID,ToastApiError,trustedToastOrigin,toastRetryAt} from "./client";

const tokenSchema=z.object({token:z.object({
 accessToken:z.string().min(1),expiresIn:z.number().positive()
})});
const reportGuid=GUID;
const reports=z.array(z.object({
 restaurantGuid:GUID,businessDate:z.string().regex(/^\d{8}$/),
 netSalesAmount:z.number().finite(),ordersCount:z.number().int(),
 discountAmount:z.number().finite(),refundAmount:z.number().finite(),
 voidOrdersCount:z.number().int().nonnegative(),
 voidOrdersAmount:z.number().finite().nullish()
}).passthrough());
type Credential={api_origin:string;client_id:string;client_secret_enc:string;
 management_group_guid:string;bearer_token_enc:string|null;bearer_expires_at:string|null};
export function createToastAnalyticsClient(db:SupabaseClient,businessId:string,deadlineAt:number){
 const deadline=()=>{const time=deadlineAt-Date.now();if(time<=0)throw new ToastApiError("timeout");return Math.min(12000,time);};
 async function credentials():Promise<Credential>{
  const {data,error}=await db.from("toast_analytics_credentials")
   .select("api_origin,client_id,client_secret_enc,management_group_guid,bearer_token_enc,bearer_expires_at")
   .eq("business_id",businessId).maybeSingle();
  if(error||!data)throw new ToastApiError("not_configured");
  trustedToastOrigin(data.api_origin);
  return data as Credential;
 }
 async function login(force=false):Promise<{origin:string;bearer:string}>{
  const c=await credentials(),origin=trustedToastOrigin(c.api_origin);
  if(!force&&c.bearer_token_enc&&c.bearer_expires_at&&
   Date.parse(c.bearer_expires_at)>Date.now()+600000)
   return {origin,bearer:decryptToken(c.bearer_token_enc)};
  const {data:lease,error:leaseError}=await db.rpc("toast_claim_auth_lease",{p_business_id:businessId});
  if(leaseError||!lease)throw new ToastApiError("unavailable");
  try{
  let res:Response;
  try{res=await fetch(origin+"/authentication/v1/authentication/login",{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(deadline()),
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({clientId:c.client_id,clientSecret:decryptToken(c.client_secret_enc),
      userAccessType:"TOAST_MACHINE_CLIENT"})
  });}catch{throw new ToastApiError("unavailable");}
  if(res.status===401)throw new ToastApiError("authentication",401);
  if(res.status===403)throw new ToastApiError("missing_permissions",403);
  if(!res.ok)throw new ToastApiError("unavailable");
  const parsed=tokenSchema.safeParse(await res.json().catch(()=>null));
  if(!parsed.success)throw new ToastApiError("invalid_response");
  const {accessToken,expiresIn}=parsed.data.token;
  const {error}=await db.from("toast_analytics_credentials").update({
   bearer_token_enc:encryptToken(accessToken),
   bearer_expires_at:new Date(Date.now()+expiresIn*1000).toISOString(),
   last_error_category:null
  }).eq("business_id",businessId).eq("client_secret_enc",c.client_secret_enc);
  if(error)throw new ToastApiError("unavailable");
  return {origin,bearer:accessToken};
  }finally{await db.rpc("toast_release_auth_lease",{p_business_id:businessId,p_lease_nonce:lease});}

 }
 async function rate(kind:"post"|"get"){
  const {data,error}=await db.rpc("toast_claim_era_request",{
   p_business_id:businessId,p_kind:kind});
  if(error)throw new ToastApiError("unavailable");
  if(!data)throw new ToastApiError("rate_limited",429,
   new Date(Date.now()+10000).toISOString());
 }
 async function call(kind:"post"|"get",path:string,body?:unknown){
  await rate(kind);
  const credential=await credentials();
  const hash=createHash("sha256").update(credential.client_id).digest("hex");
  let auth=await login();
  for(let attempt=0;attempt<2;attempt++){
   deadline();
   const {data:blocked,error:be}=await db.rpc("toast_claim_client_budget",{p_hash:hash,p_block_until:null});
   if(be)throw new ToastApiError("unavailable");
   if(blocked)throw new ToastApiError("rate_limited",429,String(blocked));
   let res:Response;
   try{
    res=await fetch(auth.origin+path,{
     method:kind==="post"?"POST":"GET",
     redirect:"error",signal:AbortSignal.timeout(deadline()),
     headers:{Authorization:"Bearer "+auth.bearer,
      Accept:"application/json",...(kind==="post"?{"Content-Type":"application/json"}:{})},
     ...(kind==="post"?{body:JSON.stringify(body)}:{})
    });
   }catch{throw new ToastApiError("unavailable");}
   if(res.status===429||res.headers.has("x-toast-ratelimit-remaining")&&Number(res.headers.get("x-toast-ratelimit-remaining"))<3){
    const retryAt=toastRetryAt(res);
    const {error}=await db.rpc("toast_claim_client_budget",{p_hash:hash,p_block_until:retryAt});
    if(error)throw new ToastApiError("unavailable");
    if(res.status===429)throw new ToastApiError("rate_limited",429,retryAt);
   }
   if(res.status===401&&attempt===0){auth=await login(true);continue;}
   if(res.status===401)throw new ToastApiError("authentication");
   if(res.status===403)throw new ToastApiError("missing_permissions");
   if(res.status===202)return {pending:true as const,body:await res.json().catch(()=>null)};
   if(res.status===429)throw new ToastApiError("rate_limited",429);
   if(!res.ok)throw new ToastApiError("unavailable",res.status);
   return {pending:false as const,body:await res.json().catch(()=>null)};
  }
  throw new ToastApiError("authentication");
 }
 return {
  // Diagnostic API: GET only. Leverages the existing ERA-only credential,
  // rate budget and authentication without requesting or creating reports.
  async getRaw(path:string){
   if(!/^\/era\/v1\/[A-Za-z0-9/_-]+$/.test(path)||path.includes("..")||
    path.length>250)throw new ToastApiError("invalid_response");
   const result=await call("get",path);
   return {status:result.pending?202:200,data:result.body};
  },
  async test(restaurantGuid:string,businessDate:string){
   const expected=await credentials();
   const id=await this.requestDay(restaurantGuid,businessDate);
   if(id)await this.getDay(id); // A real completed OR 202-pending report proves access.
   const {data:verified,error}=await db.from("toast_analytics_credentials").update({
    verified_at:new Date().toISOString(),last_error_category:null
   }).eq("business_id",businessId).eq("client_secret_enc",expected.client_secret_enc).select("business_id").maybeSingle();
   if(error||!verified)throw new ToastApiError("unavailable");
   return true;
  },
  async requestDay(restaurantGuid:string,businessDate:string){
   if(!GUID.safeParse(restaurantGuid).success||!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))
    throw new ToastApiError("invalid_response");
   const result=await call("post","/era/v1/metrics/day",{
     startBusinessDate:businessDate.replaceAll("-",""),restaurantIds:[restaurantGuid]
   });
   // A 202 can still carry the report request GUID used for polling.
   const parsed=reportGuid.safeParse(result.body);
   if(!parsed.success){if(result.pending)return null;throw new ToastApiError("invalid_response");}
   return parsed.data;
  },
  async getDay(reportRequestGuid:string){
   if(!reportGuid.safeParse(reportRequestGuid).success)
    throw new ToastApiError("invalid_response");
   const result=await call("get","/era/v1/metrics/"+reportRequestGuid);
   if(result.pending)return {pending:true as const};
   const rows=reports.safeParse(result.body);
   if(!rows.success)throw new ToastApiError("invalid_response");
   return {pending:false as const,rows:rows.data};
  }
 };
}

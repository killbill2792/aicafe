import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {z} from "zod";
import {decryptToken,encryptToken} from "@/lib/security/tokenCrypto";
import {GUID,ToastApiError,trustedToastOrigin} from "./client";

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
  let res:Response;
  try{res=await fetch(origin+"/authentication/v1/authentication/login",{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(deadline()),
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({clientId:c.client_id,clientSecret:decryptToken(c.client_secret_enc),
      userAccessType:"TOAST_MACHINE_CLIENT"})
  });}catch{throw new ToastApiError("unavailable");}
  if(res.status===401)throw new ToastApiError("authentication");
  if(res.status===403)throw new ToastApiError("missing_permissions");
  if(!res.ok)throw new ToastApiError("unavailable");
  const parsed=tokenSchema.safeParse(await res.json().catch(()=>null));
  if(!parsed.success)throw new ToastApiError("invalid_response");
  const {accessToken,expiresIn}=parsed.data.token;
  const {error}=await db.from("toast_analytics_credentials").update({
   bearer_token_enc:encryptToken(accessToken),
   bearer_expires_at:new Date(Date.now()+expiresIn*1000).toISOString(),
   verified_at:new Date().toISOString(),last_error_category:null
  }).eq("business_id",businessId);
  if(error)throw new ToastApiError("unavailable");
  return {origin,bearer:accessToken};
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
  let auth=await login();
  for(let attempt=0;attempt<2;attempt++){
   deadline();
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
   if(res.status===401&&attempt===0){auth=await login(true);continue;}
   if(res.status===401)throw new ToastApiError("authentication");
   if(res.status===403)throw new ToastApiError("missing_permissions");
   if(res.status===202)return {pending:true as const};
   if(res.status===429)throw new ToastApiError("rate_limited",429);
   if(!res.ok)throw new ToastApiError("unavailable",res.status);
   return {pending:false as const,body:await res.json().catch(()=>null)};
  }
  throw new ToastApiError("authentication");
 }
 return {
  test:()=>login().then(()=>true),
  async requestDay(restaurantGuid:string,businessDate:string){
   if(!GUID.safeParse(restaurantGuid).success||!/^\d{4}-\d{2}-\d{2}$/.test(businessDate))
    throw new ToastApiError("invalid_response");
   const result=await call("post","/era/v1/metrics/day",{
     startBusinessDate:businessDate.replaceAll("-",""),restaurantIds:[restaurantGuid]
   });
   if(result.pending)throw new ToastApiError("unavailable");
   const parsed=reportGuid.safeParse(result.body);
   if(!parsed.success)throw new ToastApiError("invalid_response");
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

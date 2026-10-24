import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID,trustedToastOrigin,ToastApiError} from "@/lib/pos/toast/client";
import {encryptToken} from "@/lib/security/tokenCrypto";
import {createToastAnalyticsClient} from "@/lib/pos/toast/analyticsClient";
export const runtime="nodejs";export const dynamic="force-dynamic";
const input=z.object({businessId:GUID,managementGroupGuid:GUID,
 apiUrl:z.string().min(1).max(250),clientId:z.string().min(1).max(500),
 clientSecret:z.string().min(1).max(5000)}).strict();
const reply=(status:number,data:unknown)=>NextResponse.json(data,{
 status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return reply(503,{error:"setup_disabled"});
 const body=input.safeParse(await request.json().catch(()=>null));
 if(!body.success)return reply(400,{error:"invalid_request"});
 const p=body.data;
 const db=await authorizeToastOwner(p.businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 let origin:string;
 try{origin=trustedToastOrigin(p.apiUrl);}
 catch{return reply(400,{error:"invalid_host"});}
 const {error}=await db.from("toast_analytics_credentials").upsert({
  business_id:p.businessId,management_group_guid:p.managementGroupGuid,
  api_origin:origin,client_id:p.clientId,
  client_secret_enc:encryptToken(p.clientSecret),
  bearer_token_enc:null,bearer_expires_at:null,verified_at:null,
  last_error_category:null,updated_at:new Date().toISOString()
 },{onConflict:"business_id"});
 if(error)return reply(503,{error:"unavailable"});
 try {
  await createToastAnalyticsClient(db,p.businessId,Date.now()+15000).test();
  return reply(200,{verified:true});
 }catch(err){
  const category=err instanceof ToastApiError?err.category:"unavailable";
  await db.from("toast_analytics_credentials")
   .update({last_error_category:category}).eq("business_id",p.businessId);
  return reply(422,{verified:false,error:category});
 }
}
export async function GET(request:Request){
 const businessId=new URL(request.url).searchParams.get("businessId")??"";
 const db=await authorizeToastOwner(businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 const {data,error}=await db.from("toast_analytics_credentials")
  .select("management_group_guid,verified_at,last_error_category")
  .eq("business_id",businessId).maybeSingle();
 if(error)return reply(503,{error:"unavailable"});
 return reply(200,{connected:Boolean(data),
  verified:Boolean(data?.verified_at),lastErrorCategory:data?.last_error_category??null});
}
export async function DELETE(request:Request){
 const businessId=new URL(request.url).searchParams.get("businessId")??"";
 const db=await authorizeToastOwner(businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 const {error}=await db.from("toast_analytics_credentials").delete().eq("business_id",businessId);
 if(error)return reply(503,{error:"unavailable"});
 return reply(200,{disconnected:true});
}

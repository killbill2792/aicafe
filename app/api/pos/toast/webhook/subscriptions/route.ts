import {NextResponse} from "next/server";
import {z} from "zod";
import {encryptToken} from "@/lib/security/tokenCrypto";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const body=z.discriminatedUnion("action",[
 z.object({action:z.literal("prepare"),businessId:GUID}).strict(),
 z.object({action:z.literal("register_secret"),businessId:GUID,
  subscriptionId:GUID,signingSecret:z.string().min(32).max(4096)}).strict(),
 z.object({action:z.literal("revoke"),businessId:GUID,subscriptionId:GUID}).strict()
]);
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,
 headers:{"Cache-Control":"no-store"}});
/** Only a canonical operator-configured HTTPS origin, never the request Host header. */
function publicToastWebhookOrigin(raw=process.env.TOAST_PUBLIC_WEBHOOK_ORIGIN){
 if(!raw)throw new Error("Webhook origin not configured");
 const u=new URL(raw);
 if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||
   u.port||u.pathname!=="/")throw new Error("Invalid webhook origin");
 return u.origin;
}
export async function GET(request:Request){
 const id=new URL(request.url).searchParams.get("businessId")??"";
 const db=await authorizeToastOwner(id);
 if(!db)return reply(403,{error:"not_authorized"});
 const {data,error}=await db.from("toast_webhook_subscriptions")
  .select("id,enabled,created_at").eq("business_id",id).order("created_at",{ascending:false}).limit(5);
 if(error)return reply(503,{error:"unavailable"});
 let origin:string|null=null;
 try{origin=publicToastWebhookOrigin();}catch{}
 return reply(200,{subscriptions:(data??[]).map(s=>({
  ...s,webhookUrl:origin?origin+"/api/pos/toast/webhook/"+s.id:null
 })),receiverGloballyEnabled:process.env.TOAST_WEBHOOKS_ENABLED==="true",
 signingSecretsExposed:false});
}
export async function POST(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return reply(503,{error:"setup_disabled"});
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
  return reply(415,{error:"invalid_request"});
 const data=body.safeParse(await request.json().catch(()=>null));
 if(!data.success)return reply(400,{error:"invalid_request"});
 const p=data.data,db=await authorizeToastOwner(p.businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 if(p.action==="prepare"){
  let origin:string;
  try {origin=publicToastWebhookOrigin();}catch{return reply(503,{error:"public_origin_not_configured"});}
  const {data:verified,error:mapError}=await db.from("toast_location_mappings")
   .select("restaurant_guid").eq("business_id",p.businessId).not("verified_at","is",null).limit(1);
  if(mapError||!verified?.length)return reply(409,{error:"test_connection_first"});
  const {data:row,error}=await db.from("toast_webhook_subscriptions").insert({
    business_id:p.businessId,signing_secret_enc:null,enabled:false
  }).select("id").single();
  if(error||!row)return reply(503,{error:"unavailable"});
  return reply(201,{subscriptionId:row.id,
   webhookUrl:origin+"/api/pos/toast/webhook/"+row.id,
   enabled:false,next:"Create Toast Orders subscription, register its secret securely. Do not activate."});
 }
 const {data:row,error}=await db.from("toast_webhook_subscriptions")
  .select("id,enabled").eq("business_id",p.businessId).eq("id",p.subscriptionId).maybeSingle();
 if(error||!row)return reply(404,{error:"not_found"});
 if(row.enabled)return reply(409,{error:"disable_active_subscription_first"});
 const {error:write}=await db.from("toast_webhook_subscriptions").update(
  p.action==="register_secret"?{signing_secret_enc:encryptToken(p.signingSecret),enabled:false}:
    {signing_secret_enc:null,enabled:false}
 ).eq("business_id",p.businessId).eq("id",p.subscriptionId).eq("enabled",false);
 if(write)return reply(503,{error:"unavailable"});
 return reply(200,{subscriptionId:p.subscriptionId,enabled:false,
  secretStored:p.action==="register_secret",signingSecret:null});
}

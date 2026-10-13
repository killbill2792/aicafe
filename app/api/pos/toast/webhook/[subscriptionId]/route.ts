import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {decryptToken} from "@/lib/security/tokenCrypto";
import {GUID} from "@/lib/pos/toast/client";
import {toastEventSchema,validToastWebhookSignature} from "@/lib/pos/toast/webhookSignature";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const response=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request,context:{params:Promise<{subscriptionId:string}>}) {
  if(process.env.TOAST_WEBHOOKS_ENABLED!=="true")
    return response(503,{error:"webhook_disabled"});
  const {subscriptionId}=await context.params;
  if(!GUID.safeParse(subscriptionId).success)return response(404,{error:"not_found"});
  if(Number(request.headers.get("content-length"))>1024*1024)
    return response(413,{error:"too_large"});
  const raw=await request.text();
  if(Buffer.byteLength(raw,"utf8")>1024*1024)return response(413,{error:"too_large"});
  let payload:unknown;
  try {payload=JSON.parse(raw);}catch {return response(400,{error:"invalid_event"});}
  const parsed=toastEventSchema.safeParse(payload);
  if(!parsed.success)return response(400,{error:"invalid_event"});
  const event=parsed.data;
  const db=createAdminSupabaseClient();
  const {data:subscription,error}=await db.from("toast_webhook_subscriptions")
    .select("business_id,signing_secret_enc,enabled")
    .eq("id",subscriptionId).maybeSingle();
  if(error||!subscription?.enabled)return response(404,{error:"not_found"});
  if(!validToastWebhookSignature(raw,event.timestamp,request.headers.get("toast-signature"),
      decryptToken(subscription.signing_secret_enc)))return response(401,{error:"invalid_signature"});
  if(!["order_updated","channel_order_updated"].includes(event.eventType))
    return response(202,{accepted:false});
  const {data:mapping,error:mapError}=await db.from("toast_location_mappings")
    .select("verified_at").eq("business_id",subscription.business_id)
    .eq("restaurant_guid",event.details.restaurantGuid).maybeSingle();
  if(mapError||!mapping?.verified_at)return response(403,{error:"unauthorized_location"});
  // Durable event ID dedupe; never store order details containing guest or payment data.
  const {error:insertError}=await db.from("toast_order_events").insert({
    business_id:subscription.business_id,event_guid:event.guid,
    restaurant_guid:event.details.restaurantGuid,event_time:event.timestamp,state:"pending"
  });
  if(insertError?.code==="23505")return response(202,{accepted:true,duplicate:true});
  if(insertError)return response(503,{error:"queue_unavailable"});
  return response(202,{accepted:true});
}

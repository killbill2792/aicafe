import {NextResponse} from "next/server";
import {z} from "zod";
import {requireSameOrigin,readBoundedJson} from "@/lib/ai/conversations/http.server";
import {DeliveryReadError,readApprovedScheduleDelivery,markOwnerScheduleDelivery,updateScheduleChannelPreference,updateScheduleWhatsAppConsent} from "@/lib/data/ownerScheduleDelivery.server";
export const runtime="nodejs";export const dynamic="force-dynamic";
const locale=z.enum(["en","es","ar"]);
const fail=(error:unknown)=>{
 const key=error instanceof DeliveryReadError?error.code:"storage_unavailable";
 return NextResponse.json({error:key},{status:key==="unauthorized"?404:
   key==="not_approved"||key==="schedule_changed"?409:key==="invalid_week"||key==="recipient_not_eligible"?422:503,
   headers:{"Cache-Control":"no-store"}});
};
export async function GET(request:Request){
 try{
  const q=new URL(request.url).searchParams;
  const source={...(q.has("proposalId")?{proposalId:q.get("proposalId")}:{week:q.get("week")})};
  const result=await readApprovedScheduleDelivery(source,locale.parse(q.get("locale")??"en"));
  return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
 }catch(error){return fail(error);}
}
export async function POST(request:Request){
 try{
  requireSameOrigin(request);
  const result=await markOwnerScheduleDelivery(await readBoundedJson(request));
  return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
 }catch(error){return fail(error);}
}
export async function PATCH(request:Request){
 try{
  requireSameOrigin(request);
  const data=await readBoundedJson(request) as Record<string,unknown>;
  const result=Object.hasOwn(data,"whatsappOptIn")
    ? await updateScheduleWhatsAppConsent(data) : await updateScheduleChannelPreference(data);
  return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
 }catch(error){return fail(error);}
}

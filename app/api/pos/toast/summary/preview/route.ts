import {NextResponse} from "next/server";
import {z} from "zod";
import {GUID} from "@/lib/pos/toast/client";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {parseToastSummaryCsv} from "@/lib/calc/toastSummaryInput";
import {readToastSummaryPhoto} from "@/lib/ai/prompts/toastSummaryReading";
export const dynamic="force-dynamic";
export const runtime="nodejs";
const input=z.object({businessId:GUID,restaurantGuid:GUID,locale:z.enum(["en","es","ar"]),date:z.iso.date(),
 source:z.enum(["csv","photo"]),content:z.string().min(1).max(7000000)}).strict();
const send=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return send(404,{error:"not_found"});
 if(Number(request.headers.get("content-length")??0)>7100000)return send(413,{error:"file_too_large"});
 const p=input.safeParse(await request.json().catch(()=>null));
 if(!p.success)return send(400,{error:"invalid_report"});
 const x=p.data,db=await authorizeToastOwner(x.businessId);
 if(!db)return send(403,{error:"not_authorized"});
 const {data:location,error}=await db.from("toast_location_mappings").select("restaurant_guid")
  .eq("business_id",x.businessId).eq("restaurant_guid",x.restaurantGuid).not("verified_at","is",null).maybeSingle();
 if(error||!location)return send(403,{error:"not_authorized"});
 try{
  if(x.source==="photo"&&!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(x.content))return send(400,{error:"invalid_report"});
  const days=x.source==="csv"?parseToastSummaryCsv(x.content,x.locale,x.date):(await readToastSummaryPhoto(x.content)).days;
  return send(200,{days}); // NO database writes: every value needs owner confirmation.
 }catch{return send(422,{error:"unreadable_report"});}
}

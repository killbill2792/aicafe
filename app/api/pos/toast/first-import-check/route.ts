import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
import {readAllPages} from "@/lib/pos/toast/readAllPages";
import {dayCoverage} from "@/lib/pos/toast/ownerCoverage";
const schema=z.object({businessId:GUID,answer:z.enum(["looks_right","something_off"]),
 flaggedDates:z.array(z.iso.date()).max(100).default([]),note:z.string().max(2000).optional()}).strict();
const send=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return send(404,{error:"not_found"});
 const p=schema.safeParse(await request.json().catch(()=>null));
 if(!p.success)return send(400,{error:"invalid_request"});
 const {businessId,answer,flaggedDates,note}=p.data;
 if(answer==="something_off"&&!flaggedDates.length)return send(400,{error:"select_days"});
 if(answer==="looks_right"&&flaggedDates.length)return send(400,{error:"invalid_request"});
 const db=await authorizeToastOwner(businessId);
 if(!db)return send(404,{error:"not_found"});
 const {data:locations,error:locationError}=await db.from("toast_location_mappings")
  .select("restaurant_guid,verified_at,toast_start_date").eq("business_id",businessId);
 if(locationError)return send(503,{error:"unavailable"});
 if(!locations?.some(x=>x.verified_at))return send(404,{error:"not_found"});
 let days;
 try{
  days=await readAllPages((start,end)=>db.from("toast_day_status")
   .select("business_date,restaurant_guid,import_state,coverage_complete,net_sales_cents,order_count")
   .eq("business_id",businessId).order("business_date",{ascending:false})
   .order("restaurant_guid").range(start,end));
 }catch{return send(503,{error:"unavailable"});}
 const complete=[...new Set(days.map(x=>x.business_date))].filter(date=>
  dayCoverage(locations,days,date).complete);
 if(complete.length<7)return send(409,{error:"not_ready"});
 if(flaggedDates.some(d=>!complete.includes(d)))return send(400,{error:"invalid_dates"});
 const {data:existing,error:readError}=await db.from("toast_first_import_check")
  .select("answered_at").eq("business_id",businessId).maybeSingle();
 if(readError)return send(503,{error:"unavailable"});
 if(existing?.answered_at)return send(409,{error:"already_answered"});
 // The initial check and its flags are committed atomically in the RPC.
 const {error}=await db.rpc("toast_answer_first_import_check",{
  p_business_id:businessId,p_answer:answer,p_days:flaggedDates,p_note:note??null});
 return error?send(503,{error:"unavailable"}):send(200,{answered:true});
}

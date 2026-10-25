import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const schema=z.object({businessId:GUID,from:z.iso.date(),to:z.iso.date()}).strict();
const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(process.env.TOAST_AUTO_IMPORT_ENABLED!=="true")return reply(503,{disabled:true});
 const parsed=schema.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return reply(400,{error:"invalid_request"});
 const {businessId,from,to}=parsed.data;
 const start=Date.parse(from+"T00:00:00Z"),end=Date.parse(to+"T00:00:00Z");
 if(from<"2015-12-02"||end<start||(end-start)/86400000>=400)
  return reply(400,{error:"invalid_range"});
 const db=await authorizeToastOwner(businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 const {data:mappings,error}=await db.from("toast_location_mappings")
  .select("restaurant_guid,toast_time_zone,verified_at").eq("business_id",businessId);
 if(error||!mappings?.length||mappings.some(m=>!m.verified_at||!m.toast_time_zone))
  return reply(400,{error:"unverified_locations"});
 for(const m of mappings){
  const today=new Intl.DateTimeFormat("en-CA",{timeZone:m.toast_time_zone,
   year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  if(to>=today)return reply(400,{error:"invalid_range"});
 }
 const runIds:string[]=[];
 for(const m of mappings){
  const {data,error:queued}=await db.rpc("toast_queue_backfill",{
   p_business_id:businessId,p_restaurant_guid:m.restaurant_guid,p_from:from,p_to:to});
  if(queued)return reply(503,{error:"queue_unavailable"});
  runIds.push(data as string);
 }
 return reply(202,{runIds});
}

import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
const schema=z.object({businessId:GUID}).strict();
export async function POST(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return NextResponse.json({error:"not_found"},{status:404});
 const input=schema.safeParse(await request.json().catch(()=>null));
 if(!input.success)return NextResponse.json({error:"invalid_request"},{status:400});
 const db=await authorizeToastOwner(input.data.businessId);
 if(!db)return NextResponse.json({error:"not_found"},{status:404});
 const {data:mappings,error}=await db.from("toast_location_mappings")
 .select("restaurant_guid").eq("business_id",input.data.businessId).not("verified_at","is",null);
 if(error||!mappings?.length)return NextResponse.json({error:"unavailable"},{status:503});
 let queued=0;
 for(const mapping of mappings){
  const result=await db.rpc("toast_requeue_failed",{p_business_id:input.data.businessId,
   p_restaurant_guid:mapping.restaurant_guid});
  if(result.error)return NextResponse.json({error:"unavailable"},{status:503});
  queued+=Number(result.data);
 }
 return NextResponse.json({queued},{headers:{"Cache-Control":"no-store"}});
}

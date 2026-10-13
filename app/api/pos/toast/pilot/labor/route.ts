import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID,ToastApiError} from "@/lib/pos/toast/client";
import {syncToastLaborReadOnly} from "@/lib/pos/toast/laborSync";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const schema=z.object({
  businessId:GUID,locationId:GUID,restaurantGuid:GUID,
  since:z.iso.datetime({offset:true}),until:z.iso.datetime({offset:true}),
  kind:z.enum(["attendance","schedules"]),
}).strict();
export async function POST(request:Request) {
 const respond=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
 if(process.env.TOAST_PILOT_IMPORT_ENABLED!=="true")return respond(503,{error:"pilot_disabled"});
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
   return respond(415,{error:"invalid_request"});
 const body=schema.safeParse(await request.json().catch(()=>null));
 if(!body.success)return respond(400,{error:"invalid_request"});
 const {businessId,locationId,restaurantGuid,since,until,kind}=body.data;
 const db=await authorizeToastOwner(businessId);
 if(!db)return respond(403,{error:"not_authorized"});
 try{
   return respond(200,await syncToastLaborReadOnly(db,{businessId,locationId,restaurantGuid},
    {since:new Date(since),until:new Date(until)},kind));
 }catch(error) {
   const known=error instanceof ToastApiError?error:new ToastApiError("unavailable");
   return respond(known.category==="rate_limited"?429:503,
     {error:known.category,retryAfter:known.retryAt});
 }
}

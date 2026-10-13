import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID,ToastApiError} from "@/lib/pos/toast/client";
import {stageToastOneDay,businessDateSchema,reconcileStagedDay,reportSchema}
  from "@/lib/pos/toast/pilot";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const input=z.object({businessId:GUID,locationId:GUID,restaurantGuid:GUID,
  businessDate:businessDateSchema}).strict();
const reconcileInput=z.object({businessId:GUID,restaurantGuid:GUID,
 businessDate:businessDateSchema,report:reportSchema}).strict();
function respond(status:number,data:unknown) {
 return NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
}
export async function POST(request:Request) {
 if(process.env.TOAST_PILOT_IMPORT_ENABLED!=="true")
   return respond(503,{error:"pilot_disabled"});
 const type=request.headers.get("content-type")?.split(";")[0];
 if(type!=="application/json")return respond(415,{error:"invalid_request"});
 const parsed=input.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return respond(400,{error:"invalid_request"});
 const db=await authorizeToastOwner(parsed.data.businessId);
 if(!db)return respond(403,{error:"not_authorized"});
 try {
   const outcome=await stageToastOneDay(db,parsed.data);
   return respond(200,{...outcome,message:"staged_not_imported"});
 }catch(error) {
   const failure=error instanceof ToastApiError?error:new ToastApiError("unavailable");
   return respond(failure.category==="rate_limited"?429:
     failure.category==="unauthorized_location"?403:503,
     {error:failure.category,retryAfter:failure.retryAt});
 }
}
export async function PUT(request:Request) {
 if(process.env.TOAST_PILOT_IMPORT_ENABLED!=="true")
   return respond(503,{error:"pilot_disabled"});
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
   return respond(415,{error:"invalid_request"});
 const parsed=reconcileInput.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return respond(400,{error:"invalid_request"});
 const db=await authorizeToastOwner(parsed.data.businessId);
 if(!db)return respond(403,{error:"not_authorized"});
 try {
   return respond(200,await reconcileStagedDay(db,parsed.data));
 }catch {return respond(503,{error:"temporarily_unavailable"});}
}

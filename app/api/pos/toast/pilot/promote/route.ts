import {NextResponse} from "next/server";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {promoteSchema,promoteVerifiedToastDay} from "@/lib/pos/toast/promote";
import {ToastApiError} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function POST(request:Request){
 const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
 if(process.env.TOAST_CANONICAL_PROMOTION_ENABLED!=="true")
   return reply(503,{error:"promotion_disabled"});
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
   return reply(415,{error:"invalid_request"});
 const data=promoteSchema.safeParse(await request.json().catch(()=>null));
 if(!data.success)return reply(400,{error:"invalid_request"});
 const db=await authorizeToastOwner(data.data.businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 try{return reply(200,await promoteVerifiedToastDay(db,data.data));}
 catch(error){
   const e=error instanceof ToastApiError?error:new ToastApiError("unavailable");
   return reply(e.category==="unavailable"?503:409,{error:"not_promoted",reason:e.category});
 }
}

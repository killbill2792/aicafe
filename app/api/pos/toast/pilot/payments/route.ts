import {NextResponse} from "next/server";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {paymentScanSchema,stageToastPaymentDateReview} from "@/lib/pos/toast/paymentDates";
import {ToastApiError} from "@/lib/pos/toast/client";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,
 headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(process.env.TOAST_PILOT_IMPORT_ENABLED!=="true")
  return reply(503,{error:"pilot_disabled"});
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")
  return reply(415,{error:"invalid_request"});
 const parsed=paymentScanSchema.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return reply(400,{error:"invalid_request"});
 const db=await authorizeToastOwner(parsed.data.businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 try{return reply(200,await stageToastPaymentDateReview(db,parsed.data));}
 catch(e){return reply(e instanceof ToastApiError&&e.category==="rate_limited"?429:503,
  {error:e instanceof ToastApiError?e.category:"unavailable"});}
}

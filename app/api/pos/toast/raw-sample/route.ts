import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
import {captureToastRawSample} from "@/lib/pos/toast/rawSample.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const input=z.object({businessId:GUID,businessDate:z.iso.date()}).strict();
const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")return reply(415,{error:"invalid_request"});
 const parsed=input.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return reply(400,{error:"invalid_request"});
 const db=await authorizeToastOwner(parsed.data.businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 const result=await captureToastRawSample(parsed.data.businessId,parsed.data.businessDate,db);
 return reply(result.skipped?429:200,result.skipped?{error:"rate_limited_or_not_configured"}:result);
}

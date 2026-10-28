import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {GUID} from "@/lib/pos/toast/client";
import {captureToastRawSample} from "@/lib/pos/toast/rawSample.server";
import type {ToastRawSampleResult} from "@/lib/pos/toast/rawSample.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const input=z.object({businessId:GUID,businessDate:z.iso.date()}).strict();
const reply=(status:number,body:unknown)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
const statusByReason:Record<NonNullable<ToastRawSampleResult["reason"]>,number>={
 invalid_request:400,no_location:404,busy:409,cooldown:429,db_error:503,missing_hash_key:503,lease_lost:503
};
export async function POST(request:Request){
 if(request.headers.get("content-type")?.split(";")[0]!=="application/json")return reply(415,{error:"invalid_request"});
 const parsed=input.safeParse(await request.json().catch(()=>null));
 if(!parsed.success)return reply(400,{error:"invalid_request"});
 const db=await authorizeToastOwner(parsed.data.businessId);
 if(!db)return reply(403,{error:"not_authorized"});
 const result=await captureToastRawSample(parsed.data.businessId,parsed.data.businessDate,db,240_000);
 if(result.reason)return reply(statusByReason[result.reason],{...result,error:result.reason});
 return reply(200,result);
}

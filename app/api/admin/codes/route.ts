import {NextResponse} from "next/server";
import {randomBytes} from "node:crypto";
import {z} from "zod";
import {requireAdmin} from "@/lib/admin/auth.server";
import {insertFreeAccessCode,toggleFreeAccessCode,changeCafeAccess} from "@/lib/data/adminCodes.server";
import {requireSameOrigin,readBoundedJson} from "@/lib/ai/conversations/http.server";
import {ConversationApiError} from "@/lib/ai/conversations/auth.server";
export const runtime="nodejs";export const dynamic="force-dynamic";
const uuid=z.uuid();
const actions=z.discriminatedUnion("action",[
 z.strictObject({action:z.literal("create"),durationMonths:z.number().int().min(1).max(120).nullable(),
   fixedEndDate:z.iso.date().nullable(),maxCafes:z.number().int().min(1).max(100000),
   note:z.string().trim().max(500),code:z.string().trim().max(32).optional()}),
 z.strictObject({action:z.literal("toggle"),id:uuid,active:z.boolean()}),
 z.strictObject({action:z.literal("extend"),businessId:uuid,accessEnd:z.iso.date()}),
 z.strictObject({action:z.literal("setMode"),businessId:uuid,mode:z.enum(["grandfathered","paused"])}),
]);
export async function POST(request:Request){
 const user=await requireAdmin();
 try{
  requireSameOrigin(request);
  const parsed=actions.safeParse(await readBoundedJson(request));
  if(!parsed.success)return NextResponse.json({error:"invalid_input"},{status:422});
  const input=parsed.data;
  if(input.action==="create"){
   if((input.durationMonths===null)===(input.fixedEndDate===null))
    return NextResponse.json({error:"select_one_duration_type"},{status:422});
   if(input.fixedEndDate && input.fixedEndDate<new Date().toISOString().slice(0,10))
    return NextResponse.json({error:"end_date_in_past"},{status:422});
   // Generate with CSPRNG; only the hash persists. The raw value is shown once.
   const code=input.code?.trim() || "CAFE-"+randomBytes(8).toString("hex").toUpperCase();
   const status=await insertFreeAccessCode({code,durationMonths:input.durationMonths,
    fixedEndDate:input.fixedEndDate,maxCafes:input.maxCafes,note:input.note,adminId:user.id});
   if(status==="code_exists")return NextResponse.json({error:status},{status:409});
   return NextResponse.json({created:true,code},{headers:{"Cache-Control":"no-store"}});
  }
  if(input.action==="toggle"){
   const status=await toggleFreeAccessCode(input.id,input.active);
   if(status!=="ok")return NextResponse.json({error:status},{status:404});
  }
  if(input.action==="extend" || input.action==="setMode"){
   const status=await changeCafeAccess({businessId:input.businessId,
    action:input.action==="extend"?"extend":input.mode,
    ...(input.action==="extend"?{accessEnd:input.accessEnd}:{})});
   if(status!=="ok")
    return NextResponse.json({error:status},{status:status==="paused_cafe"?409:422});
  }
  return NextResponse.json({saved:true},{headers:{"Cache-Control":"no-store"}});
 }catch(error){
  if(error instanceof ConversationApiError && error.code==="invalid_code")
   return NextResponse.json({error:"invalid_code"},{status:422});
  console.error("admin_free_access_action_failed");
  return NextResponse.json({error:"access_action_failed"},{status:503});
 }
}

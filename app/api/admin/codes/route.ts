import {NextResponse} from "next/server";
import {randomBytes} from "node:crypto";
import {z} from "zod";
import {requireAdmin} from "@/lib/admin/auth.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireSameOrigin,readBoundedJson} from "@/lib/ai/conversations/http.server";
import {accessCodeHash,normalizeCode} from "@/lib/access/access.server";
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
  const input=parsed.data,db=createAdminSupabaseClient();
  if(input.action==="create"){
   if((input.durationMonths===null)===(input.fixedEndDate===null))
    return NextResponse.json({error:"select_one_duration_type"},{status:422});
   if(input.fixedEndDate && input.fixedEndDate<new Date().toISOString().slice(0,10))
    return NextResponse.json({error:"end_date_in_past"},{status:422});
   // Generate with CSPRNG; only the hash persists. The raw value is shown once.
   const code=input.code?.trim() || "CAFE-"+randomBytes(8).toString("hex").toUpperCase();
   const codeHash=accessCodeHash(code);
   const {error}=await db.from("free_access_codes").insert({
    code_hash:codeHash,code_hint:normalizeCode(code).slice(0,5)+"…",
    duration_months:input.durationMonths,fixed_end_date:input.fixedEndDate,
    max_cafes:input.maxCafes,note:input.note||null,created_by:user.id,
   });
   if(error?.code==="23505")return NextResponse.json({error:"code_exists"},{status:409});
   if(error)throw error;
   return NextResponse.json({created:true,code},{headers:{"Cache-Control":"no-store"}});
  }
  if(input.action==="toggle"){
   const {error}=await db.from("free_access_codes").update({active:input.active}).eq("id",input.id);
   if(error)throw error;
  }
  if(input.action==="extend"){
   const today=new Date().toISOString().slice(0,10);
   if(input.accessEnd<today)return NextResponse.json({error:"end_date_in_past"},{status:422});
   const {data:current,error:readError}=await db.from("cafe_access").select("mode,access_end")
    .eq("business_id",input.businessId).maybeSingle();
   if(readError)throw readError;
   if(current?.mode==="paused")return NextResponse.json({error:"paused_cafe"},{status:409});
   if(current?.mode==="code" && current.access_end && current.access_end>=input.accessEnd)
     return NextResponse.json({error:"not_an_extension"},{status:422});
   const {error}=await db.from("cafe_access").upsert({
    business_id:input.businessId,mode:"code",access_end:input.accessEnd,
    updated_at:new Date().toISOString(),
   },{onConflict:"business_id"});
   if(error)throw error;
  }
  if(input.action==="setMode"){
   const {error}=await db.from("cafe_access").upsert({
    business_id:input.businessId,mode:input.mode,
    code_id:null,access_end:null,updated_at:new Date().toISOString(),
   },{onConflict:"business_id"});
   if(error)throw error;
  }
  return NextResponse.json({saved:true},{headers:{"Cache-Control":"no-store"}});
 }catch(error){
  if(error instanceof ConversationApiError && error.code==="invalid_code")
   return NextResponse.json({error:"invalid_code"},{status:422});
  console.error("admin_free_access_action_failed");
  return NextResponse.json({error:"access_action_failed"},{status:503});
 }
}

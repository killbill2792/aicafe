import {NextResponse} from "next/server";
import {z} from "zod";
import {requireConnectorOwner} from "@/lib/connectors/registry.server";
import {externalAccess,changeExternalAccess,WEB_RESOURCE,FILE_RESOURCE} from "@/lib/connectors/access.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {readBoundedJson,requireSameOrigin} from "@/lib/ai/conversations/http.server";
import {ConversationApiError} from "@/lib/ai/conversations/auth.server";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const noStore={"cache-control":"no-store"};
const change=z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("public_web"),enabled:z.boolean(),revision:z.number().int().min(0)}),
 z.strictObject({kind:z.literal("file_read"),enabled:z.boolean(),revision:z.number().int().min(0)}),
 z.strictObject({kind:z.literal("attachment"),attachmentId:z.uuid(),
   enabled:z.literal(false),revision:z.number().int().min(0)}),
]);
export async function GET(request:Request){
 const scope=await requireConnectorOwner().catch(()=>null);
 if(!scope)return NextResponse.json({error:"owner_required"},{status:403,headers:noStore});
 try {
  const raw=new URL(request.url).searchParams.get("offset")??"0";
  if(!/^(0|[1-9][0-9]{0,5})$/.test(raw))return NextResponse.json({error:"invalid_page"},{status:422,headers:noStore});
  const offset=Number(raw),db=createAdminSupabaseClient();
  const [web,files,attachmentRows]=await Promise.all([
   externalAccess(scope,"public_web",WEB_RESOURCE),
   externalAccess(scope,"file_read",FILE_RESOURCE),
   db.from("ai_attachments").select("id,thread_id,original_name,media_type,bytes,created_at")
    .eq("business_id",scope.businessId).eq("owner_user_id",scope.ownerUserId)
    .order("created_at",{ascending:false}).order("id",{ascending:false})
    .range(offset,offset+39),
  ]);
  if(attachmentRows.error)throw Error("attachment_list_unavailable");
  const rows=attachmentRows.data??[];
  const overrides=rows.length?await db.from("supervisor_external_access")
    .select("resource_key,allowed,revision").eq("business_id",scope.businessId)
    .eq("owner_user_id",scope.ownerUserId).eq("kind","attachment")
    .in("resource_key",rows.map(a=>a.id)):{data:[],error:null};
  if(overrides.error)throw Error("attachment_permission_unavailable");
  const byId=new Map((overrides.data??[]).map(row=>[row.resource_key,row]));
  return NextResponse.json({publicWeb:web,fileRead:files,
   files:rows.map(row=>({
     id:row.id,threadId:row.thread_id,name:row.original_name,mediaType:row.media_type,
     bytes:row.bytes,createdAt:row.created_at,
     allowed:byId.get(row.id)?.allowed??true,revision:Number(byId.get(row.id)?.revision??0),
   })),nextOffset:rows.length===40?offset+40:null,
   computer:{available:false,connected:false,reason:"No authorized Supervisor computer executor is installed."}},
  {headers:noStore});
 }catch{
  return NextResponse.json({error:"access_status_unavailable"},{status:503,headers:noStore});
 }
}
export async function POST(request:Request){
 try{requireSameOrigin(request);}
 catch{return NextResponse.json({error:"invalid_origin"},{status:403,headers:noStore});}
 const scope=await requireConnectorOwner().catch(()=>null);
 if(!scope)return NextResponse.json({error:"owner_required"},{status:403,headers:noStore});
 try {
  const input=change.parse(await readBoundedJson(request));
  const key=input.kind==="public_web"?WEB_RESOURCE:input.kind==="file_read"?FILE_RESOURCE:input.attachmentId;
  const state=await changeExternalAccess(scope,input.kind,key,input.enabled,input.revision);
  return NextResponse.json({kind:input.kind,resourceKey:key,...state},{headers:noStore});
 }catch(error){
  if(error instanceof ConversationApiError)
    return NextResponse.json({error:error.code},{status:error.status,headers:noStore});
  const code=error instanceof Error?error.message:"unknown";
  const invalid=error instanceof z.ZodError||error instanceof SyntaxError||
    code==="external_access_input_invalid";
  return NextResponse.json({error:code==="external_access_stale"?"access_changed_refresh":
   invalid?"invalid_request":code==="external_access_change_failed"?
   "access_change_unverified":"access_change_denied"},
   {status:code==="external_access_stale"?409:invalid?422:503,headers:noStore});
 }
}

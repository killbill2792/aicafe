import {NextResponse} from "next/server";
import {z} from "zod";
import {requireAdmin} from "@/lib/admin/auth.server";
import {requireSameOrigin,readBoundedJson} from "@/lib/ai/conversations/http.server";
import {ConversationApiError} from "@/lib/ai/conversations/auth.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {sendTestBrief} from "@/lib/operating/briefTest.server";
export const runtime="nodejs";export const dynamic="force-dynamic";export const maxDuration=60;
const input=z.strictObject({businessId:z.uuid()});
const noStore={"Cache-Control":"no-store"};
/** Admin only: send today's brief for one café now, through the real path,
 * and say exactly which step blocked it. Never returns phone numbers or tokens. */
export async function POST(request:Request){
  await requireAdmin();
  try{
    requireSameOrigin(request);
    const parsed=input.safeParse(await readBoundedJson(request));
    if(!parsed.success)return NextResponse.json({error:"invalid_input"},{status:422,headers:noStore});
    const report=await sendTestBrief(createAdminSupabaseClient(),parsed.data.businessId);
    if(!report)return NextResponse.json({error:"cafe_not_found"},{status:404,headers:noStore});
    return NextResponse.json(report,{headers:noStore});
  }catch(error){
    if(error instanceof ConversationApiError)
      return NextResponse.json({error:error.code},{status:error.status,headers:noStore});
    console.error("admin_test_brief_failed");
    return NextResponse.json({error:"test_brief_failed"},{status:503,headers:noStore});
  }
}

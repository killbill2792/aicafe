import {z} from "zod";
import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {ACTIVE_BUSINESS_COOKIE} from "@/lib/data/getActiveBusinessId";
export const runtime="nodejs";export const dynamic="force-dynamic";
/** A notification is an opaque link. Its source café is resolved from
 * authenticated, owner-RLS-protected Work—not a payload-supplied café ID.
 * Changing the active view does not authorize a business action or a model. */
export async function GET(request:Request){
  const raw=new URL(request.url).searchParams.get("run");
  const parsed=z.uuid().safeParse(raw);
  if(!parsed.success)return new Response("Invalid Work reference",{status:400});
  const db=await createServerSupabaseClient();
  const {data:{user},error:authError}=await db.auth.getUser();
  if(authError||!user)return NextResponse.redirect(new URL("/login",request.url));
  const {data:reports,error}=await db.from("operating_tasks")
    .select("id,business_id,owner_user_id")
    .eq("id","u4:"+parsed.data).eq("kind","u4_report")
    .eq("owner_user_id",user.id).limit(2);
  if(error)return new Response("Work lookup unavailable",{status:503});
  if(!reports||reports.length!==1)
    return new Response("Work reference unavailable",{status:404});
  const businessId=reports[0].business_id;
  const {data:membership,error:memberError}=await db.from("memberships")
    .select("role").eq("business_id",businessId)
    .eq("user_id",user.id).maybeSingle();
  if(memberError||membership?.role!=="owner")
    return new Response("Work reference unavailable",{status:404});
  const response=NextResponse.redirect(new URL(
    "/operations?agent=leo&status=watching&task="+encodeURIComponent("u4:"+parsed.data),
    request.url),303);
  response.cookies.set(ACTIVE_BUSINESS_COOKIE,businessId,{
    path:"/",sameSite:"lax",httpOnly:true,
    secure:process.env.NODE_ENV==="production",
  });
  return response;
}

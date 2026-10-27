import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {syncSquareTick} from "@/lib/pos/square/scheduler";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(request:Request){
 if(!verifyBearer(request,process.env.CRON_SECRET))
  return NextResponse.json({error:"unauthorized"},{status:401});
 if(process.env.SQUARE_AUTO_SYNC_ENABLED!=="true")
  return NextResponse.json({disabled:true},{status:200,headers:{"Cache-Control":"no-store"}});
 try {
  const result=await syncSquareTick(createAdminSupabaseClient());
  return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
 }catch{
  return NextResponse.json({error:"sync_unavailable"},{status:503});
 }
}

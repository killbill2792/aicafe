import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {runDataHealthCheck} from "@/lib/data/dataHealth.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const noStore={"Cache-Control":"no-store"};
/** Daily data health check (docs/plans/toast-storage.md step 4). Results show on /admin/health. */
export async function GET(request:Request){
  const secret=process.env.CRON_SECRET;
  if(!secret||request.headers.get("authorization")!=="Bearer "+secret)
    return NextResponse.json({error:"unauthorized"},{status:401,headers:noStore});
  try{
    return NextResponse.json(await runDataHealthCheck(createAdminSupabaseClient()),{headers:noStore});
  }catch{
    return NextResponse.json({error:"data_health_unavailable"},{status:503,headers:noStore});
  }
}

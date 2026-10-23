import {NextResponse} from "next/server";
import {classifyPendingTurns,supabaseClassifierStore} from "@/lib/admin/questionPatterns.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export async function GET(request:Request){
  const secret=process.env.CRON_SECRET;
  if(!secret || request.headers.get("authorization")!=="Bearer "+secret)
    return NextResponse.json({error:"unauthorized"},{status:401,headers:{"Cache-Control":"no-store"}});
  try {
    const result=await classifyPendingTurns(supabaseClassifierStore());
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch{
    console.error("admin_topic_classifier_failed");
    return NextResponse.json({error:"classification_unavailable"},{status:503,headers:{"Cache-Control":"no-store"}});
  }
}

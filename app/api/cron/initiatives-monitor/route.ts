import { NextResponse } from "next/server";
import { monitorInitiatives } from "@/lib/initiatives/monitor.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export async function GET(request:Request) {
  const secret=process.env.CRON_SECRET;
  if(!secret||request.headers.get("authorization")!=="Bearer "+secret)
    return NextResponse.json({error:"unauthorized"},{status:401,headers:{"Cache-Control":"no-store"}});
  try {
    const result=await monitorInitiatives();
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch {
    return NextResponse.json({error:"monitor_unavailable"},{status:503,headers:{"Cache-Control":"no-store"}});
  }
}

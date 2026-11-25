import {NextResponse} from "next/server";
import {verifyBearer} from "@/lib/security/bearer";
export const runtime="nodejs";
export const dynamic="force-dynamic";
// Retired owner WhatsApp conversational Supervisor. Keep the old endpoint inert
// for stale scheduler invocations; morning brief and employee delivery are separate.
export async function GET(request:Request){
 const status=verifyBearer(request,process.env.CRON_SECRET)?410:401;
 return NextResponse.json({error:status===410?"retired":"unauthorized"},{status,headers:{"Cache-Control":"no-store"}});
}

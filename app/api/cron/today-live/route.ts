import {NextResponse} from "next/server";
import {verifyBearer} from "@/lib/security/bearer";
export const runtime="nodejs";
export const dynamic="force-dynamic";
// Retired: the Toast coordinator publishes the shared stored-data reading.
export async function GET(request:Request){
 const authorized=verifyBearer(request,process.env.CRON_SECRET);
 return NextResponse.json({error:authorized?"retired":"unauthorized"},{status:authorized?410:401,headers:{"Cache-Control":"no-store"}});
}

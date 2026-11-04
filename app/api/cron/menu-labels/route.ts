import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {verifyBearer} from "@/lib/security/bearer";
import {labelAllCafesMenuCategories} from "@/lib/menu/drinkLabels.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const reply=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
/** Hourly. Labels each café's new menu categories (drink / not a drink) once.
 * The brief, Home and chat read the saved labels; nothing here waits on WhatsApp. */
export async function GET(request:Request){
  if(!verifyBearer(request,process.env.CRON_SECRET))return reply(401,{error:"unauthorized"});
  try{
    return reply(200,await labelAllCafesMenuCategories(createAdminSupabaseClient()));
  }catch{return reply(503,{error:"menu_labels_unavailable"});}
}

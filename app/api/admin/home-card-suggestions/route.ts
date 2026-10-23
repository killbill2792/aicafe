import {NextResponse} from "next/server";
import {z} from "zod";
import {requireAdmin} from "@/lib/admin/auth.server";
import {homeCardCandidates} from "@/lib/admin/topics";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireSameOrigin,readBoundedJson} from "@/lib/ai/conversations/http.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const schema=z.strictObject({topic:z.string().min(1).max(60)});
export async function POST(request:Request){
  const user=await requireAdmin(); // Unlisted accounts always receive a real 404.
  try{
    requireSameOrigin(request);
    const parsed=schema.safeParse(await readBoundedJson(request));
    if(!parsed.success||!homeCardCandidates.has(parsed.data.topic))
      return NextResponse.json({error:"invalid_topic"},{status:400});
    const db=createAdminSupabaseClient();
    // Unique topic + ignoreDuplicates makes a double click harmless.
    const {error}=await db.from("admin_home_card_suggestions").upsert({
      topic:parsed.data.topic,requested_by:user.id,status:"suggested",
    },{onConflict:"topic",ignoreDuplicates:true});
    if(error)throw error;
    return NextResponse.json({saved:true,published:false},{headers:{"Cache-Control":"no-store"}});
  }catch{ return NextResponse.json({error:"suggestion_unavailable"},{status:503});}
}

import {NextResponse} from "next/server";
import {z} from "zod";
import {requireAdmin} from "@/lib/admin/auth.server";
import {homeCardCandidates} from "@/lib/admin/topics";
import {createHomeCardSuggestion} from "@/lib/data/adminSuggestions.server";
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
    await createHomeCardSuggestion(parsed.data.topic,user.id);
    return NextResponse.json({saved:true,published:false},{headers:{"Cache-Control":"no-store"}});
  }catch{ return NextResponse.json({error:"suggestion_unavailable"},{status:503});}
}

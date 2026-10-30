import {NextResponse} from "next/server";
import {z} from "zod";
import {getOptionalAuthenticatedUser} from "@/lib/auth/requireUser";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAuthenticatedCafeTools,readSupervisorCafeIdentity} from "@/lib/ai/cafeTools.server";
import {loadOwnerFacts} from "@/lib/ownerFacts/store.server";
import {readCafeLocation} from "@/lib/data/cafeLocation.server";
import {searchNearbyEvents} from "@/lib/events/nearbyEventsSearch.server";
import {buildEventsOutlook} from "@/lib/events/outlook";

export const runtime="nodejs";export const dynamic="force-dynamic";
const headers={"Cache-Control":"private, no-store"};
const locale=z.enum(["en","es","ar"]);

/** Home "Coming up" card. Same builder as the chat's get_nearby_events tool,
 * scoped to the signed-in owner's active café (RLS). Loaded after the page so a
 * slow web search never delays Home. */
export async function GET(request:Request){
  const user=await getOptionalAuthenticatedUser();
  if(!user)return NextResponse.json({error:"unauthorized"},{status:401,headers});
  try{
    const lang=locale.catch("en").parse(new URL(request.url).searchParams.get("locale"));
    const businessId=await getActiveBusinessId(user.id);
    const [identity,tools,facts]=await Promise.all([readSupervisorCafeIdentity(businessId),createAuthenticatedCafeTools(),
      loadOwnerFacts(businessId).catch(()=>[])]);
    const outlook=await buildEventsOutlook({today:identity.asOf,timezone:identity.timezone,locale:lang,
      readLocation:async()=>readCafeLocation(await createServerSupabaseClient(),businessId,facts),
      search:searchNearbyEvents,
      readSales:async(from,to)=>{
        const slice=await tools.getSalesTrend({from,to});
        return slice.available?slice.value.map(d=>({date:d.date,netSalesCents:d.netSalesCents})):[];
      }});
    return NextResponse.json({...outlook,currency:identity.currency},{headers});
  }catch{
    console.error("events_outlook_failed");
    return NextResponse.json({error:"unavailable"},{status:503,headers});
  }
}

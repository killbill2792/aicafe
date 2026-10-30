import {z} from "zod";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {conversationError,conversationJson} from "@/lib/ai/conversations/http.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {createAuthenticatedCafeTools,readSupervisorCafeIdentity} from "@/lib/ai/cafeTools.server";
import {loadOwnerFacts} from "@/lib/ownerFacts/store.server";
import {readCafeLocation} from "@/lib/data/cafeLocation.server";
import {searchNearbyEvents} from "@/lib/events/nearbyEventsSearch.server";
import {buildEventsOutlook,hourlyOutlookRead} from "@/lib/events/outlook";

export const runtime="nodejs";export const dynamic="force-dynamic";
const locale=z.enum(["en","es","ar"]);

/** Home "Coming up" card. Same builder as the chat's get_nearby_events tool,
 * scoped to the signed-in owner's café (RLS). It runs a paid web search, so the
 * café's AI access is checked first, exactly like the chat. Loaded after the
 * page so a slow search never delays Home. */
export async function GET(request:Request){
  try{
    const {scope}=await authenticatedConversationContext();
    await assertCafeAiAccess(scope.businessId);
    const lang=locale.catch("en").parse(new URL(request.url).searchParams.get("locale"));
    const [identity,tools,facts]=await Promise.all([readSupervisorCafeIdentity(scope.businessId),createAuthenticatedCafeTools(),
      loadOwnerFacts(scope.businessId).catch(()=>[])]);
    const outlook=await buildEventsOutlook({today:identity.asOf,timezone:identity.timezone,locale:lang,
      readLocation:async()=>readCafeLocation(await createServerSupabaseClient(),scope.businessId,facts),
      search:searchNearbyEvents,
      readHourlySales:async(from,to)=>{
        const slice=await tools.getPeakHours({from,to});
        return hourlyOutlookRead(slice);
      },
      readSales:async(from,to)=>{
        const slice=await tools.getSalesTrend({from,to});
        return slice.available?slice.value.map(d=>({date:d.date,netSalesCents:d.netSalesCents})):[];
      }});
    return conversationJson({...outlook,currency:identity.currency});
  }catch(error){return conversationError(error);}
}

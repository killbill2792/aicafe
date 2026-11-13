import "server-only";
import {posFactReaders} from "@/lib/data/posFactReaders.server";
import {civilDateAdd} from "@/lib/calc/scheduling/plannerClock";
import {comparableDemandHours,unavailableScheduleDemand,
  type ScheduleDemandEvidence} from "@/lib/calc/scheduling/demandEvidence";
import {requireSchedulingOwner} from "./foundation.server";

/** Authenticated, café-isolated read of the ALREADY canonical POS hourly facts.
 * An absent or uncertified POS source never blocks manual schedule planning.
 * No direct provider calls, independent rollup queries or persisted forecasts. */
export async function readSchedulingDemandContext(
  weekStart:string,expectedBusinessId:string):Promise<ScheduleDemandEvidence>{
  const historicalPeriod={
    from:civilDateAdd(weekStart,-56),to:civilDateAdd(weekStart,-1),
  };
  const readAt=new Date().toISOString();
  const shell={targetWeekStart:weekStart,historicalPeriod,readAt};
  try{
    const owner=await requireSchedulingOwner();
    if(!owner||owner.businessId!==expectedBusinessId)
      return unavailableScheduleDemand(shell,["scheduleDemandUnauthorized"]);
    const slice=await posFactReaders(owner.supabase,owner.businessId)
      .peakHours(historicalPeriod);
    if(!slice.available)
      return unavailableScheduleDemand(shell,
        slice.quality.missingInputs.length?slice.quality.missingInputs:["hourlySalesUnavailable"]);
    return comparableDemandHours({...shell,hours:slice.value.hours,
      missing:slice.quality.missingInputs,stale:slice.quality.staleInputs});
  }catch{
    return unavailableScheduleDemand(shell,["hourlySalesUnavailable"]);
  }
}

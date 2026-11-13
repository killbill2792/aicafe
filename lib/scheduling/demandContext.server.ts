import "server-only";
import {posFactReaders} from "@/lib/data/posFactReaders.server";
import {civilDateAdd,localParts} from "@/lib/calc/scheduling/plannerClock";
import {comparableDemandHours,unavailableScheduleDemand,
  type ScheduleDemandEvidence} from "@/lib/calc/scheduling/demandEvidence";
import {requireSchedulingOwner} from "./foundation.server";

/** Authenticated, café-isolated read of the ALREADY canonical POS hourly facts.
 * An absent or uncertified POS source never blocks manual schedule planning.
 * No direct provider calls, independent rollup queries or persisted forecasts. */
export async function readSchedulingDemandContext(
  weekStart:string,expectedBusinessId:string,cafeTimezone:string|undefined,
  asOf:Date=new Date()):Promise<ScheduleDemandEvidence>{
  // A missing timezone is unknown, never a guessed UTC business date.
  if(!cafeTimezone){
    const historicalPeriod={from:civilDateAdd(weekStart,-56),to:civilDateAdd(weekStart,-1)};
    return unavailableScheduleDemand({targetWeekStart:weekStart,historicalPeriod,
      readAt:asOf.toISOString()},["cafeTimezoneUnavailable"]);
  }
  // Scheduling a future week cannot require POS facts from future days.
  // Use the verified business timezone and the last fully completed day.
  const today=localParts(asOf.getTime(),cafeTimezone).date;
  const end=civilDateAdd(weekStart,-1)<civilDateAdd(today,-1)
    ?civilDateAdd(weekStart,-1):civilDateAdd(today,-1);
  const historicalPeriod={from:civilDateAdd(end,-55),to:end};
  const readAt=asOf.toISOString();
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

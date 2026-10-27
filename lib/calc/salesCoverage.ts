import {dateOffset,periodDays,type CalcPeriod} from "./periods";
export type SalesConnection={provider:string;last_synced_at:string|null;backfill_completed_at:string|null};
export type SalesCoverageEvidence={
 covered:boolean;coveredDays:number;missingDays:string[];sources:string[];from:string|null;through:string|null;
 coveredDates:string[];
};
/** A canonical actual rollup covers a café day regardless of source (Toast, Square, CSV).
 * Square's completed historical backfill is an additional documented zero-day guarantee.
 * Never infer coverage solely from a Toast credential or its last sync timestamp. */
export function resolveSalesCoverage(
 period:CalcPeriod,actualDays:readonly string[],connections:readonly SalesConnection[]=[]
):SalesCoverageEvidence{
 const requested=Array.from({length:periodDays(period)},(_,i)=>dateOffset(period.from,i));
 const actual=new Set(actualDays.filter(day=>day>=period.from&&day<=period.to));
 const sources=new Set<string>();
 if(actual.size)sources.add("daily_rollups");
 for(const connection of connections){
  if(connection.provider!=="square"||!connection.backfill_completed_at||!connection.last_synced_at)continue;
  const earliest=dateOffset(connection.backfill_completed_at.slice(0,10),-89);
  const latest=connection.last_synced_at.slice(0,10);
  if(earliest>latest)continue;
  for(const day of requested)if(day>=earliest&&day<=latest){
   actual.add(day);sources.add("square_backfill");
  }
 }
 const coveredDates=requested.filter(day=>actual.has(day));
 const missingDays=requested.filter(day=>!actual.has(day));
 return {covered:missingDays.length===0,coveredDays:coveredDates.length,missingDays,
  sources:[...sources],from:coveredDates[0]??null,through:coveredDates.at(-1)??null,coveredDates};
}

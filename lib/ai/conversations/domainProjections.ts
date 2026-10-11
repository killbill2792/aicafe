import type { BusinessSnapshot } from "@/lib/data/types";
import type { StaffScheduleRow } from "@/lib/data/getStaffSchedules";
import { buildStaffViewModel } from "@/lib/viewmodels/staffViewModel";
import { buildBreakEvenViewModel } from "@/lib/viewmodels/breakEvenViewModel";
import type { CafeStatePeriod, KnownSlice } from "@/lib/operating/types";

const high = {level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const missing = <T>(reason: string): KnownSlice<T> => ({available:false,value:null,
  quality:{...high,level:"low",missingInputs:[reason]}});

/** Same current on-shift semantics as Staff screen. Never derive from raw open-timecard counts. */
export function projectCurrentStaff(snapshot: BusinessSnapshot) {
  const onShift = buildStaffViewModel(snapshot).onShift;
  return { count:onShift.length, asOf:snapshot.staffNowIso,
    people:onShift.slice(0,15).map(s=>({
      name:s.name.slice(0,100), role:s.role?.slice(0,70) ?? null,
      sourceType:s.sourceType, sourceProvider:s.sourceProvider,
      start:s.clockInIso, breakStatus:s.breakFlag,
      isSchedulePrediction:s.sourceType==="owner_schedule",
    })) };
}

/** Use precisely the Break-even page's deterministic computation/unavailable precedence. */
export function projectBreakEven(snapshot: BusinessSnapshot): KnownSlice<{
  drinksNeededPerDay:number; drinksPerHour:number; todayDrinks:number|null;
  dailyCostsToCoverCents:number; averageMoneyLeftPerDrinkCents:number;
  progressPercent:number|null;
}> {
  const vm = buildBreakEvenViewModel(snapshot);
  if(vm.unavailableReason) return missing("breakEven:"+vm.unavailableReason+
    (vm.missingCostLabels.length ? ":"+vm.missingCostLabels.slice(0,4).join(",") : ""));
  if(!Number.isFinite(vm.drinksNeededPerDay) || vm.drinksNeededPerDay<0) return missing("breakEven:invalidResults");
  return {available:true,value:{
    drinksNeededPerDay:vm.drinksNeededPerDay,drinksPerHour:vm.perHour,
    todayDrinks:snapshot.todayHasData ? vm.todayDrinks : null,
    dailyCostsToCoverCents:Math.round(vm.dailyCostsToCoverCents),
    averageMoneyLeftPerDrinkCents:Math.round(vm.avgMoneyLeftPerDrinkCents),
    progressPercent:snapshot.todayHasData ? Math.round(vm.progressPct) : null,
  },quality:{...high,missingInputs:snapshot.todayHasData ? [] : ["todayDrinksNotRecorded"]}};
}
export type CurrentStaffProjection=ReturnType<typeof projectCurrentStaff>;
export type BreakEvenProjection=NonNullable<Extract<Awaited<ReturnType<typeof projectBreakEven>>, {available:true}>["value"]>;
export type ScheduleProjection = { source:"owner_recurring_schedule"; from:string; to:string;
  shifts:Array<{displayName:string|null;dayOfWeek:number;startTime:string;endTime:string;
    effectiveFrom:string;effectiveTo:string|null}> };
/** Staff editor's active weekly recurring rows, not attendance or historical shift reconstruction. */
export function projectRecurringSchedule(rows: StaffScheduleRow[], employees:Record<string,string>,
  range:CafeStatePeriod,asOf:string):KnownSlice<ScheduleProjection> {
  if(range.from<asOf) return missing("historicalRecurringScheduleNotReconstructable");
  const next = new Date(asOf+"T12:00:00Z");next.setUTCDate(next.getUTCDate()+90);
  if(range.to>next.toISOString().slice(0,10))return missing("scheduleHorizonBeyond90Days");
  const occurs=(schedule:StaffScheduleRow)=>{
    const start=new Date(range.from+"T12:00:00Z");
    const end=new Date(range.to+"T12:00:00Z");
    for(let date=start;date<=end;date=new Date(date.getTime()+86_400_000)){
      const day=date.toISOString().slice(0,10);
      if(date.getUTCDay()===schedule.dayOfWeek && schedule.effectiveFrom<=day &&
        (!schedule.effectiveTo||schedule.effectiveTo>=day)) return true;
    }
    return false;
  };
  const selected=rows.filter(occurs)
    .slice(0,30).map(s=>({displayName:employees[s.employeeId]?.slice(0,100)??null,
      dayOfWeek:s.dayOfWeek,startTime:s.startTime,endTime:s.endTime,
      effectiveFrom:s.effectiveFrom,effectiveTo:s.effectiveTo}));
  return {available:true,value:{source:"owner_recurring_schedule",from:range.from,to:range.to,
    shifts:selected},quality:{...high,missingInputs:rows.length>30?["scheduleResultTruncated"]:[]}};
}

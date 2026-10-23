import type { OpenHours } from "@/lib/business/openHours";
import { OPEN_HOURS_DAY_KEYS } from "@/lib/business/openHours";

export type DraftEmployee={id:string;display_name:string;default_hourly_wage_cents:number|null;wage_period:string|null;wage_amount_cents:number|null;available_days?:number[]|null};
export type DraftRecurring={employee_id:string;day_of_week:number;start_time:string;end_time:string;effective_from:string;effective_to:string|null;unpaid_break_minutes:number|null};
export type DraftAvailability={employee_id:string;day_of_week:number;start_local:string;end_local:string;confirmation:string;source?:string|null;effective_from:string;effective_to:string|null};
export type DraftPreference={employee_id:string;max_weekly_minutes:number|null;effective_from:string;effective_to:string|null};
export type SchedulingDraftInputs={employees:DraftEmployee[];schedules:DraftRecurring[];availability:DraftAvailability[];preferences:DraftPreference[];
  openHours:OpenHours|null;prepMinutesBeforeOpen?:number;prepMinutesAfterClose?:number;unavailableDates?:Array<{employeeId:string;date:string;start?:string|null;end?:string|null;overnight?:boolean}>;timezone:string;timezoneDefaultedToUtc?:boolean;city:string|null;region:string|null;countryCode:string|null;missing?:string[]};
const minute=(v:string)=>Number(v.slice(0,2))*60+Number(v.slice(3,5));
const time=(n:number)=>String(Math.floor(n/60)).padStart(2,"0")+":"+String(n%60).padStart(2,"0");
const active=(row:{effective_from:string;effective_to:string|null},date:string)=>row.effective_from<=date&&(!row.effective_to||row.effective_to>=date);
const addDays=(date:string,n:number)=>new Date(Date.parse(date+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
export function nextMonday(asOf:string){const weekday=new Date(asOf+"T12:00:00Z").getUTCDay();return addDays(asOf,(8-weekday)%7||7);}
export function businessLocalDate(now:Date,timezone:string){
 const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
 const p=(type:string)=>parts.find(v=>v.type===type)?.value??"";
 return p("year")+"-"+p("month")+"-"+p("day");
}
/** Use latest preference window, with tightest cap for equivalent effective dates. */
function weeklyLimit(rows:DraftPreference[],employeeId:string,date:string){
 const p=rows.filter(p=>p.employee_id===employeeId&&active(p,date))
   .sort((a,b)=>b.effective_from.localeCompare(a.effective_from)||
     (a.max_weekly_minutes??2400)-(b.max_weekly_minutes??2400))[0];
 return p?.max_weekly_minutes??2400;
}
type DraftShift={employeeId:string;name:string;start:string;end:string;paidHours:number;wageCentsPerHour:number|null;costCents:number|null;origin:"recurring"|"suggested";availability:"confirmed"|"unconfirmed"};
function mergeSuggested(shifts:DraftShift[]):DraftShift[]{
 const result:DraftShift[]=[];
 for(const current of shifts){
  const previous=result[result.length-1];
  if(previous&&previous.origin==="suggested"&&current.origin==="suggested"&&
    previous.employeeId===current.employeeId&&previous.end===current.start){
    previous.end=current.end;
    previous.paidHours+=current.paidHours;
    previous.costCents=previous.wageCentsPerHour===null?null:Math.round(previous.paidHours*previous.wageCentsPerHour);
    previous.availability=previous.availability==="unconfirmed"||current.availability==="unconfirmed"?"unconfirmed":"confirmed";
  } else result.push({...current});
 }
 return result;
}
export function draftWeek(inputs:SchedulingDraftInputs,weekStart:string){
 const missing=[...(inputs.missing??[])],estimated:string[]=[];
 if(!inputs.openHours)missing.push("businessHoursNotSet");
 if(!inputs.employees.length)missing.push("noActiveStaff");
 if(inputs.timezoneDefaultedToUtc)estimated.push("timezoneDefaultedToUtc");
 const people=new Map(inputs.employees.map(e=>[e.id,e]));
 const wage=(e:DraftEmployee)=>e.wage_period==="hour"&&e.wage_amount_cents!==null?e.wage_amount_cents:
   e.wage_period!=="hour"?null:e.default_hourly_wage_cents;
 // A dated mask excludes only its actual local wall-clock window.
 const availableWindows=(start:number,end:number,masks:readonly {start:number;end:number}[])=>{
  let windows=[{start,end}];
  for(const mask of masks)windows=windows.flatMap(w=>
    mask.end<=w.start||mask.start>=w.end?[w]:[
     ...(mask.start>w.start?[{start:w.start,end:mask.start}]:[]),
     ...(mask.end<w.end?[{start:mask.end,end:w.end}]:[])
    ]);
  return windows;
 };
 const occupied=new Map<string,Array<{day:number;start:number;end:number}>>();
 const minutesByPerson=new Map<string,number>();
 const days=Array.from({length:7},(_,day)=>{
  const date=addDays(weekStart,day),weekday=new Date(date+"T12:00:00Z").getUTCDay();
  const before=Number.isInteger(inputs.prepMinutesBeforeOpen)&&inputs.prepMinutesBeforeOpen!>=0&&inputs.prepMinutesBeforeOpen!<=240?inputs.prepMinutesBeforeOpen!:0;
  const after=Number.isInteger(inputs.prepMinutesAfterClose)&&inputs.prepMinutesAfterClose!>=0&&inputs.prepMinutesAfterClose!<=240?inputs.prepMinutesAfterClose!:0;
  // Coverage begins with prep and ends with cleanup, without inventing an
  // overnight window outside the current civil day.
  const hours=(inputs.openHours?.[OPEN_HOURS_DAY_KEYS[weekday]]??[])
    .map(([a,b])=>[Math.max(0,minute(a)-before),Math.min(1439,minute(b)+after)] as [number,number])
    .filter(([a,b])=>a<b);
  const shifts:DraftShift[]=[];
  // The same masks apply to recurring baseline shifts and suggested coverage.
  // Prior-day overnight absences also mask the morning after midnight.
  const masksByPerson=new Map<string,Array<{start:number;end:number}>>();
  const previous=addDays(date,-1);
  for(const person of inputs.employees){
   const masks:Array<{start:number;end:number}>=[];
   for(const absence of inputs.unavailableDates??[]){
    if(absence.employeeId!==person.id)continue;
    const full=absence.start==null||absence.end==null;
    if(absence.date===date){
     if(full)masks.push({start:0,end:1440});
     else{
      const start=minute(absence.start!),end=minute(absence.end!);
      masks.push({start,end:absence.overnight||end<start?1440:end});
     }
    }else if(absence.date===previous&&!full){
     const start=minute(absence.start!),end=minute(absence.end!);
     if(absence.overnight||end<start)masks.push({start:0,end});
    }
   }
   masksByPerson.set(person.id,masks.filter(m=>m.start<m.end));
  }
  const add=(id:string,start:number,end:number,origin:"recurring"|"suggested",confirmation:"confirmed"|"unconfirmed",unpaid=0)=>{
   const e=people.get(id);if(!e||end<=start)return;
   const paidMinutes=Math.max(0,end-start-unpaid),rate=wage(e),cost=rate===null?null:Math.round(paidMinutes*rate/60);
   shifts.push({employeeId:id,name:e.display_name,start:time(start),end:time(end),paidHours:paidMinutes/60,wageCentsPerHour:rate,costCents:cost,origin,availability:confirmation});
   occupied.set(id,[...(occupied.get(id)??[]),{day,start,end}]);
   minutesByPerson.set(id,(minutesByPerson.get(id)??0)+paidMinutes);
  };
  for(const r of inputs.schedules.filter(r=>r.day_of_week===weekday&&active(r,date)&&people.has(r.employee_id))){
   const a=minute(r.start_time),b=minute(r.end_time);
   if(a>=b){estimated.push("overnightRecurringShiftNotDrafted");continue;}
   let portions=availableWindows(a,b,masksByPerson.get(r.employee_id)??[]);
   const ownerDays=people.get(r.employee_id)!.available_days;
   // Staff-profile availability can be unconfirmed; available_days alone
   // must not erase an otherwise valid legacy recurrence or its unpaid break.
   // Only ACTIVE, confirmed owner-direct windows establish an authoritative
   // restriction that can clip or remove a recurring baseline.
   const hasOwnerConfirmedRestriction=inputs.availability.some(v=>
     v.employee_id===r.employee_id&&v.source==="owner_direct"&&
     v.confirmation==="owner_confirmed"&&active(v,date));
   if(ownerDays!==undefined&&ownerDays!==null&&hasOwnerConfirmedRestriction){
    const allowed=ownerDays.includes(weekday)?inputs.availability
      .filter(v=>v.employee_id===r.employee_id&&v.day_of_week===weekday&&v.source==="owner_direct"&&
        v.confirmation==="owner_confirmed"&&active(v,date))
      .map(v=>({start:minute(v.start_local),end:minute(v.end_local)})):[];
    const clipped=portions.flatMap(p=>allowed.map(v=>({
     start:Math.max(p.start,v.start),end:Math.min(p.end,v.end)
    })).filter(v=>v.start<v.end)).sort((x,y)=>x.start-y.start||x.end-y.end);
    const merged:Array<{start:number;end:number}>=[];
    for(const interval of clipped){
     const prev=merged[merged.length-1];
     if(prev&&interval.start<=prev.end)prev.end=Math.max(prev.end,interval.end);
     else merged.push({...interval});
    }
    portions=merged;
   }
   if(portions.length===1&&portions[0].start===a&&portions[0].end===b){
    // Leave unaffected recurring shifts and their known break unchanged.
    add(r.employee_id,a,b,"recurring","unconfirmed",r.unpaid_break_minutes??0);
    continue;
   }
   estimated.push("recurringShiftAdjustedForAvailability");
   // Break allocation is estimated after a recurring shift is split; no
   // unpaid minutes are assigned to the unavailable interval.
   const breaks=portions.map(()=>0);
   let remaining=Math.min(r.unpaid_break_minutes??0,
     portions.reduce((sum,p)=>sum+Math.max(0,p.end-p.start-1),0));
   for(const i of portions.map((_,i)=>i).sort((i,j)=>
      (portions[j].end-portions[j].start)-(portions[i].end-portions[i].start))){
    const part=portions[i],taken=Math.min(remaining,Math.max(0,part.end-part.start-1));
    breaks[i]=taken;remaining-=taken;
   }
   portions.forEach((p,i)=>add(r.employee_id,p.start,p.end,"recurring","unconfirmed",breaks[i]));
  }
  // Split each open interval at all availability/shift boundaries, then select
  // the cheapest confirmed eligible employee for each uncovered segment.
  const unfilled:Array<{start:string;end:string;hours:number}>=[];
  for(const [a,b] of hours){
   const boundary=new Set<number>([a,b]);
   for(const s of shifts){const x=minute(s.start),y=minute(s.end);if(x>a&&x<b)boundary.add(x);if(y>a&&y<b)boundary.add(y);}
   for(const r of inputs.availability.filter(r=>r.day_of_week===weekday&&active(r,date))){for(const v of [minute(r.start_local),minute(r.end_local)])if(v>a&&v<b)boundary.add(v);}
   for(const masks of masksByPerson.values())for(const mask of masks)
    for(const v of [mask.start,mask.end])if(v>a&&v<b)boundary.add(v);
   const points=[...boundary].sort((x,y)=>x-y);
   let previous:string|null=null;
   for(let i=0;i<points.length-1;i++){
    const start=points[i],end=points[i+1];
    if(shifts.some(s=>minute(s.start)<=start&&minute(s.end)>=end)){previous=null;continue;}
    const eligible=inputs.employees.flatMap(e=>{
      const options=inputs.availability.filter(r=>r.employee_id===e.id&&r.day_of_week===weekday&&active(r,date)&&minute(r.start_local)<=start&&minute(r.end_local)>=end);
      if(!options.length||(masksByPerson.get(e.id)??[]).some(m=>m.start<end&&m.end>start))return [];
      if((occupied.get(e.id)??[]).some(o=>o.day===day&&o.start<end&&o.end>start))return [];
      if((minutesByPerson.get(e.id)??0)+(end-start)>weeklyLimit(inputs.preferences,e.id,date))return [];
      return [{e,confirmed:options.some(o=>o.confirmation==="owner_confirmed"),rate:wage(e)}];
    }).sort((x,y)=>Number(y.confirmed)-Number(x.confirmed)||(x.rate??Infinity)-(y.rate??Infinity)||x.e.display_name.localeCompare(y.e.display_name)||x.e.id.localeCompare(y.e.id));
    const first=eligible[0],candidate=eligible.find(e=>e.e.id===previous);
    // Keep one worker on a gap until no longer eligible, without preferring unknown wage to known.
    const best=first&&(candidate&&(candidate.rate!==null||first.rate===null)?candidate:first);
    if(best){
      add(best.e.id,start,end,"suggested",best.confirmed?"confirmed":"unconfirmed");
      previous=best.e.id;
      if(!best.confirmed)estimated.push("unconfirmedAvailability");
    }else{
      previous=null;
      unfilled.push({start:time(start),end:time(end),hours:(end-start)/60});
    }
   }
  }
  const merged=mergeSuggested(shifts);
  const dayHours=merged.reduce((sum,s)=>sum+s.paidHours,0);
  const dayCostCents=merged.some(s=>s.costCents===null)?null:merged.reduce((sum,s)=>sum+(s.costCents??0),0);
  return {date,weekday,openHours:hours.map(([a,b])=>({start:time(a),end:time(b)})),shifts:merged,unfilled,dayHours,dayCostCents};
 });
 const allShifts=days.flatMap(d=>d.shifts);
 const unknownWageNames=[...new Set(allShifts.filter(s=>s.costCents===null).map(s=>s.name))];
 return {source:"schedule_draft" as const,draft:true,saved:false,weekStart,weekEnd:addDays(weekStart,6),days:days.map(d=>({...d,shifts:d.shifts.map(({employeeId:_,...shift})=>shift)})),
  totals:{hours:allShifts.reduce((s,x)=>s+x.paidHours,0),knownCostCents:allShifts.reduce((s,x)=>s+(x.costCents??0),0),
    costIsPartial:allShifts.some(x=>x.costCents===null),unknownWageNames},
  perPerson:inputs.employees.filter(e=>minutesByPerson.has(e.id)).map(e=>{
    const shifts=allShifts.filter(s=>s.employeeId===e.id);
    return {name:e.display_name,hours:shifts.reduce((total,s)=>total+s.paidHours,0),
      costCents:shifts.some(s=>s.costCents===null)?null:shifts.reduce((total,s)=>total+(s.costCents??0),0)};
  }),
  missing:[...new Set(missing)],estimated:[...new Set(estimated)]};
}

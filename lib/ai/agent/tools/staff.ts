import { z } from "zod";
import type { AgentToolContext, AgentToolResult } from "./index";
import {resolveOwnerPeriod,periodChoicePayload} from "../resolve";
import {money} from "../explain";
import { scheduleReadTools } from "./scheduleReads";

const empty = z.strictObject({});
const range = z.strictObject({ from: z.iso.date(), to: z.iso.date() });
const period = z.strictObject({ period: z.union([z.string().min(1).max(32),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})]) });
const missing = (source: string, period: {from:string;to:string}|null, reasons: string[]): AgentToolResult => ({
  source, period, agentId:"olivia", missing: reasons.length ? reasons : ["sourceUnavailable"],
});
const days = (a: string,b:string) => (Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/86400000;
const requested = (choice:"today"|"week"|"month",asOf:string) => ({
  from:choice==="today"?asOf:choice==="month"?asOf.slice(0,7)+"-01":
    new Date(Date.parse(asOf+"T12:00:00Z")-6*86400000).toISOString().slice(0,10),to:asOf,
});
export const staffTools = {
  get_staff: {
    agentId:"olivia",schema:empty,description:"Read only active employees with recorded current shifts; repeating schedule predictions are not clock-ins.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx.tools.getCurrentStaff)return missing("current_staff",null,["staffReaderUnavailable"]);
      const s=await ctx.tools.getCurrentStaff();
      if(!s.available)return missing("current_staff",null,s.quality.missingInputs);
      const attendance=ctx.tools.getStaffAttendance&&ctx.timezone?
        await ctx.tools.getStaffAttendance({from:ctx.asOf,to:ctx.asOf},ctx.timezone):null;
      const tracked=attendance?.available?attendance.value.attendanceTracked:null;
      return {source:"current_staff",period:null,agentId:"olivia",
        missing:[...s.quality.missingInputs,...(attendance?.quality.missingInputs??["attendanceReaderUnavailable"])],
        attendanceTracked:tracked,onClockCount:attendance?.available?attendance.value.onClockCount:null,
        count:tracked?s.value.count:null,asOf:s.value.asOf,
        people:tracked?s.value.people.slice(0,15):[]};
    },
  },
  get_schedule: {
    agentId:"olivia",schema:range,
    description:"Read confirmed dated shifts for a business-local week. Old recurring patterns are not confirmed attendance or shifts.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const {from,to}=range.parse(raw),period={from,to};
      if(from>to||days(from,to)>90)return missing("scheduled_shifts",period,["scheduleRangeInvalid"]);
      if(from<ctx.asOf)return missing("scheduled_shifts",period,["historicalScheduleNotReconstructable"]);
      const d=new Date(from+"T12:00:00Z"),day=d.getUTCDay();
      const monday=new Date(d.getTime()-((day+6)%7)*86400000).toISOString().slice(0,10);
      const sunday=new Date(Date.parse(monday+"T12:00:00Z")+6*86400000).toISOString().slice(0,10);
      if(to>sunday)return {...missing("scheduled_shifts",period,["scheduleRangeRequiresWeeklyRead"]),href:"/staff?tab=schedule"};
      const confirmed=await scheduleReadTools.get_week_schedule.execute({week_start:monday},ctx);
      if(!Array.isArray(confirmed.shifts))return {...confirmed,period,href:"/staff?tab=schedule"};
      const shifts=confirmed.shifts.filter((s):s is {date:string}&Record<string,unknown>=>{
        return typeof s==="object"&&s!==null&&typeof (s as {date?:unknown}).date==="string"&&
          (s as {date:string}).date>=from&&(s as {date:string}).date<=to;
      });
      const weeklySet=confirmed.scheduleSet===true,exactWeek=from===monday&&to===sunday;
      const oldMissing=(confirmed.missing as string[]).filter(v=>v!=="scheduleNotSet");
      return {...confirmed,source:"scheduled_shifts",period,shifts,
        scheduleSet:weeklySet,windowHasShifts:shifts.length>0,
        ...(!exactWeek?{paidMinutes:null,knownWagesCents:null,estimated:null,estimatedShiftCount:null,gaps:[]}:{}),
        missing:[...(!weeklySet?["scheduleNotSet"]:shifts.length===0?["noShiftsInRequestedRange"]:[]),
          ...oldMissing,...(!exactWeek?["requestRangeTotalsNotAvailable"]:[])]};
    },
  },
  get_labor: {
    agentId:"olivia",schema:period,description:"Labor-day costs, including estimated inputs, and recorded attendance for a current period.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const resolved=resolveOwnerPeriod(period.parse(raw).period,{asOf:ctx.asOf,timezone:ctx.timezone??"UTC"},ctx.resolveState);
      if(resolved.status!=="resolved")return periodChoicePayload("labor_and_attendance",resolved);
      const p={from:resolved.value.from,to:resolved.value.to};
      if(!ctx.tools.getLaborMetrics||!ctx.tools.getStaffAttendance||!ctx.timezone)
        return missing("labor_and_attendance",p,["laborReaderOrTimezoneUnavailable"]);
      const [labor,attendance]=await Promise.all([ctx.tools.getLaborMetrics(p),
        ctx.tools.getStaffAttendance(p,ctx.timezone)]);
      const issues=[...labor.quality.missingInputs,...attendance.quality.missingInputs];
      const explain=labor.available?labor.value.slice(-12).filter(d=>Number.isSafeInteger(d.loadedStaffCostCents)&&
        Number.isSafeInteger(d.wagesCents)&&Number.isSafeInteger(d.staffTaxCents)).map(d=>({
          label:"Labor "+d.date,inputs:[{name:"wages",value:money(d.wagesCents)},
            {name:"staffTax",value:money(d.staffTaxCents)}],formula:"sum" as const,
          result:money(d.loadedStaffCostCents),period:{from:d.date,to:d.date},
          source:"get_labor",provenance:labor.quality.estimatedInputs.length?"estimate" as const:"recorded" as const
        })): [];
      return {source:"labor_and_attendance",period:p,agentId:"olivia",missing:issues,explain,estimated:[...labor.quality.estimatedInputs,...attendance.quality.estimatedInputs],
        laborDays:labor.available?labor.value.slice(-31).map(d=>({
          date:d.date,wagesCents:d.wagesCents,staffTaxCents:d.staffTaxCents,
          loadedStaffCostCents:d.loadedStaffCostCents})):null,
        attendanceTracked:attendance.available?attendance.value.attendanceTracked:null,
        attendance:attendance.available?attendance.value:null};
    },
  },
} as const;

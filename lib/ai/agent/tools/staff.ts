import { z } from "zod";
import type { AgentToolContext, AgentToolResult } from "./index";
import { scheduleReadTools } from "./scheduleReads";

const empty = z.strictObject({});
const range = z.strictObject({ from: z.iso.date(), to: z.iso.date() });
const period = z.strictObject({ period: z.enum(["today", "week", "month"]) });
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
    agentId: "olivia", schema:empty, description:"Read only active employees with recorded current shifts; old repeating schedule predictions are not clock-ins.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx.tools.getCurrentStaff)return missing("current_staff",null,["staffReaderUnavailable"]);
      const s=await ctx.tools.getCurrentStaff();
      if(!s.available)return missing("current_staff",null,s.quality.missingInputs);
      const attendance = ctx.tools.getStaffAttendance && ctx.timezone
        ? await ctx.tools.getStaffAttendance({from:ctx.asOf,to:ctx.asOf},ctx.timezone)
        : null;
      const tracked=attendance?.available ? attendance.value.attendanceTracked : null;
      return {source:"current_staff",period:null,agentId:"olivia",
        missing:[...s.quality.missingInputs,
          ...(attendance?.quality.missingInputs ?? ["attendanceReaderUnavailable"])],
        attendanceTracked:tracked, onClockCount:attendance?.available ? attendance.value.onClockCount : null,
        count:tracked ? s.value.count : null,asOf:s.value.asOf,
        people:tracked ? s.value.people.slice(0,15) : []};
    },
  },
  get_schedule: {
    agentId:"olivia",schema:range,
    description:"Read the confirmed dated schedule from scheduled_shifts for one business-local week. Old repeating staff_schedules are not confirmed shifts. For more weeks use get_week_schedule separately.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const {from,to}=range.parse(raw),period={from,to};
      if(from<ctx.asOf)return missing("scheduled_shifts",period,["historicalScheduleNotReconstructable"]);
      if(from>to||days(from,to)>90)return missing("scheduled_shifts",period,["scheduleRangeInvalid"]);
      const d=new Date(from+"T12:00:00Z");
      const day=d.getUTCDay(),monday=new Date(d.getTime()-((day+6)%7)*86400000).toISOString().slice(0,10);
      const sunday=new Date(Date.parse(monday+"T12:00:00Z")+6*86400000).toISOString().slice(0,10);
      if(to>sunday)return {...missing("scheduled_shifts",period,["scheduleRangeRequiresWeeklyRead"]),href:"/staff?tab=schedule"};
      const confirmed=await scheduleReadTools.get_week_schedule.execute({week_start:monday},ctx);
      if(!Array.isArray(confirmed.shifts))return {...confirmed,period,href:"/staff?tab=schedule"};
      const shifts=confirmed.shifts.filter((s):s is {date:string} & Record<string,unknown>=>{
        return typeof s==="object"&&s!==null&&typeof (s as {date?:unknown}).date==="string"
          &&(s as {date:string}).date>=from&&(s as {date:string}).date<=to;
      });
      return {...confirmed,source:"scheduled_shifts",period,shifts,
        scheduleSet:shifts.length>0,
        missing:shifts.length===0?["scheduleNotSet"]:(confirmed.missing as string[]).filter(v=>v!=="scheduleNotSet")};
    },
  },
  get_labor: {
    agentId:"olivia",schema:period,description:"Labor-day costs, including estimated inputs, and recorded attendance for a current period.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const choice=period.parse(raw).period,p=requested(choice,ctx.asOf);
      if(!ctx.tools.getLaborMetrics||!ctx.tools.getStaffAttendance||!ctx.timezone)
        return missing("labor_and_attendance",p,["laborReaderOrTimezoneUnavailable"]);
      const [labor,attendance]=await Promise.all([ctx.tools.getLaborMetrics(p),
        ctx.tools.getStaffAttendance(p,ctx.timezone)]);
      const issues=[...labor.quality.missingInputs,...attendance.quality.missingInputs];
      return {source:"labor_and_attendance",period:p,agentId:"olivia",missing:issues,estimated:[...labor.quality.estimatedInputs,...attendance.quality.estimatedInputs],
        laborDays:labor.available?labor.value.slice(-31).map(d=>({
          date:d.date,wagesCents:d.wagesCents,staffTaxCents:d.staffTaxCents,
          loadedStaffCostCents:d.loadedStaffCostCents})):null,
        attendanceTracked:attendance.available?attendance.value.attendanceTracked:null,
        attendance:attendance.available?attendance.value:null};
    },
  },
} as const;

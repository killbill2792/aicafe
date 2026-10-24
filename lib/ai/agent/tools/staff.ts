import { z } from "zod";
import type { AgentToolContext, AgentToolResult } from "./index";
import {resolvePeriod} from "@/lib/calc/periods";
import {periodChoicePayload} from "../resolve";

const empty = z.strictObject({});
const range = z.strictObject({ from: z.iso.date(), to: z.iso.date() });
const period = z.strictObject({ period: z.union([z.enum(["today","week","month","last_week","last_month","ytd"]),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})]) });
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
    agentId: "olivia", schema:empty, description:"Who is on shift now, including scheduled predictions versus clocked-in people.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx.tools.getCurrentStaff)return missing("current_staff",null,["staffReaderUnavailable"]);
      const s=await ctx.tools.getCurrentStaff();
      if(!s.available)return missing("current_staff",null,s.quality.missingInputs);
      return {source:"current_staff",period:null,agentId:"olivia",missing:s.quality.missingInputs,
        count:s.value.count,asOf:s.value.asOf,people:s.value.people.slice(0,15)};
    },
  },
  get_schedule: {
    agentId:"olivia",schema:range,description:"Read owner-entered recurring shifts for future dates; cannot reconstruct past rosters.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const {from,to}=range.parse(raw),period={from,to};
      if(from<ctx.asOf)return missing("recurring_schedule",period,["historicalScheduleNotReconstructable"]);
      if(from>to||days(from,to)>90)return missing("recurring_schedule",period,["scheduleRangeInvalid"]);
      if(!ctx.tools.getRecurringSchedule)return missing("recurring_schedule",period,["scheduleReaderUnavailable"]);
      const s=await ctx.tools.getRecurringSchedule(period,ctx.asOf);
      if(!s.available)return missing("recurring_schedule",period,s.quality.missingInputs);
      return {source:"recurring_schedule",period,agentId:"olivia",missing:s.quality.missingInputs,
        shifts:s.value.shifts.slice(0,30),sourceType:s.value.source};
    },
  },
  get_labor: {
    agentId:"olivia",schema:period,description:"Labor-day costs, including estimated inputs, and recorded attendance for a current period.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const resolved=resolvePeriod(period.parse(raw).period,{asOf:ctx.asOf,timezone:ctx.timezone??"UTC"});
      if(resolved.status!=="resolved")return periodChoicePayload("labor_and_attendance",resolved);
      const p={from:resolved.value.from,to:resolved.value.to};
      if(!ctx.tools.getLaborMetrics||!ctx.tools.getStaffAttendance||!ctx.timezone)
        return missing("labor_and_attendance",p,["laborReaderOrTimezoneUnavailable"]);
      const [labor,attendance]=await Promise.all([ctx.tools.getLaborMetrics(p),
        ctx.tools.getStaffAttendance(p,ctx.timezone)]);
      const issues=[...labor.quality.missingInputs,...attendance.quality.missingInputs];
      return {source:"labor_and_attendance",period:p,agentId:"olivia",missing:issues,estimated:[...labor.quality.estimatedInputs,...attendance.quality.estimatedInputs],
        laborDays:labor.available?labor.value.slice(-31).map(d=>({
          date:d.date,wagesCents:d.wagesCents,staffTaxCents:d.staffTaxCents,
          loadedStaffCostCents:d.loadedStaffCostCents})):null,
        attendance:attendance.available?attendance.value:null};
    },
  },
} as const;

import { z } from "zod";
import type { AgentToolContext, AgentToolResult } from "./index";
import {resolveOwnerPeriod,periodChoicePayload} from "../resolve";
import {money} from "../explain";
import {mergeScheduleShifts} from "./scheduleReads";
import {dateOffset} from "@/lib/calc/periods";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { getWeekSchedule } from "@/lib/actions/schedule";

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
      if(from>to)return missing("scheduled_shifts",period,["scheduleRangeInvalid"]);
      const capped=days(from,to)>=366,dateEnd=capped?dateOffset(from,365):to;
      const monday=dateOffset(from,-((new Date(from+"T12:00:00Z").getUTCDay()+6)%7));
      const notes:string[]=capped?[{en,es,ar}[ctx.locale].DataNotes.scheduleRangeTruncated]:[];
      const missingInputs:string[]=capped?["scheduleRangeTruncated"]:[];
      const allShifts:ReturnType<typeof mergeScheduleShifts>=[];
      let scheduleSet=false;
      for(let ws=monday;ws<=dateEnd;ws=dateOffset(ws,7)){
        const response=await getWeekSchedule({weekStart:ws});
        if(!response.ok){missingInputs.push("scheduleReadFailed:"+ws+":"+response.error);continue;}
        if(response.data.posScheduleError){
          missingInputs.push("toastScheduleReadFailed:"+ws);
          notes.push({en,es,ar}[ctx.locale].DataNotes.toastScheduleReadFailed
           .replace("{reason}",response.data.posScheduleError));
        }
        const merged=mergeScheduleShifts(response.data);
        scheduleSet ||= merged.length>0;
        allShifts.push(...merged.filter(s=>s.date>=from&&s.date<=dateEnd));
      }
      const selected=allShifts.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
      if(!scheduleSet&&!missingInputs.length)missingInputs.push("scheduleNotSet");
      else if(!selected.length&&!missingInputs.length)missingInputs.push("noShiftsInRequestedRange");
      if(selected.length>250)missingInputs.push("moreShifts");
      return {source:"scheduled_shifts+pos_scheduled_shifts",period,agentId:"olivia",
        href:"/staff?tab=schedule",scheduleSet,windowHasShifts:selected.length>0,
        shifts:selected.slice(0,250),paidMinutes:null,knownWagesCents:null,
        estimated:null,estimatedShiftCount:null,gaps:[],
        missing:[...missingInputs,"requestRangeTotalsNotAvailable"],
        dataNotes:[...new Set(notes)]};
    },
  },
  get_labor: {
    agentId:"olivia",schema:period,description:"Labor-day costs, including estimated inputs, and recorded attendance for a current period.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const resolved=resolveOwnerPeriod(period.parse(raw).period,{asOf:ctx.asOf,timezone:ctx.timezone},ctx.resolveState);
      if(resolved.status!=="resolved")return periodChoicePayload("labor_and_attendance",resolved);
      const p={from:resolved.value.from,to:resolved.value.to};
      if(!ctx.tools.getLaborMetrics||!ctx.tools.getStaffAttendance||!ctx.timezone)
        return missing("labor_and_attendance",p,["laborReaderOrTimezoneUnavailable"]);
      const [labor,attendance,ownerPayroll,toastScopes,reviews]=await Promise.all([
        ctx.tools.getLaborMetrics(p),
        ctx.tools.getStaffAttendance(p,ctx.timezone),
        ctx.tools.getOwnerMonthlyPayrollExtras?.(),
        ctx.tools.getToastScopeCoverage?.(),
        ctx.tools.getPosImportReviews?.(),
      ]);
      const issues=[...labor.quality.missingInputs,...attendance.quality.missingInputs,
        ...(labor.available?labor.value.filter(d=>d.wageStatus==="missing"||d.wagesCents===null||d.staffTaxCents===null)
         .map(d=>"laborWageUnknown:"+d.date):[])];
      const explain=labor.available?labor.value.slice(-12).filter(d=>d.wageStatus!=="missing"&&d.loadedStaffCostCents!==null&&d.wagesCents!==null&&d.staffTaxCents!==null&&Number.isSafeInteger(d.loadedStaffCostCents)&&
        Number.isSafeInteger(d.wagesCents)&&Number.isSafeInteger(d.staffTaxCents)).map(d=>({
          label:"Labor "+d.date,inputs:[{name:"wages",value:money(d.wagesCents!)},
            {name:"staffTax",value:money(d.staffTaxCents!)}],formula:"sum" as const,
          result:money(d.loadedStaffCostCents!),period:{from:d.date,to:d.date},
          source:"get_labor",provenance:labor.quality.estimatedInputs.length?"estimate" as const:"recorded" as const
        })): [];
      const ownerMonthlyPayrollExtrasCents=ownerPayroll?.available?
        ownerPayroll.value.monthlyCents:null;
      return {source:"labor_and_attendance",period:p,agentId:"olivia",
        ownerMonthlyPayrollExtrasCents,
        toastLaborScopeAvailable:toastScopes?.available?toastScopes.value.labor:null,
        pendingPosStaffReviews:reviews?.available?reviews.value:null,
        posReviewHref:"/staff",
        posReviewMissing:reviews?.quality.missingInputs??["toastReviewsUnavailable"],
        ownerMonthlyPayrollStatus:ownerMonthlyPayrollExtrasCents===null?"missing":"Estimate",
        ownerMonthlyPayrollSource:ownerMonthlyPayrollExtrasCents===null?null:"You told me",
        missing:[...issues,
          ...(toastScopes?.available&&toastScopes.value.labor===false?["toastLaborScopeMissing"]:[]),
          ...(ownerMonthlyPayrollExtrasCents===null?
           ["ownerMonthlyPayrollExtrasNotSet"]:[])],explain,estimated:[...labor.quality.estimatedInputs,...attendance.quality.estimatedInputs,
          ...(labor.available?labor.value.filter(d=>d.wageStatus==="estimate")
           .map(d=>"laborWageEstimate:"+d.date):[])],
        laborDays:labor.available?labor.value.slice(-31).map(d=>({
          date:d.date,wagesCents:d.wagesCents,staffTaxCents:d.staffTaxCents,
          loadedStaffCostCents:d.loadedStaffCostCents,wageStatus:d.wageStatus})):null,
        attendanceTracked:attendance.available?attendance.value.attendanceTracked:null,
        attendance:attendance.available?attendance.value:null};
    },
  },
} as const;

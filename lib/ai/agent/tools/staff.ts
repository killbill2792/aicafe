import { z } from "zod";
import type { AgentToolContext, AgentToolResult } from "./index";
import {localizedToastScheduleReadError} from "./scheduleReads";
import {projectVisibleStaffWeek} from "@/lib/calc/scheduling/schedulePresentation";
import {dateOffset} from "@/lib/calc/periods";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { getWeekSchedule } from "@/lib/actions/schedule";

const range = z.strictObject({ from: z.iso.date(), to: z.iso.date() });
const missing = (source: string, period: {from:string;to:string}|null, reasons: string[]): AgentToolResult => ({
  source, period, agentId:"olivia", missing: reasons.length ? reasons : ["sourceUnavailable"],
});
const days = (a: string,b:string) => (Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/86400000;
export const staffTools = {
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
      const allShifts:ReturnType<typeof projectVisibleStaffWeek>["visible"]=[];
      let scheduleSet=false;
      for(let ws=monday;ws<=dateEnd;ws=dateOffset(ws,7)){
        let response:Awaited<ReturnType<typeof getWeekSchedule>>;
        try{response=ctx.investigation?
          await ctx.investigation.weekSchedule(ws):ctx.readWeekSchedule?
          await ctx.readWeekSchedule(ws):await getWeekSchedule({weekStart:ws});}
        catch{missingInputs.push("scheduleReadFailed:"+ws);notes.push(
          {en,es,ar}[ctx.locale].DataNotes.staffScheduleWeekReadFailed.replace("{date}",ws));continue;}
        if(!response.ok){missingInputs.push("scheduleReadFailed:"+ws+":"+response.error);
          notes.push({en,es,ar}[ctx.locale].DataNotes.staffScheduleWeekReadFailed.replace("{date}",ws));continue;}
        if(response.data.posScheduleError){
          missingInputs.push("toastScheduleReadFailed:"+ws);
          notes.push(localizedToastScheduleReadError(response.data.posScheduleError,ctx.locale));
        }
        const merged=projectVisibleStaffWeek(response.data).visible;
        scheduleSet ||= merged.length>0;
        allShifts.push(...merged.filter(s=>s.date>=from&&s.date<=dateEnd));
      }
      // Overlapping Toast shifts can occur in both adjacent weekly queries.
      // Identify an assignment by its source and stable location-scoped shift ID.
      const seen=new Set<string>();
      const selected=allShifts.filter(shift=>{
        const key=shift.source==="toast"?
          "toast:"+shift.locationId+":"+shift.id:"app:"+shift.id;
        if(seen.has(key))return false;
        seen.add(key);return true;
      }).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
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
} as const;

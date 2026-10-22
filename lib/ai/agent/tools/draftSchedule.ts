import {z} from "zod";
import type {AgentToolContext,AgentToolResult} from "./index";
import {draftWeek,nextMonday} from "@/lib/calc/scheduling/draftWeek";
const monday=z.iso.date().refine(v=>new Date(v+"T12:00:00Z").getUTCDay()===1,"Must be a Monday");
const schema=z.strictObject({week_start:monday.nullable()});
export const draftScheduleTools={draft_week_schedule:{
 agentId:"olivia",schema,description:"Draft (not save) a week schedule from recurring shifts, open hours, availability and wages. Present as a table per day with hours and labor cost, list unfilled gaps, and say clearly it is a draft that is not saved.",
 execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
  const {week_start}=schema.parse(raw);
  if(!ctx.tools.getSchedulingDraftInputs)return {source:"schedule_draft",period:null,agentId:"olivia",draft:true,saved:false,missing:["scheduleDraftReaderUnavailable"]};
  const slice=await ctx.tools.getSchedulingDraftInputs();
  if(!slice.available)return {source:"schedule_draft",period:null,agentId:"olivia",draft:true,saved:false,missing:slice.quality.missingInputs};
  const start=week_start??nextMonday(ctx.asOf);
  return {...draftWeek({...slice.value,missing:slice.quality.missingInputs},start),period:null,agentId:"olivia"};
 }
}} as const;

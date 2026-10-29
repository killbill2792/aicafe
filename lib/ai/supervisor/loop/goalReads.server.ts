import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readOwnerProposals,type OwnerScope} from "./reads.server";
import {SupabaseLoopRepository} from "./supabase.server";
import {goalCapabilityId} from "./goal.server";
import {goalEffectSchema,scoreGoal,addDays,unitOf,type GoalEffect} from "@/lib/calc/goals/goalSpec";
import {goalMidRunText,goalReportText,type GoalLocale} from "@/lib/calc/goals/goalText";

const GOAL_STATUSES=["draft","approved","committed","monitored"] as const;
export type GoalListItem={id:string;threadId:string;title:string;status:string;
  startsOn:string|null;endsOn:string|null;days:number};

function window(p:{monitoring_start_date:string|null},effect:GoalEffect){
  const start=p.monitoring_start_date;
  return {start,end:start?addDays(start,effect.days-1):null};
}
/** The owner's goals, newest first, through the shared owner-scoped reader. */
export async function listOwnerGoals(db:SupabaseClient,scope:OwnerScope):Promise<GoalListItem[]>{
  const rows=(await readOwnerProposals(db,scope,{statuses:GOAL_STATUSES,limit:30}))
    .filter(p=>p.capability_id===goalCapabilityId);
  return rows.flatMap(p=>{
    const effect=goalEffectSchema.safeParse(p.canonical_effect_payload);
    if(!effect.success)return [];
    const w=window(p,effect.data);
    return [{id:p.id,threadId:p.thread_id,title:effect.data.title,status:p.status,startsOn:w.start,endsOn:w.end,days:effect.data.days}];
  }).slice(0,10);
}

/** One goal scored from its stored daily samples (no new POS reads). */
export async function readGoalStatus(db:SupabaseClient,scope:OwnerScope&{locale:GoalLocale},goalId:string,today:string){
  const [p]=await readOwnerProposals(db,scope,{id:goalId,limit:1});
  if(!p||p.capability_id!==goalCapabilityId)return null;
  const effect=goalEffectSchema.parse(p.canonical_effect_payload);
  const w=window(p,effect);
  const samples=w.start?await new SupabaseLoopRepository().samples({...scope,threadId:p.thread_id},p.id):[];
  const inWindow=samples.filter(s=>w.start&&w.end&&s.businessDate>=w.start&&s.businessDate<=w.end);
  const complete=Boolean(w.end&&today>w.end);
  // Scored through yesterday (or the last goal day): unsampled days count as missing.
  const yesterday=addDays(today,-1);
  const through=w.end&&yesterday>w.end?w.end:yesterday;
  const outcome=scoreGoal(effect,inWindow,complete,w.start&&through>=w.start?{start:w.start,through}:undefined);
  const text=complete?goalReportText(effect,outcome,scope.locale):goalMidRunText(effect,outcome,scope.locale);
  return {proposal:p,effect,window:w,outcome,text,sampledDays:inWindow.length};
}
/** Daily averages in the metric's unit; money rounded to whole cents like the report text. */
export function roundForUnit(effect:GoalEffect,metricId:string,v:number|null):number|null{
  if(v===null)return null;
  const m=effect.metrics.find(x=>x.id===metricId);
  if(!m)return null;
  return unitOf(m.metricKey)==="cents"?Math.round(v):Math.round(v*10)/10;
}

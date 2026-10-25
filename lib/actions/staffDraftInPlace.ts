"use server";
import {z} from "zod";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {readSchedulingDraftInputs} from "@/lib/data/schedulingDraftInputs.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import type {SupabaseClient} from "@supabase/supabase-js";
import {scheduleProposalReplacesSavedShifts} from "@/lib/calc/scheduling/staffDraftReview";
import {draftWeekWithStaffIds,businessLocalDate} from "@/lib/calc/scheduling/draftWeek";
import {staffProposalInputs} from "@/lib/ai/agent/tools/staffProposals";
import {staffCapabilityId} from "@/lib/ai/supervisor/loop/staffProposals.server";
import {proposeLoop,type OwnerLoopScope} from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";

const wageRates=(employees:Array<{id:string;wage_period:string|null;
  wage_amount_cents:number|null;default_hourly_wage_cents:number|null}>)=>
  Object.fromEntries(employees.map(person=>[person.id,
    person.wage_period==="hour" ? person.wage_amount_cents??person.default_hourly_wage_cents : null]));

/** Use authoritative owner/RLS reads, never a stale browser grid, to detect
 * a saved week. This first check reduces orphan drafts; the canonical preview
 * check below closes the race between this read and proposal simulation. */
async function hasSavedWeekShifts(client:SupabaseClient,businessId:string,week:string){
 const last=new Date(Date.parse(week+"T12:00:00Z")+6*86400000).toISOString().slice(0,10);
 const {data,error}=await client.from("scheduled_shifts").select("id")
  .eq("business_id",businessId).gte("local_date",week).lte("local_date",last)
  .is("deleted_at",null).limit(1);
 if(error)throw error;
 return (data?.length??0)>0;
}
async function proposeForEmptyWeek(scope:OwnerLoopScope,raw:z.infer<typeof staffProposalInputs.propose_schedule>,requestKey:string){
 const repo=new SupabaseLoopRepository();
 const proposal=await proposeLoop(scope,supervisorLoopRegistry,repo,
  staffCapabilityId("propose_schedule"),raw,requestKey);
 if(!scheduleProposalReplacesSavedShifts(proposal.canonicalEffectPayload))return proposal;
 // Never return an approval ID for a proposal that would delete rows which
 // this simplified card cannot show. Even if rejection fails, it is inert.
 try{await repo.transition(scope,proposal.id,proposal.revision,"reject");}catch{/* no write; approval stays token guarded */}
 return null;
}

const input=z.strictObject({week:z.iso.date(),threadId:z.uuid(),requestKey:z.uuid(),
  locale:z.enum(["en","es","ar"])});
/** Owner-click draft: authoritative scheduling inputs, inert approval ledger; no shift writes. */
export async function draftStaffWeekInPlace(raw:unknown){
  const parsed=input.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid"};
  try{
    const {scope,service}=await authenticatedConversationContext();
    await service.getThread(parsed.data.threadId);
    await assertCafeAiAccess(scope.businessId);
    const client=await createServerSupabaseClient();
    const slice=await readSchedulingDraftInputs(client,scope.businessId);
    if(!slice.available||slice.quality.missingInputs.length)
      return {ok:false as const,error:"missing"};
    const today=businessLocalDate(new Date(),slice.value.timezone);
    if(new Date(parsed.data.week+"T12:00:00Z").getUTCDay()!==1 ||
       parsed.data.week<today)return {ok:false as const,error:"week"};
    if(await hasSavedWeekShifts(client,scope.businessId,parsed.data.week))
      return {ok:false as const,error:"week_changed"};
    const result=draftWeekWithStaffIds(slice.value,parsed.data.week);
    if(result.missing.length)return {ok:false as const,error:"missing"};
    const shifts=result.days.flatMap(day=>day.shifts.map(shift=>({
      employee_id:shift.employeeId,date:day.date,start:shift.start,
      end:shift.end,break_minutes:Math.round(
        (Number(shift.end.slice(0,2))*60+Number(shift.end.slice(3,5))-
         Number(shift.start.slice(0,2))*60-Number(shift.start.slice(3,5)))-
         shift.paidHours*60)
    })));
    if(!shifts.length||shifts.length>60||
      shifts.some(shift=>!shift.employee_id||shift.break_minutes<0||shift.break_minutes>240))
      return {ok:false as const,error:"invalid"};
    const proposed=staffProposalInputs.propose_schedule.safeParse({
      week_start:parsed.data.week,shifts});
    if(!proposed.success)return {ok:false as const,error:"invalid"};
    const proposal=await proposeForEmptyWeek({...scope,threadId:parsed.data.threadId,
      locale:parsed.data.locale},proposed.data,parsed.data.requestKey);
    if(!proposal)return {ok:false as const,error:"week_changed"};
    return {ok:true as const,proposalId:proposal.id,revision:proposal.revision,
      shifts:proposed.data.shifts,
      costIsPartial:result.totals.costIsPartial,estimated:result.estimated.length>0,
      wageRates:wageRates(slice.value.employees)};
  }catch{return {ok:false as const,error:"unavailable"};}
}

const revisedInput=z.strictObject({week:z.iso.date(),threadId:z.uuid(),requestKey:z.uuid(),
  locale:z.enum(["en","es","ar"]),shifts:staffProposalInputs.propose_schedule.shape.shifts});
/** Edits stay inert: propose the exact reviewed rows as a fresh approval effect. */
export async function reviseStaffWeekDraft(raw:unknown){
  const parsed=revisedInput.safeParse(raw);
  if(!parsed.success)return {ok:false as const,error:"invalid"};
  try{
    const {scope,service}=await authenticatedConversationContext();
    await service.getThread(parsed.data.threadId);
    await assertCafeAiAccess(scope.businessId);
    const client=await createServerSupabaseClient();
    const slice=await readSchedulingDraftInputs(client,scope.businessId);
    if(!slice.available||slice.quality.missingInputs.length)
      return {ok:false as const,error:"missing"};
    const today=businessLocalDate(new Date(),slice.value.timezone);
    if(new Date(parsed.data.week+"T12:00:00Z").getUTCDay()!==1||
       parsed.data.week<today)return {ok:false as const,error:"week"};
    if(parsed.data.shifts.length===0)return {ok:false as const,error:"invalid"};
    if(await hasSavedWeekShifts(client,scope.businessId,parsed.data.week))
      return {ok:false as const,error:"week_changed"};
    const staff=new Set(slice.value.employees.map(x=>x.id));
    if(parsed.data.shifts.some(x=>!staff.has(x.employee_id)||x.date<parsed.data.week||
       x.date>new Date(Date.parse(parsed.data.week+"T12:00:00Z")+6*86400000).toISOString().slice(0,10)))
      return {ok:false as const,error:"invalid"};
    const proposal=await proposeForEmptyWeek({...scope,threadId:parsed.data.threadId,
      locale:parsed.data.locale},{week_start:parsed.data.week,
        shifts:parsed.data.shifts},parsed.data.requestKey);
    if(!proposal)return {ok:false as const,error:"week_changed"};
    return {ok:true as const,proposalId:proposal.id,revision:proposal.revision,
      wageRates:wageRates(slice.value.employees)};
  }catch{return {ok:false as const,error:"unavailable"};}
}

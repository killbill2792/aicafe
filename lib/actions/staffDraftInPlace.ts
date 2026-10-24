"use server";
import {z} from "zod";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
import {assertCafeAiAccess} from "@/lib/access/access.server";
import {readSchedulingDraftInputs} from "@/lib/data/schedulingDraftInputs.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {draftWeek,businessLocalDate} from "@/lib/calc/scheduling/draftWeek";
import {staffProposalInputs} from "@/lib/ai/agent/tools/staffProposals";
import {staffCapabilityId} from "@/lib/ai/supervisor/loop/staffProposals.server";
import {proposeLoop} from "@/lib/ai/supervisor/loop/engine";
import {supervisorLoopRegistry} from "@/lib/ai/supervisor/loop/priceExperiment.server";
import {SupabaseLoopRepository} from "@/lib/ai/supervisor/loop/supabase.server";

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
    const result=draftWeek(slice.value,parsed.data.week);
    if(result.missing.length)return {ok:false as const,error:"missing"};
    // draftWeek intentionally omits staff IDs. Map names only if provably unique;
    // guessing which staff member to schedule could corrupt an owner's roster.
    const ids=new Map<string,string>();
    for(const person of slice.value.employees){
      if(ids.has(person.display_name))return {ok:false as const,error:"names"};
      ids.set(person.display_name,person.id);
    }
    const shifts=result.days.flatMap(day=>day.shifts.map(shift=>({
      employee_id:ids.get(shift.name)??"",date:day.date,start:shift.start,
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
    const proposal=await proposeLoop({...scope,threadId:parsed.data.threadId,
      locale:parsed.data.locale},supervisorLoopRegistry,new SupabaseLoopRepository(),
      staffCapabilityId("propose_schedule"),proposed.data,parsed.data.requestKey);
    return {ok:true as const,proposalId:proposal.id,revision:proposal.revision,
      shifts:proposed.data.shifts,
      costIsPartial:result.totals.costIsPartial,estimated:result.estimated.length>0};
  }catch{return {ok:false as const,error:"unavailable"};}
}

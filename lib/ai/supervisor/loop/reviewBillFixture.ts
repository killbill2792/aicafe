import {z} from "zod";
import {registerLoopCapability} from "./engine";
/** Deliberately unrelated specialist: proves no platform switch/route change
 * is required to register a reviewed-recurring-bill effect contract. */
export const billReviewFixtureCapability=registerLoopCapability({
 dependencyScope:(effect)=>({version:1,effect}),
  id:"leo.recurring_bill_review.v1",version:1,
  inputSchema:z.strictObject({billId:z.string().min(1),vendor:z.string().min(1)}),
  effectSchema:z.strictObject({billId:z.string().min(1),reviewed:z.literal(true)}),
  simulate:async(_scope,input)=>({effect:{billId:input.billId,reviewed:true},
    baseline:{vendor:input.vendor},monitorSpec:{durationDays:1,metricScope:input.billId}}),
  commit:async()=>({status:"requires_manual_action",instructionKey:"mark_bill_reviewed",
    instructions:{step:"Confirm review in the external bill tool"}}),
  monitor:async(_scope,_effect,date)=>({businessDate:date,
    observation:{reviewed:true},source:"owner_confirmation"}),
  report:async(_scope,_effect,samples)=>({status:samples.length?"complete":"insufficient_evidence",
    result:{reviewed:samples.length>0},recommendation:samples.length?"keep":"adjust",
    source:"owner_confirmation"}),
});

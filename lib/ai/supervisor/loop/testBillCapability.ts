import {z} from "zod";
import {loopPropose,loopApprove,loopCommit,type Registration} from "./registry";
/** Genericity proof registration: entirely domain-owned, no billing integration write. */
const reference=z.strictObject({reference:z.string().min(1)});
export function billReviewRegistrations():Registration[]{
  return [
    loopPropose({id:"bills.review.propose.v1",owner:"bills",version:1,mode:"propose",
      description:"Request a human review of an existing bill",inputSchema:z.strictObject({bill:z.string().min(1)}),
      outputSchema:reference,async propose(input,store){
        return reference.parse(await store.draft(input));
      }}),
    loopApprove({id:"bills.review.approve.v1",owner:"bills",version:1,mode:"approve",
      description:"Approve a bill review request",inputSchema:reference,outputSchema:reference,
      async approve(input,store){return reference.parse(await store.approve(input));}}),
    loopCommit({id:"bills.review.commit.v1",owner:"bills",version:1,mode:"commit",
      description:"Hand the bill review to the human reviewer",
      inputSchema:reference,outputSchema:z.strictObject({
        status:z.literal("requires_manual_action"),reference:z.string()}),
      async commit(input,store){return z.strictObject({status:z.literal("requires_manual_action"),
        reference:z.string()}).parse(await store.commit(input));}}),
  ];
}

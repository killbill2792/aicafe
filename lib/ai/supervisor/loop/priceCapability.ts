import {z} from "zod";
import {loopRead,loopPropose,loopApprove,loopCommit,type Registration} from "./registry";
import {approvalReference,effectPayload,monitorSpec} from "./transition";
const ok=z.strictObject({status:z.enum(["verified","estimated","requires_manual_action"]),
  reference:z.string()});
const reference=z.strictObject({reference:z.string().min(1).max(160)});
/** The domain owns schemas/handlers; platform dispatcher has no latte/Toast branches. */
export function priceExperimentRegistrations():Registration[]{
  return [
    loopRead({id:"alex.price_experiment.simulate.v1",version:1,mode:"simulate",owner:"alex",
      description:"Simulate a drink price adjustment using observed quantities and ingredient-only costs",
      inputSchema:z.strictObject({productId:z.uuid(),deltaCents:z.number().int().min(-10000).max(10000)}),
      outputSchema:reference,async read(input){return {reference:input.productId};}}),
    loopPropose({id:"alex.price_experiment.propose.v1",version:1,mode:"propose",owner:"alex",
      description:"Persist an inert owner-requested drink price experiment with immutable price payload",
      inputSchema:z.strictObject({effect:effectPayload,monitor:monitorSpec}),
      outputSchema:reference,async propose(input,store){
        const created=await store.draft(input);
        return reference.parse(created);
      }}),
    loopApprove({id:"alex.price_experiment.approve.v1",version:1,mode:"approve",owner:"alex",
      description:"Approve a version-bound proposal without applying any POS update",
      inputSchema:approvalReference,outputSchema:reference,async approve(input,store){
        return reference.parse(await store.approve(input));
      }}),
    loopCommit({id:"alex.price_experiment.commit.v1",version:1,mode:"commit",owner:"alex",
      description:"Consume approved authority; manual integration handoff only, no POS write",
      inputSchema:approvalReference,outputSchema:ok,async commit(input,store){
        const response=await store.commit(input);return ok.parse(response);
      }}),
  ];
}

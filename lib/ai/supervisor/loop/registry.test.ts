import {describe,it,expect} from "vitest";
import {z} from "zod";
import {createLoopRegistry,loopRead,loopPropose,loopApprove,loopCommit} from "./registry";
import {priceExperimentRegistrations} from "./priceCapability";
// This dummy domain is deliberately separate: no platform/dispatcher change.
import {billReviewRegistrations} from "./testBillCapability";
describe("six-mode platform",()=>{
  it("registers a second domain without a router special case",async()=>{
    const registry=createLoopRegistry([...priceExperimentRegistrations(),...billReviewRegistrations()]);
    expect(registry.discover().some(x=>x.owner==="bills")).toBe(true);
    const draft=await registry.dispatch("bills.review.propose.v1",{bill:"electric"},{
      draft:async()=>({reference:"bill-inert"})});
    expect(draft).toEqual({reference:"bill-inert"});
    expect(await registry.dispatch("bills.review.approve.v1",{reference:"bill-inert"},{
      approve:async()=>({reference:"approved"})})).toEqual({reference:"approved"});
    expect(await registry.dispatch("bills.review.commit.v1",{reference:"approved"},{
      commit:async()=>({status:"requires_manual_action",reference:"bill-inert"})}))
      .toEqual({status:"requires_manual_action",reference:"bill-inert"});
  });
  it("does not let simulate create a proposal or accept a write facade",async()=>{
    const registry=createLoopRegistry(priceExperimentRegistrations());
    expect(await registry.dispatch("alex.price_experiment.simulate.v1",
      {productId:"f0dc6274-e179-4f1d-89fd-a06ed41704fe",deltaCents:10}))
      .toEqual({reference:"f0dc6274-e179-4f1d-89fd-a06ed41704fe"});
    await expect(registry.dispatch("alex.price_experiment.propose.v1",{effect:{},monitor:{}}))
      .rejects.toThrow();
    expect(()=>createLoopRegistry([{id:"bad",version:1,owner:"evil",
      description:"",mode:"read",inputSchema:z.any(),outputSchema:z.any(),read:async()=>null,
      commit:async()=>null} as never])).toThrow("mode_handler_boundary");
  });
});

import {describe,it,expect,vi,beforeEach} from "vitest";
const state=vi.hoisted(()=>({
  businessId:"11111111-1111-4111-8111-111111111111",currency:"USD" as string|null,
  menu:[{id:"22222222-2222-4222-8222-222222222222",name:"Latte",priceCents:450,active:true}],
  current:450 as number|null,saves:0,saveArgs:null as unknown,
  saveAttempts:0,changeBeforeSave:null as number|null,catalogSource:"manual" as string,
  claimToast:false,claimExists:true,
}));
vi.mock("@/lib/menu/priceHistory",()=>({setCanonicalMenuPrice:async(_client:unknown,input:unknown)=>{
  const args=input as {expectedOldPriceCents:number};
  state.saveAttempts++;
  if(state.changeBeforeSave!==null)state.current=state.changeBeforeSave;
  if(state.current!==args.expectedOldPriceCents)return false;
  state.saves++;state.saveArgs=input;return true;
}}));
vi.mock("next/cache",()=>({revalidatePath:()=>{}}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>state.businessId}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
 auth:{getUser:async()=>({data:{user:{id:"33333333-3333-4333-8333-333333333333"}}})},
 from:(table:string)=>{
   const filters={eq:()=>filters,maybeSingle:async()=>({data:table==="memberships"?{role:"owner"}:
     table==="supervisor_effect_attempts"?(state.claimExists?{
       attempt_key:"77777777-7777-4777-8777-777777777777",
       receipt_ref:state.claimToast?"inert-toast-claim:77777777-7777-4777-8777-777777777777":null}:null):
     table==="menu_items"?(state.menu[0].active?{id:state.menu[0].id,name:state.menu[0].name,
       price_cents:state.menu[0].priceCents,is_active:state.menu[0].active,
       catalog_source:state.catalogSource}:null):
     {currency:state.currency,is_demo:false},error:null})};
   return {select:()=>filters};
 },
})}));
vi.mock("@/lib/data/proposalPrices.server",()=>({ownerMenuPrice:async()=>state.current}));
vi.mock("./sales.server",()=>({readPriceExperimentSalesDays:async()=>[]}));
import {menuPriceChangeCapability,StaleProposalError,menuPriceChangeCapabilityId} from "./menuPriceChange.server";
import {supervisorLoopRegistry} from "./priceExperiment.server";
const scope={businessId:state.businessId,ownerUserId:"33333333-3333-4333-8333-333333333333",
  threadId:"44444444-4444-4444-8444-444444444444",locale:"en" as const};
const input={productId:"22222222-2222-4222-8222-222222222222",newPriceCents:500};
const proposalId="66666666-6666-4666-8666-666666666666";
beforeEach(()=>{state.currency="USD";state.menu=[{...state.menu[0],active:true,priceCents:450}];
  state.current=450;state.saves=0;state.saveArgs=null;
  state.saveAttempts=0;state.changeBeforeSave=null;state.catalogSource="manual";
  state.claimToast=false;state.claimExists=true;});
describe("approved menu price capability",()=>{
  it("drafts a $20 Toast item increase of 10 cents from one scoped menu row",async()=>{
    state.menu=[{...state.menu[0],priceCents:2000}];
    const simulation=await menuPriceChangeCapability.simulate(scope,{...input,newPriceCents:2010});
    expect(simulation.effect).toMatchObject({oldPriceCents:2000,newPriceCents:2010,productName:"Latte"});
  });
  it("drafts a price change in a non-USD café's own currency",async()=>{
    state.currency="EUR";
    const simulation=await menuPriceChangeCapability.simulate(scope,input);
    expect(simulation.effect).toMatchObject({oldPriceCents:450,newPriceCents:500,currency:"EUR"});
  });
  it("asks for the café currency instead of guessing one",async()=>{
    state.currency=null;
    await expect(menuPriceChangeCapability.simulate(scope,input)).rejects.toMatchObject({code:"validation"});
  });
  it("is registered in the cron-shared registry",()=>{
    expect(supervisorLoopRegistry.get(menuPriceChangeCapabilityId)).toBe(menuPriceChangeCapability);
  });
  it("rejects foreign business",async()=>{
    await expect(menuPriceChangeCapability.simulate({...scope,businessId:crypto.randomUUID()},input)).rejects.toThrow();
  });
  it("rejects inactive and unchanged items",async()=>{
    state.menu[0].active=false;
    await expect(menuPriceChangeCapability.simulate(scope,input)).rejects.toThrow();
    state.menu[0].active=true;
    await expect(menuPriceChangeCapability.simulate(scope,{...input,newPriceCents:450})).rejects.toThrow();
  });
  it("rejects a stale approval before calling canonical save",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    state.current=475;
    await expect(menuPriceChangeCapability.commit(scope,effect,proposalId)).rejects.toBeInstanceOf(StaleProposalError);
    expect(state.saves).toBe(0);
    expect(state.saveAttempts).toBe(0);
  });
  it("blocks a concurrent Menu/POS price change after pre-read, before save",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    // The fake DB changes only when the conditional RPC is called.
    state.changeBeforeSave=475;
    await expect(menuPriceChangeCapability.commit(scope,effect,proposalId))
      .rejects.toBeInstanceOf(StaleProposalError);
    expect(state.saveAttempts).toBe(1);
    expect(state.saves).toBe(0);
    expect(state.current).toBe(475);
  });
  it("requires a proposal identity before any canonical write",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    await expect(menuPriceChangeCapability.commit(scope,effect)).rejects.toThrow("proposal_id_required");
    expect(state.saves).toBe(0);
    expect(state.saveAttempts).toBe(0);
  });
  it("never writes a Toast-connected published item from a local owner-approved price proposal",async()=>{
    state.catalogSource="toast";state.claimToast=true;
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    expect(await menuPriceChangeCapability.commit(scope,effect,proposalId)).toEqual({
      status:"requires_manual_action",instructionKey:"update_price_in_pos",
      instructions:{productName:"Latte",toPriceCents:"500"}});
    expect(state.saves).toBe(0);
    expect(state.saveAttempts).toBe(0);
    expect(state.current).toBe(450);
  });
  it("keeps a claim-time Toast handoff inert after the catalog switches to manual",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    state.claimToast=true;state.catalogSource="manual";
    expect(await menuPriceChangeCapability.commit(scope,effect,proposalId))
      .toMatchObject({status:"requires_manual_action"});
    expect(state.saveAttempts).toBe(0);
  });
  it("fails closed if Toast takes ownership after a local claim",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    state.catalogSource="toast";
    await expect(menuPriceChangeCapability.commit(scope,effect,proposalId))
      .rejects.toMatchObject({code:"write_failed"});
    expect(state.saveAttempts).toBe(0);
  });
  it("never calls the price CAS without its authoritative effect claim",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    state.claimExists=false;
    await expect(menuPriceChangeCapability.commit(scope,effect,proposalId))
      .rejects.toMatchObject({code:"write_failed"});
    expect(state.saveAttempts).toBe(0);
  });
  it("writes once through owner_manual price history",async()=>{
    const {effect,baseline,monitorSpec}=await menuPriceChangeCapability.simulate(scope,input);
    expect(baseline).toEqual({source:"menu_items",status:"actual"});
    expect(monitorSpec).toEqual({durationDays:7,metricScope:input.productId});
    expect(await menuPriceChangeCapability.commit(scope,effect,proposalId)).toEqual({
      status:"verified",evidenceSource:"menu_price_history"});
    expect(state.saves).toBe(1);
    expect(state.saveArgs).toMatchObject({businessId:scope.businessId,
      menuItemId:input.productId,priceCents:500,expectedOldPriceCents:450,sourceType:"owner_manual",
      sourceProvider:"Alex (owner approved; proposal "+proposalId+")"});
  });
  it("reports only observed factual, non-causal covered sales",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    const r=await menuPriceChangeCapability.report(scope,effect,[],true);
    expect(r.status).toBe("insufficient_evidence");
    expect(r.result.nonCausal).toBe(true);
    expect(r.result.observedRevenueCents).toBe(null);
  });
});

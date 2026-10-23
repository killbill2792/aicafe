import {describe,it,expect,vi,beforeEach} from "vitest";
const state=vi.hoisted(()=>({
  businessId:"11111111-1111-4111-8111-111111111111",currency:"USD",
  menu:[{id:"22222222-2222-4222-8222-222222222222",name:"Latte",priceCents:450,active:true}],
  current:450 as number|null,saves:0,saveArgs:null as unknown,
  saveAttempts:0,changeBeforeSave:null as number|null,
}));
vi.mock("@/lib/metrics/p1Readers.server",()=>({authorizedOwnerP1:async()=>({
  identity:{businessId:state.businessId,currency:state.currency}
})}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:async()=>state.menu}));
vi.mock("@/lib/menu/priceHistory",()=>({setCanonicalMenuPrice:async(_client:unknown,input:unknown)=>{
  const args=input as {expectedOldPriceCents:number};
  state.saveAttempts++;
  if(state.changeBeforeSave!==null)state.current=state.changeBeforeSave;
  if(state.current!==args.expectedOldPriceCents)return false;
  state.saves++;state.saveArgs=input;return true;
}}));
vi.mock("next/cache",()=>({revalidatePath:()=>{}}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({})}));
vi.mock("@/lib/data/proposalPrices.server",()=>({ownerMenuPrice:async()=>state.current}));
vi.mock("./sales.server",()=>({readPriceExperimentSalesDays:async()=>[]}));
import {menuPriceChangeCapability,StaleProposalError,menuPriceChangeCapabilityId} from "./menuPriceChange.server";
import {supervisorLoopRegistry} from "./priceExperiment.server";
const scope={businessId:state.businessId,ownerUserId:"33333333-3333-4333-8333-333333333333",
  threadId:"44444444-4444-4444-8444-444444444444",locale:"en" as const};
const input={productId:"22222222-2222-4222-8222-222222222222",newPriceCents:500};
beforeEach(()=>{state.currency="USD";state.menu=[{...state.menu[0],active:true,priceCents:450}];
  state.current=450;state.saves=0;state.saveArgs=null;
  state.saveAttempts=0;state.changeBeforeSave=null;});
describe("approved menu price capability",()=>{
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
    await expect(menuPriceChangeCapability.commit(scope,effect)).rejects.toBeInstanceOf(StaleProposalError);
    expect(state.saves).toBe(0);
    expect(state.saveAttempts).toBe(0);
  });
  it("blocks a concurrent Menu/POS price change after pre-read, before save",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    // The fake DB changes only when the conditional RPC is called.
    state.changeBeforeSave=475;
    await expect(menuPriceChangeCapability.commit(scope,effect))
      .rejects.toBeInstanceOf(StaleProposalError);
    expect(state.saveAttempts).toBe(1);
    expect(state.saves).toBe(0);
    expect(state.current).toBe(475);
  });
  it("writes once through owner_manual price history",async()=>{
    const {effect,baseline,monitorSpec}=await menuPriceChangeCapability.simulate(scope,input);
    expect(baseline).toEqual({source:"menu_items",status:"actual"});
    expect(monitorSpec).toEqual({durationDays:7,metricScope:input.productId});
    expect(await menuPriceChangeCapability.commit(scope,effect)).toEqual({
      status:"verified",evidenceSource:"menu_price_history"});
    expect(state.saves).toBe(1);
    expect(state.saveArgs).toMatchObject({businessId:scope.businessId,
      menuItemId:input.productId,priceCents:500,expectedOldPriceCents:450,sourceType:"owner_manual",
      sourceProvider:"Alex (owner approved)"});
  });
  it("reports only observed factual, non-causal covered sales",async()=>{
    const {effect}=await menuPriceChangeCapability.simulate(scope,input);
    const r=await menuPriceChangeCapability.report(scope,effect,[],true);
    expect(r.status).toBe("insufficient_evidence");
    expect(r.result.nonCausal).toBe(true);
    expect(r.result.observedRevenueCents).toBe(null);
  });
});

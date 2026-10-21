import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({snapshot:null as unknown as Record<string,unknown>,writes:0}));
vi.mock("@/lib/supabase/server",()=>({
  createServerSupabaseClient:vi.fn(async()=>({
    from:()=>({
      select(){return this;},
      eq(){return this;},
      limit:async()=>({
        data:(state.snapshot as {sources:{menu:Array<{id:string;name:string;price_cents:number;is_active:boolean}>}})
          .sources.menu.slice(0,1).map(m=>({...m,base_name:m.name,size_label:null})),
        error:null,
      }),
    }),
  })),
}));
vi.mock("@/lib/metrics/p1Readers.server",()=>({
  authorizedOwnerP1:vi.fn(async()=>({identity:{
    businessId:"11111111-1111-4111-8111-111111111111",
    asOf:"2026-10-20",currency:"USD",timezone:"America/Los_Angeles"}})),
}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server",()=>({
  readAuthorizedAtomicP1SourceSnapshot:vi.fn(async()=>({status:"available",snapshot:state.snapshot})),
}));
vi.mock("@/lib/actions/menuItems",()=>({
  addManualIngredientPrice:vi.fn(async(input:{ingredientId:string;packageCostCents:number;packageQuantity:number})=>{
    state.writes++;
    const snapshot=state.snapshot as {
      revision:string;sources:{ingredientPrices:Array<Record<string,unknown>>};
    };
    snapshot.sources.ingredientPrices.push({
      id:"88888888-8888-4888-8888-888888888888",
      ingredient_id:input.ingredientId,effective_from:"2026-10-20",
      cost_per_base_unit_micros:Math.round(input.packageCostCents/input.packageQuantity*1000000),
      source:"manual",
    });
    snapshot.revision=String(Number(snapshot.revision)+1);
    return {ok:true};
  }),
}));
vi.mock("./alexCapabilities.server",async()=>{
  const {reviewFromAtomicSnapshot,simulateFromAtomicSnapshot}=await import("./alexPricing");
  return {buildAlexPricingRegistrations:()=>[{
    read:async(_scope:unknown,input:unknown)=>reviewFromAtomicSnapshot(
      state.snapshot as never,input as never,"2026-10-20"),
  },{simulate:async(_scope:unknown,input:unknown)=>simulateFromAtomicSnapshot(
    state.snapshot as never,input as never,"2026-10-20")}]};
});
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
import {createP2Registry} from "@/lib/ai/supervisor/p2/registry";
import {buildAlexP3Registrations,ALEX_P3_REVIEW_ID} from "./alexP3Capabilities.server";
import {buildOwnerQuestionReply,confirmOwnerQuestion} from "@/lib/ai/supervisor/ownerInput/response";
import {ownerInputWrites} from "@/lib/ai/supervisor/ownerInput/writeRegistry.server";
import {validateGroundedReply} from "@/lib/ai/conversations/replyValidation";
const cafe="11111111-1111-4111-8111-111111111111";
const drink="22222222-2222-4222-8222-222222222222";
const milk="33333333-3333-4333-8333-333333333333";
const scope={role:"owner" as const,businessId:cafe,shadowEnabled:true,
  identity:{businessId:cafe,asOf:"2026-10-20",timezone:"America/Los_Angeles",currency:"USD"},
  tools:{} as BusinessScopedCafeTools};
beforeEach(()=>{
  state.writes=0;state.snapshot={
    contract:"p1.authoritative_snapshot.v1",businessId:cafe,revision:"1",
    timezone:"America/Los_Angeles",currency:"USD",coverage:"not_proven_by_revision",
    payroll:{rate:0.1,status:"estimated",source:"configuration"},
    sources:{
      menu:[{id:drink,name:"Oat Latte",price_cents:700,is_active:true,category:"drink"}],
      ingredients:[{id:milk,name:"Oat milk",base_unit:"ml"}],
      ingredientPrices:[],recipes:[{menu_item_id:drink,ingredient_id:milk,quantity:250}],
      ownerTotalCosts:[],employees:[],dailyRollups:[],expenses:[],recurringCosts:[],imports:[],
    },
    truncated:{menu:false,ingredients:false,ingredientPrices:false,recipes:false,
      ownerTotalCosts:false,employees:false,dailyRollups:false,expenses:false,
      recurringCosts:false,imports:false},
  };
});
describe("real Alex reader -> confirmed owner input -> original reader again",()=>{
  it("prompts for one source-proven missing ingredient cost, uses the existing Menu action, then recalculates",async()=>{
    const [registration]=buildAlexP3Registrations();
    const registry=createP2Registry([registration]);
    const request={purpose:"pricing_review",product:{productId:drink}};
    const missing=await registry.invoke(scope,ALEX_P3_REVIEW_ID,request);
    expect(missing).toMatchObject({status:"requires_owner_input",value:null,
      ownerInput:{fieldId:"ingredient.package_cost_and_quantity",
        writeCapabilityId:"menu.ingredient_price.manual.v1"}});
    const need=(missing as {ownerInput:Parameters<typeof buildOwnerQuestionReply>[0]["request"]}).ownerInput;
    const first=validateGroundedReply(buildOwnerQuestionReply({businessId:cafe,
      originalText:"What does my oat latte cost to make?",readCapabilityId:ALEX_P3_REVIEW_ID,
      readInput:request,request:need}));
    expect(first.status).toBe("requires_owner_input");
    const prepared=ownerInputWrites.prepare(need,"4.50 / 946");
    expect(prepared?.summary.en).toContain("4.50 USD / 946 ml");
    const confirmation=validateGroundedReply(confirmOwnerQuestion(first.ownerInput!,"4.50 / 946",prepared!.summary));
    expect(confirmation.ownerInput?.stage).toBe("confirm");
    expect(state.writes).toBe(0);
    expect(await ownerInputWrites.apply({businessId:cafe,ownerUserId:"owner"},need,"4.50 / 946"))
      .toEqual({ok:true});
    expect(state.writes).toBe(1);
    const refreshed=await registry.invoke(scope,ALEX_P3_REVIEW_ID,request);
    expect(refreshed).toMatchObject({status:"partial",
      value:[{name:"Oat Latte",currentPriceCents:700,
        reviewIngredientCostCents:expect.any(Number)}]});
    expect(Number((refreshed as {value:Array<{reviewIngredientCostCents:number}>}).value[0]
      .reviewIngredientCostCents)).toBeGreaterThan(0);
  });
  it("offers the same missing-owner-input contract in Alex what-if and recalculates after a confirmed write",async()=>{
    const [review,whatIf]=buildAlexP3Registrations();
    const registry=createP2Registry([review,whatIf]);
    const input={purpose:"pricing_simulate",product:{productId:drink},changes:[],targetCostRatioBps:3000};
    const missing=await registry.invoke(scope,whatIf.id,input);
    expect(missing).toMatchObject({status:"requires_owner_input",ownerInput:{
      writeCapabilityId:"menu.ingredient_price.manual.v1"}});
    const typed=missing as {ownerInput:Parameters<typeof buildOwnerQuestionReply>[0]["request"]};
    expect(await ownerInputWrites.apply({businessId:cafe,ownerUserId:"owner"},typed.ownerInput,"4.50 / 946"))
      .toEqual({ok:true});
    const after=await registry.invoke(scope,whatIf.id,input);
    expect(after).toMatchObject({status:"partial",value:[{
      name:"Oat Latte",targetPriceCents:expect.any(Number),
    }]});
    expect(state.writes).toBe(1);
  });

  it("never guesses when two matching active variants exist",async()=>{
    const snap=state.snapshot as {sources:{menu:Array<Record<string,unknown>>}};
    snap.sources.menu.push({id:"44444444-4444-4444-8444-444444444444",
      name:"Oat Latte",price_cents:750,is_active:true,category:"drink"});
    const registry=createP2Registry([buildAlexP3Registrations()[0]]);
    const result=await registry.invoke(scope,ALEX_P3_REVIEW_ID,{purpose:"pricing_review",
      product:{exactName:"Oat Latte"}});
    expect((result as {status:string}).status).not.toBe("requires_owner_input");
    expect(state.writes).toBe(0);
  });
});

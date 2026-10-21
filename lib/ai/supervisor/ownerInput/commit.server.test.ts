import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({rows:new Map<string,Record<string,unknown>>(),
  applied:0,verified:true}));
vi.mock("@/lib/metrics/p1Readers.server",()=>({
  authorizedOwnerP1:vi.fn(async()=>({identity:{businessId:
    "11111111-1111-4111-8111-111111111111",currency:"USD"}})),
}));
vi.mock("./writeRegistry.server",()=>({
  ownerInputWrites:{prepare:vi.fn(()=>({summary:{en:"cost",es:"costo",ar:"التكلفة"}})),
    apply:vi.fn(async()=>{
      state.applied++;
      return {ok:true};
    }),verify:vi.fn(async()=>state.verified)},
}));
vi.mock("@/lib/supabase/admin",()=>({
  createAdminSupabaseClient:()=>({from:()=>({
    insert:async(row:Record<string,unknown>)=>{
      const key=String(row.question_id);
      if(state.rows.has(key))return {error:{code:"23505"}};
      state.rows.set(key,{...row});return {error:null};
    },
    select:()=>({
      eq:(..._args:unknown[])=>({
        maybeSingle:async()=>({error:null,
          data:[...state.rows.values()][0]??null}),
      }),
    }),
    update:(patch:Record<string,unknown>)=>({
      eq:()=>({eq:()=>({eq:()=>({eq:async()=>{
        for(const record of state.rows.values())Object.assign(record,patch);
        return {error:null};
      }})})}),
    }),
  })}),
}));
import {commitConfirmedOwnerInput} from "./commit.server";
import type {PendingOwnerInput} from "./contracts";
const businessId="11111111-1111-4111-8111-111111111111";
const questionId="22222222-2222-4222-8222-222222222222";
const scope={businessId,ownerUserId:"33333333-3333-4333-8333-333333333333"};
const pending:PendingOwnerInput={
  version:1,questionId,stage:"confirm",businessId,
  originalText:"What is the price?",readCapabilityId:"p3.alex.pricing.review.v1",
  readInputJson:"{}",
  request:{fieldId:"ingredient.package_cost_and_quantity",
    writeCapabilityId:"menu.ingredient_price.manual.v1",writeContext:{ingredientId:"44444444-4444-4444-8444-444444444444"},
    question:{en:"Cost?",es:"¿Precio?",ar:"السعر؟"},
    input:{kind:"free_text",hint:{en:"4.50/946",es:"4.50/946",ar:"4.50/946"}}},
  answer:"4.50/946",summary:{en:"Save?",es:"¿Guardar?",ar:"حفظ؟"},
};
beforeEach(()=>{state.rows.clear();state.applied=0;state.verified=true;});
describe("durable owner confirmation claim",()=>{
  it("allows exactly one write even with different request keys replaying the same card",async()=>{
    const first=await commitConfirmedOwnerInput(scope,pending);
    expect(first).toEqual({ok:true,replayed:false});
    const second=await commitConfirmedOwnerInput(scope,pending);
    expect(second).toEqual({ok:true,replayed:true});
    expect(state.applied).toBe(1);
  });
  it("never retries an uncertain first write when authoritative recheck fails",async()=>{
    await commitConfirmedOwnerInput(scope,pending);
    state.verified=false;
    const second=await commitConfirmedOwnerInput(scope,pending);
    expect(second).toMatchObject({ok:false,reason:"prior_attempt_unverified"});
    expect(state.applied).toBe(1);
  });
  it("rejects cross-cafe and unconfirmed inputs without writing",async()=>{
    expect((await commitConfirmedOwnerInput({...scope,businessId:
      "55555555-5555-4555-8555-555555555555"},pending)).ok).toBe(false);
    expect((await commitConfirmedOwnerInput(scope,{...pending,stage:"answer"})).ok).toBe(false);
    expect(state.applied).toBe(0);
  });
});

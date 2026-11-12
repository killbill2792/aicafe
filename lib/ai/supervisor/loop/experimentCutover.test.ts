import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {LoopProposal,LoopRepository} from "./engine";
const testReader=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./toastPriceEvidence.server",()=>({
 readVerifiedToastPriceEvidence:(...args:unknown[])=>testReader.read(...args),
}));
import {resolveExperimentCutoverMode,readVerifiedActivationAnchor,runVerifiedToastPriceTick,trialSourceInterruption} from "./experimentCutover.server";

describe("Task 8a experiment single-writer cutover",()=>{
 it("defaults to legacy when release evidence is absent",()=>{
  expect(resolveExperimentCutoverMode({requested:"new",parityProven:false,
   rollbackProven:true,releaseApproved:true})).toBe("legacy");
  expect(resolveExperimentCutoverMode({requested:"new",parityProven:true,
   rollbackProven:false,releaseApproved:true})).toBe("legacy");
  expect(resolveExperimentCutoverMode({requested:"new",parityProven:true,
   rollbackProven:true,releaseApproved:false})).toBe("legacy");
 });
 it("runs shadow only as read-only and permits new only with all gates",()=>{
  expect(resolveExperimentCutoverMode({requested:"shadow",parityProven:false,
   rollbackProven:false,releaseApproved:false})).toBe("shadow");
  expect(resolveExperimentCutoverMode({requested:"new",parityProven:true,
   rollbackProven:true,releaseApproved:true})).toBe("new");
 });
 it("rejects unknown or missing persisted modes",()=>{
  expect(resolveExperimentCutoverMode({requested:"unknown",parityProven:true,
   rollbackProven:true,releaseApproved:true})).toBe("legacy");
  expect(resolveExperimentCutoverMode({requested:null,parityProven:true,
   rollbackProven:true,releaseApproved:true})).toBe("legacy");
 });
});

describe("durable Task 8a source-verified activation receipts",()=>{
 const approved={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  menuItemId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  oldPriceCents:500,newPriceCents:550,approvedAt:"2026-11-11T18:00:00Z"};
 const evidence={businessId:approved.businessId,
  menuItemId:approved.menuItemId,oldPriceCents:500,newPriceCents:550,
  historyId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  restaurantGuid:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  posItemId:"toast:dddddddd-dddd-4ddd-8ddd-dddddddddddd:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  publicationVersion:"2026-11-11T18:10:00Z",
  observedAt:"2026-11-11T18:11:00Z",
  startBasis:"first_verified_observation" as const};
 it("reuses the first verified event even after an unrelated later menu version",()=>{
  expect(readVerifiedActivationAnchor(evidence,"2026-11-11T18:11:00Z",approved))
   .toMatchObject({status:"verified",historyId:evidence.historyId,
    startAt:"2026-11-11T18:11:00Z",publicationVersion:evidence.publicationVersion});
 });
 it("rejects a mismatched café, product, old/new target or pre-approval instant",()=>{
  expect(readVerifiedActivationAnchor(evidence,"2026-11-11T18:11:00Z",
   {...approved,businessId:"ffffffff-ffff-4fff-8fff-ffffffffffff"})).toBeNull();
  expect(readVerifiedActivationAnchor({...evidence,oldPriceCents:400},
   "2026-11-11T18:11:00Z",approved)).toBeNull();
  expect(readVerifiedActivationAnchor(evidence,"2026-11-11T17:00:00Z",approved)).toBeNull();
 });
});

describe("Task 8a price-change continuity truth",()=>{
 it("keeps the first source activation through unrelated version changes, not a source revert",()=>{
  const receipt={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
   menuItemId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
   oldPriceCents:500,newPriceCents:550,approvedAt:"2026-11-11T18:00:00Z"};
  const initial={businessId:receipt.businessId,menuItemId:receipt.menuItemId,
   oldPriceCents:500,newPriceCents:550,
   historyId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
   restaurantGuid:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
   posItemId:"toast:dddddddd-dddd-4ddd-8ddd-dddddddddddd:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
   publicationVersion:"menu-v1",observedAt:"2026-11-11T18:10:00Z",
   startBasis:"first_verified_observation"};
  const anchored=readVerifiedActivationAnchor(initial,"2026-11-11T18:10:00Z",receipt);
  expect(anchored?.publicationVersion).toBe("menu-v1");
  // Same price in menu-v2 does not modify the source receipt in the anchor.
  expect(readVerifiedActivationAnchor({...initial,interruptedAt:"2026-11-12T20:00:00Z"},
   "2026-11-11T18:10:00Z",receipt)?.historyId).toBe(initial.historyId);
 });
});

describe("persisted verified price activation survives later Menus version",()=>{
 it("continues the elapsed monitor from its first receipt without re-reading current version history",async()=>{
  testReader.read.mockReset();
  const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const menuItemId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const restaurantGuid="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const posItemId="toast:"+restaurantGuid+":eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const now="2026-11-12T19:00:00Z";
  const firstAt="2026-11-12T18:30:00Z";
  const anchor={source_reference:{businessId,menuItemId,restaurantGuid,posItemId,
   historyId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
   oldPriceCents:500,newPriceCents:550,
   publicationVersion:"menu-v1",observedAt:firstAt,
   startBasis:"first_verified_observation"},start_at:firstAt};
  // Menu v2 was published without a price change. The original event no
  // longer belongs to the latest publication, but its pinned receipt remains.
  const responses:Record<string,unknown>={
   supervisor_monitor_windows:{data:anchor,error:null},
   menu_items:{data:{catalog_source:"toast",is_active:true,
    pos_item_id:posItemId,price_cents:550,toast_publication_state:"active",
    toast_publication_version:"menu-v2"},error:null},
   menu_price_history:{data:[],error:null},
  };
  function query(response:unknown):unknown{
   return new Proxy({},{
    get:(_target,prop)=>{
     if(prop==="then")return (resolve:(value:unknown)=>void)=>
       Promise.resolve(response).then(resolve);
     return (..._args:unknown[])=>query(response);
    },
   });
  }
  const db={from:(table:string)=>({
   select:()=>query(responses[table]),
  })} as unknown as SupabaseClient;
  const row={id:"ffffffff-ffff-4fff-8fff-ffffffffffff",
   business_id:businessId,owner_user_id:"99999999-9999-4999-8999-999999999999",
   thread_id:"88888888-8888-4888-8888-888888888888",
   capability_id:"alex.drink_price_experiment.v1",status:"manual_confirmed",
   revision:3,approved_at:"2026-11-11T16:00:00Z",
   canonical_effect_payload:{productId:menuItemId,productName:"Latte",
    oldPriceCents:500,newPriceCents:550,currency:"USD"},
   monitor_spec:{durationDays:7},locale:"en" as const};
  const scope={businessId,ownerUserId:row.owner_user_id,
   threadId:row.thread_id,locale:"en" as const};
  const outcome=await runVerifiedToastPriceTick(db,{} as LoopRepository,row,
   scope,now,"America/Los_Angeles",{} as LoopProposal);
  expect(outcome).toBe("monitoring");
  expect(testReader.read).not.toHaveBeenCalled();
 });
});

describe("Task 8a exact interval and source pricing continuity",()=>{
 const receipt={startAt:"2026-11-11T18:00:00.000Z",
  posItemId:"toast:dddddddd-dddd-4ddd-8ddd-dddddddddddd:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  newPriceCents:550};
 const current={catalog_source:"toast",is_active:true,
  pos_item_id:receipt.posItemId,price_cents:550,
  toast_publication_state:"active",pos_pricing_strategy:"BASE_PRICE",
  toast_publication_observed_at:"2026-11-12T12:00:00Z"};
 const base={receipt,finalEndAt:"2026-11-12T18:00:00.000Z",
  asOf:"2026-11-13T19:00:00Z",current,
  firstPriceChangeAt:null,priorInterruptionAt:null};
 it("ignores verified price reverts strictly after or exactly on the final 24h boundary",()=>{
  for(const boundary of ["2026-11-12T18:00:00Z","2026-11-12T18:01:00Z"]){
   expect(trialSourceInterruption({...base,
    firstPriceChangeAt:boundary,current:{...current,price_cents:500,
     toast_publication_observed_at:boundary}})).toEqual({at:null,reason:null});
  }
 });
 it("interrupts a trial for a source price change before its end, even if later restored",()=>{
  expect(trialSourceInterruption({...base,
   firstPriceChangeAt:"2026-11-12T07:00:00Z"})).toMatchObject({
    at:"2026-11-12T07:00:00.000Z",reason:"verified_price_changed"});
 });
 it("treats contextual pricing as an interruption even when the numeric base stays unchanged",()=>{
  expect(trialSourceInterruption({...base,
   current:{...current,pos_pricing_strategy:"TIME_SPECIFIC_PRICE",
    toast_publication_observed_at:"2026-11-12T10:15:00Z"}})).toMatchObject({
    at:"2026-11-12T10:15:00.000Z",reason:"unverified_gap"});
 });
 it("does not rewrite a complete trial after a later pricing-strategy publication",()=>{
  expect(trialSourceInterruption({...base,
   current:{...current,pos_pricing_strategy:"TIME_SPECIFIC_PRICE",
    toast_publication_observed_at:"2026-11-12T18:05:00Z"}})).toEqual({
     at:null,reason:null});
 });
 it("requires a size-specific strategy for a size-specific receipt",()=>{
  expect(trialSourceInterruption({...base,
   receipt:{...receipt,posItemId:receipt.posItemId+
    ":size:ffffffff-ffff-4fff-8fff-ffffffffffff"},
   current:{...current,pos_item_id:receipt.posItemId+
    ":size:ffffffff-ffff-4fff-8fff-ffffffffffff"}})).toMatchObject({
    reason:"unverified_gap"});
 });
});

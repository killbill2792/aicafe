import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {LoopProposal,LoopRepository} from "./engine";
const testReader=vi.hoisted(()=>({read:vi.fn(),elapsed:vi.fn(),notice:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("./toastPriceEvidence.server",async importOriginal=>({
 ...await importOriginal<typeof import("./toastPriceEvidence.server")>(),
 readVerifiedToastPriceEvidence:(...args:unknown[])=>testReader.read(...args),
}));
vi.mock("./experimentNotices.server",async importOriginal=>({
 ...await importOriginal<typeof import("./experimentNotices.server")>(),
 postToastObservationNotice:(...args:unknown[])=>testReader.notice(...args),
}));
vi.mock("./rollingExperimentSales.server",async importOriginal=>{
 const real=await importOriginal<typeof import("./rollingExperimentSales.server")>();
 return {...real,readElapsedWindowObservations:(...args:unknown[])=>testReader.elapsed(...args)};
});
import {resolveExperimentCutoverMode,readVerifiedActivationAnchor,runVerifiedToastPriceTick,trialSourceInterruption,contextChangeBreaksApprovedPrice,subsequentToastPriceBoundary,priceExposureBoundary,windowHasSourceGap,runToastObservationBatch} from "./experimentCutover.server";

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
    pos_pricing_strategy:"BASE_PRICE",
    toast_publication_observed_at:"2026-11-12T18:45:00Z",
    toast_publication_version:"menu-v2"},error:null},
   menu_price_history:{data:[],error:null},
   supervisor_toast_price_context_changes:{data:[],count:0,error:null},
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

describe("verified new-mode daily delivery",()=>{
 it("delivers stable elapsed-day keys through the existing report writer, not a second cron",async()=>{
  const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const itemId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const restaurant="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const start="2026-11-01T18:00:00Z";
  const now="2026-11-05T19:00:00Z";
  const posItemId="toast:"+restaurant+":eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const anchor={source_reference:{businessId,menuItemId:itemId,
   restaurantGuid:restaurant,posItemId,historyId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
   oldPriceCents:500,newPriceCents:550,publicationVersion:"menu-v1",observedAt:start,
   startBasis:"first_verified_observation"},start_at:start};
  const responses:Record<string,unknown>={
   supervisor_monitor_windows:{data:anchor,error:null},
   menu_items:{data:{catalog_source:"toast",is_active:true,pos_item_id:posItemId,
    price_cents:550,pos_pricing_strategy:"BASE_PRICE",
    toast_publication_state:"active",toast_publication_observed_at:start},error:null},
   menu_price_history:{data:[],error:null},
   supervisor_toast_price_context_changes:{data:[],count:0,error:null},
  };
  const query=(response:unknown):unknown=>new Proxy({},{
   get:(_target,prop)=>prop==="then"?
    (resolve:(value:unknown)=>void)=>Promise.resolve(response).then(resolve):
    (..._args:unknown[])=>query(response),
  });
  const db={from:(table:string)=>({
   select:()=>query(responses[table]),upsert:()=>Promise.resolve({error:null}),
  })} as unknown as SupabaseClient;
  const saveReport=vi.fn().mockResolvedValue(undefined);
  const repo={saveReport} as unknown as LoopRepository;
  const row={id:"ffffffff-ffff-4fff-8fff-ffffffffffff",
   business_id:businessId,owner_user_id:"99999999-9999-4999-8999-999999999999",
   thread_id:"88888888-8888-4888-8888-888888888888",
   capability_id:"alex.drink_price_experiment.v1",status:"manual_confirmed",
   revision:3,approved_at:"2026-11-01T16:00:00Z",
   canonical_effect_payload:{productId:itemId,productName:"Latte",
    oldPriceCents:500,newPriceCents:550,currency:"USD"},
   monitor_spec:{durationDays:7},locale:"en" as const};
  const scope={businessId,ownerUserId:row.owner_user_id,threadId:row.thread_id,locale:"en" as const};
  testReader.elapsed.mockReset().mockImplementation(async(_db:unknown,_biz:unknown,
   _item:unknown,window:unknown)=>({window,status:"actual",units:4,revenueCents:2000,
    countedLines:1,unknownTimeLines:0,source:"order_lines.ordered_at",asOf:now}));
  const run=(tick:string)=>runVerifiedToastPriceTick(db,repo,row,scope,tick,
   "America/Los_Angeles",{} as LoopProposal);
  expect(await run("2026-11-03T19:00:00Z")).toBe("monitoring");
  expect(saveReport).toHaveBeenCalledTimes(2);
  saveReport.mockClear();
  expect(await run(now)).toBe("monitoring");
  expect(saveReport).toHaveBeenCalledTimes(4);
  const [savedScope,_proposal,report,opts]=saveReport.mock.calls[3];
  expect(savedScope).toEqual(scope);
  expect(report).toMatchObject({status:"in_progress",midRunKey:"verified-source-day-4",
   result:{coveredWindows:4,totalWindows:7,windowStartAt:start,nonCausal:true}});
  expect(opts).toEqual({midRun:true});
  expect(report.midRunText).toContain("Elapsed 24-hour day 4");
  expect(await run("2026-11-06T19:00:00Z")).toBe("monitoring");
  expect(saveReport.mock.calls[7][2].midRunKey).toBe(report.midRunKey);
  expect(saveReport.mock.calls[7][3]).toEqual({midRun:true});
  expect(await run("2026-11-08T19:00:00Z")).toBe("reported");
  expect(saveReport.mock.calls.at(-1)?.[2].status).toBe("complete");
 });
});

describe("Task 8a observation worker provisional publication recovery",()=>{
 it("does not publish an early final or price comparison until the later checkpoint completes",async()=>{
  const businessId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",itemId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const historyId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",restaurant="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const posItemId="toast:"+restaurant+":eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const ownerId="99999999-9999-4999-8999-999999999999",start="2026-11-01T18:00:00Z";
  const observed="2026-11-03T07:00:00Z";
  const event={id:historyId,business_id:businessId,menu_item_id:itemId,source_type:"connected_pos",source_provider:"toast",
   toast_restaurant_guid:restaurant,toast_publication_version:"menu-v1",toast_publication_pos_item_id:posItemId,
   toast_observed_at:start,toast_effective_at:null,toast_publication_completed_at:"2026-11-01T18:01:00Z",
   old_price_cents:500,new_price_cents:550};
  let later={toast_observed_at:observed,toast_effective_at:null,
   toast_publication_completed_at:null as string|null,toast_publication_pos_item_id:null as string|null,
   old_price_cents:550,new_price_cents:500};
  let anchor:unknown=null;
  const writes:Record<string,unknown>[]=[];
  function query(response:unknown):unknown{
   return new Proxy({},{get:(_t,prop)=>prop==="then"?
    (resolve:(value:unknown)=>void)=>Promise.resolve(response).then(resolve):
    (..._args:unknown[])=>query(response)});
  }
  const db={from:(table:string)=>({select:(columns:string,options?:{head?:boolean})=>{
   const response=table==="menu_price_history"?
    options?.head?{data:null,count:0,error:null}:
    columns.startsWith("id,business_id")?{data:event,error:null}:{data:[later],count:1,error:null}:
    table==="toast_location_mappings"?{data:{restaurant_guid:restaurant,verified_at:"2026-10-31T00:00:00Z"},error:null}:
    table==="businesses"?{data:{timezone:"America/Los_Angeles",currency:"USD"},error:null}:
    table==="memberships"?{data:[{user_id:ownerId}],count:1,error:null}:
    table==="menu_items"?{data:{name:"Latte",catalog_source:"toast",is_active:true,pos_item_id:posItemId,
     price_cents:500,toast_publication_state:"active",pos_pricing_strategy:"BASE_PRICE",toast_publication_observed_at:observed},error:null}:
    table==="supervisor_monitor_windows"?{data:{source_reference:anchor,owner_user_id:ownerId},error:null}:
    table==="supervisor_toast_price_context_changes"?{data:[],count:0,error:null}:
    table==="supervisor_experiment_notice_receipts"?{data:null,error:null}: {data:null,error:{message:"not needed"}};
   return query(response);
  }}),rpc:async(name:string,args:Record<string,unknown>)=>{
   if(name==="supervisor_8a_due_toast_observations")return {data:[{history_id:historyId,business_id:businessId,enabled_at:"2026-10-31T00:00:00Z"}],error:null};
   if(name==="supervisor_8a_claim_observation_work")return {data:"worker-token",error:null};
   if(name==="supervisor_8a_observation_thread")return {data:"owner-thread",error:null};
   if(name==="supervisor_8a_write_observation_window"){writes.push(args);return {data:true,error:null};}
   if(name==="supervisor_8a_finish_observation_work"){anchor=args.p_ref;return {data:true,error:null};}
   throw Error("unexpected RPC "+name);
  }} as unknown as SupabaseClient;
  testReader.notice.mockReset().mockResolvedValue("posted");
  testReader.elapsed.mockReset().mockImplementation(async(_db:unknown,_biz:unknown,_item:unknown,window:unknown,asOf:string)=>({
   window,status:"actual",units:4,revenueCents:2000,countedLines:1,unknownTimeLines:0,source:"order_lines.ordered_at",asOf
  }));
  const first=await runToastObservationBatch(db,"2026-11-04T19:00:00Z");
  expect(first.failed).toBe(0);
  expect(anchor).toMatchObject({interruptedAt:null,sourceGapAt:"2026-11-03T07:00:00.000Z",finalDue:false,
   cumulative:{observedUnits:null,observedRevenueCents:null,volumeChangeBps:null}});
  expect(writes.some(x=>x.p_index===1&&x.p_evaluation==="insufficient_evidence"&&x.p_units===null&&x.p_revenue===null)).toBe(true);
  expect(testReader.notice.mock.calls.some(x=>x[1].key.kind==="toast_price_final")).toBe(false);
  // Later checkpoint completes for the very same row/size, establishing the cut.
  later={...later,toast_publication_completed_at:"2026-11-04T20:00:00Z",toast_publication_pos_item_id:posItemId};
  testReader.notice.mockClear();
  const second=await runToastObservationBatch(db,"2026-11-04T21:00:00Z");
  expect(second.failed).toBe(0);
  expect(anchor).toMatchObject({interruptedAt:"2026-11-03T07:00:00.000Z",sourceGapAt:null,finalDue:true});
  expect(testReader.notice.mock.calls.some(x=>x[1].key.kind==="toast_price_final")).toBe(true);
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
  firstPriceChangeAt:null,firstContextChangeAt:null,priorInterruptionAt:null};
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
 it("keeps a partial second publication retryable and only ends early after full exact-item proof",()=>{
  const observed="2026-11-12T07:00:00Z";
  const pending={toast_observed_at:observed,toast_effective_at:null,toast_publication_completed_at:null,
   toast_publication_pos_item_id:null,old_price_cents:550,new_price_cents:500};
  const changed={...base,current:{...current,price_cents:500,toast_publication_observed_at:observed}};
  const gap=trialSourceInterruption({...changed,...subsequentToastPriceBoundary(pending,receipt,changed.asOf)});
  expect(gap).toEqual({at:"2026-11-12T07:00:00.000Z",reason:"unverified_gap"});
  expect(priceExposureBoundary(gap,base.finalEndAt)).toEqual({interruptedAt:null,sourceGapAt:gap.at,endAt:base.finalEndAt});
  expect(windowHasSourceGap(base.finalEndAt,gap.at)).toBe(true);
  expect(windowHasSourceGap(observed,gap.at)).toBe(false);
  const complete={...pending,toast_publication_completed_at:"2026-11-12T09:00:00Z",toast_publication_pos_item_id:receipt.posItemId};
  for(const invalid of [
   {...complete,toast_publication_completed_at:"2026-11-14T09:00:00Z"},
   {...complete,toast_publication_pos_item_id:receipt.posItemId+":size:ffffffff-ffff-4fff-8fff-ffffffffffff"},
   {...complete,old_price_cents:450},
  ]){
   const unverified=trialSourceInterruption({...changed,...subsequentToastPriceBoundary(invalid,receipt,changed.asOf)});
   expect(priceExposureBoundary(unverified,base.finalEndAt)).toEqual({interruptedAt:null,sourceGapAt:gap.at,endAt:base.finalEndAt});
  }
  const settled=trialSourceInterruption({...changed,priorInterruptionAt:gap.at,
   ...subsequentToastPriceBoundary(complete,receipt,changed.asOf)});
  expect(settled).toEqual({at:gap.at,reason:"verified_price_changed"});
  expect(priceExposureBoundary(settled,base.finalEndAt)).toEqual({interruptedAt:gap.at,sourceGapAt:null,endAt:gap.at});
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
 it("preserves an in-window contextual change after later unrelated publication overwrites latest timestamp",()=>{
  expect(trialSourceInterruption({...base,
   current:{...current,pos_pricing_strategy:"TIME_SPECIFIC_PRICE",
    toast_publication_observed_at:"2026-11-13T09:00:00Z"},
   firstContextChangeAt:"2026-11-12T07:00:00Z"})).toMatchObject({
    at:"2026-11-12T07:00:00.000Z",reason:"unverified_gap"});
 });
 it("retains first transition even if later menu publication restores base strategy",()=>{
  expect(trialSourceInterruption({...base,
   current:{...current,toast_publication_observed_at:"2026-11-13T09:00:00Z"},
   firstContextChangeAt:"2026-11-12T07:00:00Z"})).toMatchObject({
    at:"2026-11-12T07:00:00.000Z",reason:"unverified_gap"});
 });
 it("does not move a clean trial when the first context change was at or beyond end",()=>{
  expect(trialSourceInterruption({...base,
   current:{...current,pos_pricing_strategy:"TIME_SPECIFIC_PRICE",
    toast_publication_observed_at:"2026-11-12T18:01:00Z"},
   firstContextChangeAt:"2026-11-12T18:00:00Z"})).toEqual({
    at:null,reason:null});
 });

});


describe("Task 8a append-only context audit",()=>{
 const receipt={posItemId:"toast:dddddddd-dddd-4ddd-8ddd-dddddddddddd:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  newPriceCents:550};
 const matched={observed_at:"2026-11-11T18:01:00Z",
  new_pos_item_id:receipt.posItemId,new_pricing_strategy:"BASE_PRICE",
  new_catalog_source:"toast",new_is_active:true,old_price_cents:500,
  new_price_cents:550,old_publication_state:null,new_publication_state:"active"};
 it("does not falsely interrupt because initial canonical price and strategy are populated after source observation",()=>{
  expect(contextChangeBreaksApprovedPrice(matched,receipt)).toBe(false);
  expect(contextChangeBreaksApprovedPrice({...matched,old_price_cents:500,
   new_price_cents:500},receipt)).toBe(false);
 });
 it("retains later changes of strategy, identity, price and publication state",()=>{
  expect(contextChangeBreaksApprovedPrice({...matched,
   new_pricing_strategy:"TIME_SPECIFIC_PRICE"},receipt)).toBe(true);
  expect(contextChangeBreaksApprovedPrice({...matched,
   new_pos_item_id:receipt.posItemId+":size:ffffffff-ffff-4fff-8fff-ffffffffffff"},receipt))
   .toBe(true);
  expect(contextChangeBreaksApprovedPrice({...matched,old_price_cents:550,
   new_price_cents:500},receipt)).toBe(true);
  expect(contextChangeBreaksApprovedPrice({...matched,
   old_publication_state:"active",new_publication_state:"inactive"},receipt)).toBe(true);
 });
});


/** Deterministic-clock, real migrated-DB worker bridge for the shared owner
 * browser/Luna scenarios. Ordinary free unit CI never touches this fixture.
 * No model call, provider API, fake worker result or production DB. */
it.skipIf(process.env.AICAFE_8A_DISPOSABLE_WORKER!=="1")("8a disposable real cron worker",async()=>{
 if(process.env.NEXT_PUBLIC_SUPABASE_URL!=="http://127.0.0.1:54321"||
    process.env.ACCEPTANCE_DATABASE_URL!=="postgresql://postgres:postgres@127.0.0.1:54322/postgres"||
    process.env.AI_CAFE_LIVE_ACCEPTANCE!=="OWNER_APPROVED_LOCAL_ONLY"||
    !process.env.SUPABASE_SERVICE_ROLE_KEY)throw Error("8a_disposable_environment_required");
 const mode=process.env.AICAFE_8A_WORKER_MODE;
 // Restore real collaborators, not the unit doubles defined above.
 vi.doUnmock("./toastPriceEvidence.server");
 vi.doUnmock("./rollingExperimentSales.server");
 vi.doUnmock("./experimentNotices.server");
 vi.resetModules();
 const {createAdminSupabaseClient}=await import("@/lib/supabase/admin");
 const {runToastObservationBatch}=await import("./experimentCutover.server");
 const db=createAdminSupabaseClient();
 if(mode==="observation"){
  const asOf=process.env.AICAFE_8A_AS_OF;
  if(!asOf||!Number.isFinite(Date.parse(asOf)))throw Error("8a_asof_required");
  const outcome=await runToastObservationBatch(db,asOf);
  expect(outcome.failed).toBe(0);
 }else if(mode==="approved"){
  // Exercise the genuine authenticated production route, not a hand-built
  // report or synthetic result. Task17C separately proves scheduling/HTTP.
  const {GET}=await import("@/app/api/cron/supervisor-experiments/route");
  const {randomUUID}=await import("node:crypto");
  const secret=randomUUID();process.env.CRON_SECRET=secret;
  const response=await GET(new Request("http://127.0.0.1:3000/api/cron/supervisor-experiments",{
   headers:{authorization:"Bearer "+secret}}));
  const result=await response.json();
  expect(response.status).toBe(200);
  expect(result.failed).toBe(0);
 }else throw Error("8a_worker_mode_invalid");
},120000);

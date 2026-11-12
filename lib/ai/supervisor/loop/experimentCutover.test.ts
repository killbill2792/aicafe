import {describe,expect,it} from "vitest";
import {resolveExperimentCutoverMode,readVerifiedActivationAnchor} from "./experimentCutover.server";

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

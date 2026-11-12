import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {matchVerifiedToastPriceEvidence,matchVerifiedHistoricToastActivation} from "./toastPriceEvidence.server";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const itemId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const itemGuid="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const original={
 businessId:business,menuItemId:itemId,targetCents:550,
 menu:{business_id:business,id:itemId,pos_item_id:`toast:${restaurant}:${itemGuid}`,
  catalog_source:"toast",price_cents:550,is_active:true,
  pos_pricing_strategy:"BASE_PRICE",toast_publication_state:"active",
  toast_publication_version:"2026-11-11T18:00:00Z",
  toast_publication_observed_at:"2026-11-11T18:01:00Z"},
 receipt:{restaurant_guid:restaurant,verified_at:"2026-11-01T12:00:00Z",
  menu_last_updated:"2026-11-11T18:00:00Z",menu_copied_at:"2026-11-11T18:02:00Z"},
 history:[{id:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  business_id:business,menu_item_id:itemId,old_price_cents:500,
  new_price_cents:550,source_type:"connected_pos",source_provider:"toast",
  toast_restaurant_guid:restaurant,toast_publication_version:"2026-11-11T18:00:00Z",
  toast_observed_at:"2026-11-11T18:01:00Z",toast_effective_at:null,
  changed_at:"2026-11-11T18:01:15Z"}],
};
describe("Task 8a Toast verified published price only",()=>{
 it("uses first authenticated observed timestamp when source effectiveAt is absent",()=>{
  expect(matchVerifiedToastPriceEvidence(original)).toMatchObject({
   status:"verified",oldPriceCents:500,newPriceCents:550,
   startAt:"2026-11-11T18:01:00Z",
   startBasis:"first_verified_observation"});
 });
 it("uses a separately authenticated effectiveAt only when present and not after observation",()=>{
  const input={...original,history:[{...original.history[0],toast_effective_at:"2026-11-11T17:45:00Z"}]};
  expect(matchVerifiedToastPriceEvidence(input)).toMatchObject({
   status:"verified",startAt:"2026-11-11T17:45:00Z",startBasis:"source_effective"});
 });
 it("rejects local owner edit and initial-only history, even if prices happen to match",()=>{
  for(const history of [
   [{...original.history[0],source_type:"owner_manual"}],
   [{...original.history[0],old_price_cents:null}],
   [{...original.history[0],new_price_cents:500}],
  ])expect(matchVerifiedToastPriceEvidence({...original,history}).status).toBe("unverified");
 });
 it("rejects wrong café/restaurant, old version and unknown publication",()=>{
  const invalid=[
   {...original,menu:{...original.menu,business_id:"ffffffff-ffff-4fff-8fff-ffffffffffff"}},
   {...original,receipt:{...original.receipt,restaurant_guid:"ffffffff-ffff-4fff-8fff-ffffffffffff"}},
   {...original,receipt:{...original.receipt,menu_last_updated:"2026-11-10T18:00:00Z"}},
   {...original,menu:{...original.menu,toast_publication_state:"unknown"}},
   {...original,receipt:{...original.receipt,verified_at:null}},
  ];
  for(const data of invalid)expect(matchVerifiedToastPriceEvidence(data).status).toBe("unverified");
 });
 it("rejects ambiguous size identity and contextual or open pricing",()=>{
  const cases=[
   {...original,menu:{...original.menu,pos_pricing_strategy:"TIME_SPECIFIC_PRICE"}},
   {...original,menu:{...original.menu,pos_item_id:`toast:${restaurant}:${itemGuid}:size:NOT-GUID`}},
   {...original,menu:{...original.menu,pos_pricing_strategy:"OPEN_PRICE",price_cents:null}},
  ];
  for(const data of cases)expect(matchVerifiedToastPriceEvidence(data).status).toBe("unverified");
 });
 it("does not infer a unique receipt from two matching histories",()=>{
  const other={...original.history[0],id:"ffffffff-ffff-4fff-8fff-ffffffffffff"};
  expect(matchVerifiedToastPriceEvidence({...original,history:[...original.history,other]}))
   .toMatchObject({status:"unverified",reason:"ambiguous_price_history"});
 });
});

describe("Task 8a approved Toast historical activation survives a later unrelated menu version",()=>{
 const latest={...original,
  menu:{...original.menu,
   toast_publication_version:"2026-11-11T20:00:00Z",
   toast_publication_observed_at:"2026-11-11T20:01:00Z"},
  receipt:{...original.receipt,menu_last_updated:"2026-11-11T20:00:00Z",
   menu_copied_at:"2026-11-11T20:02:00Z"},
  approvedAt:"2026-11-11T17:00:00Z",oldPriceCents:500,
  locations:[{restaurant_guid:restaurant,verified_at:"2026-11-01T12:00:00Z"}],
  audits:[{observed_at:"2026-11-11T18:01:15Z",
   old_pos_item_id:`toast:${restaurant}:${itemGuid}`,
   new_pos_item_id:`toast:${restaurant}:${itemGuid}`,
   old_price_cents:500,new_price_cents:550,
   new_pricing_strategy:"BASE_PRICE",new_catalog_source:"toast",new_is_active:true}]};
 it("recovers the authenticated earlier price receipt, not the latest unrelated menu stamp",()=>{
  expect(matchVerifiedToastPriceEvidence(latest).status).toBe("unverified");
  expect(matchVerifiedHistoricToastActivation(latest)).toMatchObject({
   status:"verified",historyId:original.history[0].id,
   publicationVersion:original.history[0].toast_publication_version,
   observedAt:"2026-11-11T18:01:00Z",
   startAt:"2026-11-11T18:01:00Z"});
 });
 it("rejects events before approval, owner writes, wrong restaurant and changed price context",()=>{
  expect(matchVerifiedHistoricToastActivation({...latest,
   approvedAt:"2026-11-11T19:00:00Z"}).status).toBe("unverified");
  expect(matchVerifiedHistoricToastActivation({...latest,
   history:[{...original.history[0],source_type:"owner_manual"}]}).status)
   .toBe("unverified");
  expect(matchVerifiedHistoricToastActivation({...latest,
   history:[{...original.history[0],toast_restaurant_guid:
    "ffffffff-ffff-4fff-8fff-ffffffffffff"}]}).status).toBe("unverified");
  expect(matchVerifiedHistoricToastActivation({...latest,
   audits:[{...latest.audits[0],new_pricing_strategy:"TIME_SPECIFIC_PRICE"}]}).status)
   .toBe("unverified");
 });
 it("recovers the original verified source even after a later revert, unpublication or contextual menu",()=>{
  expect(matchVerifiedHistoricToastActivation({...latest,menu:{
   ...latest.menu,price_cents:500,is_active:false,
   toast_publication_state:"inactive",
   pos_pricing_strategy:"TIME_SPECIFIC_PRICE",
   toast_publication_version:"later-unrelated-version"}})).toMatchObject({
    status:"verified",historyId:original.history[0].id,
    oldPriceCents:500,newPriceCents:550});
 });
 it("rejects duplicated same-time candidate receipts rather than picking one",()=>{
  expect(matchVerifiedHistoricToastActivation({...latest,history:[
   ...latest.history,{...latest.history[0],
    id:"ffffffff-ffff-4fff-8fff-ffffffffffff"}]})).toMatchObject({
     status:"unverified",reason:"ambiguous_activation_history"});
 });
});

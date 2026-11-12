import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({bundle:vi.fn(),stage:vi.fn(),canonical:vi.fn(),
 apply:vi.fn(),legacyItems:vi.fn(),legacyFacts:vi.fn()}));
vi.mock("./adapter",()=>({createToastAdapter:()=>({
 provider:"toast",fetchPublishedCatalogBundle:m.bundle,
 fetchCatalogItems:m.legacyItems,fetchCatalogFacts:m.legacyFacts,
})}));
vi.mock("./operationalStaging",()=>({stageToastCatalog:m.stage,
 stageToastRoster:vi.fn(),reconcileToastOperationalHealth:vi.fn()}));
vi.mock("../syncCatalog",()=>({syncCanonicalCatalog:m.canonical,
 applyPublishedToastCatalogReceipt:m.apply}));
import {copyToastPublishedMenu} from "./operationalCopy";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const itemGuid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const posItemId="toast:"+restaurant+":"+itemGuid;
const scope={businessId:business,restaurantGuid:restaurant,
 locationId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
 timezone:"America/Los_Angeles",deadlineAt:Date.now()+600000};
const bundle={items:[{posItemId,name:"Latte",baseName:"Latte",
 category:"DRINK",sizeLabel:null,priceCents:550,modifierGroups:[]}],
 facts:[{kind:"item",provider_guid:itemGuid,name:"Latte",category:"Coffee",
 price_cents:550,pricing_strategy:"BASE_PRICE",modifier_group_guids:[]}],
 receipt:{restaurantGuid:restaurant,publicationVersion:"2026-11-10T15:00:00Z",
 observedAt:"2026-11-10T16:00:00Z"}};
function mockDB(){
 const previous={menu_last_updated:"2026-11-09T15:00:00Z",
  menu_copied_at:"2026-11-09T16:00:00Z",menu_checked_local_day:"2026-11-09"};
 const now={...previous};
 const writes:Record<string,unknown>[]=[];
 const rpc=vi.fn(async(name:string)=>({error:null,data:
  name==="toast_verify_existing_price_history"?"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee":null}));
 const db={
  from(table:string){
   if(table!=="toast_optional_sync_state")throw new Error("unexpected:"+table);
   const q={select(_s:string){return q;},eq(_k:string,_v:unknown){return q;},
    async maybeSingle(){return {data:{...now},error:null};},
    async upsert(input:Record<string,unknown>){
     Object.assign(now,input);writes.push({...input});return {error:null};
    },
    update(input:Record<string,unknown>){
     const query={eq(_k:string,_v:unknown){return query;},
      then(resolve:(v:{error:null})=>unknown){
       Object.assign(now,input);writes.push({...input});
       return Promise.resolve({error:null}).then(resolve);
      }};
     return query;
    }};
   return q;
  },rpc
 };
 return {db:db as unknown as SupabaseClient,rpc,writes,now};
}
beforeEach(()=>{
 for(const fn of Object.values(m))fn.mockReset();
 m.bundle.mockResolvedValue(bundle);m.stage.mockResolvedValue({staged:1});
 m.canonical.mockImplementation(async (_db:unknown,_business:unknown,adapter:{
  fetchCatalogItems:()=>Promise<unknown[]>})=>{
  expect(await adapter.fetchCatalogItems()).toBe(bundle.items);
  return {imported:1,matched:1,needsReview:0,created:0,changed:1};
 });
 m.apply.mockResolvedValue({inactiveItems:0,inactiveModifiers:0,inactiveGroups:0});
});
describe("POS0 verified single-bundle source handoff",()=>{
 it("stages and imports exactly the same verified publication without second menu fetch",async()=>{
  const f=mockDB();
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(m.bundle).toHaveBeenCalledOnce();
  expect(m.legacyItems).not.toHaveBeenCalled();
  expect(m.legacyFacts).not.toHaveBeenCalled();
  expect(m.stage).toHaveBeenCalledWith(f.db,scope,bundle.facts);
  expect(m.apply).toHaveBeenCalledWith(f.db,business,bundle);
  expect(f.rpc).toHaveBeenCalledWith("toast_verify_existing_price_history",
   expect.objectContaining({p_business_id:business,p_restaurant_guid:restaurant,
    p_item_pos_id:posItemId,p_version:bundle.receipt.publicationVersion,
    p_price_cents:550}));
  expect(f.now.menu_last_updated).toBe(bundle.receipt.publicationVersion);
  expect(result.verifiedPriceChanges).toBe(1);
 });
 it("refuses a wrong-restaurant receipt before any writer runs",async()=>{
  m.bundle.mockResolvedValueOnce({...bundle,receipt:{...bundle.receipt,
   restaurantGuid:"ffffffff-ffff-4fff-8fff-ffffffffffff"}});
  const f=mockDB();
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toMatchObject({
   category:"unauthorized_location"});
  expect(m.stage).not.toHaveBeenCalled();
  expect(m.canonical).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(0);
 });
 it("restores the old checkpoint and forces retry when publication promotion fails",async()=>{
  m.apply.mockRejectedValueOnce(new Error("incomplete provider relationships"));
  const f=mockDB();
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow(
   "incomplete provider relationships");
  expect(f.now.menu_last_updated).toBe("2026-11-09T15:00:00Z");
  expect(f.now.menu_checked_local_day).toBeNull();
  expect(f.rpc).not.toHaveBeenCalled();
 });
 it("skips unverifiable open-price changes without claiming zero or a source delta",async()=>{
  m.bundle.mockResolvedValueOnce({...bundle,items:[{...bundle.items[0],
   priceCents:null}]});
  const f=mockDB();
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(result.verifiedPriceChanges).toBe(0);
  expect(f.rpc).not.toHaveBeenCalled();
 });
});

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
 const storedObservations=new Map<string,{version:string;observedAt:string}>();
 // SQL keeps the first observation for an already-active same-version item.
 m.apply.mockImplementation(async (_db:unknown,_business:unknown,published:typeof bundle)=>{
  for(const item of published.items){
   const old=storedObservations.get(item.posItemId);
   if(!old||old.version!==published.receipt.publicationVersion)
    storedObservations.set(item.posItemId,{
     version:published.receipt.publicationVersion,observedAt:published.receipt.observedAt});
  }
  return {inactiveItems:0,inactiveModifiers:0,inactiveGroups:0};
 });
 const rpc=vi.fn(async(name:string):Promise<{error:{message:string}|null;data:boolean|null}>=>({
  error:null,data:name==="toast_verify_existing_price_history"?true:null}));
 const db={
  from(table:string){
   if(table==="menu_items"){
    const q={select(_s:string){return q;},eq(_k:string,_v:unknown){return q;},
     async in(_key:string,ids:string[]){
      return {data:ids.flatMap(id=>{
       const stored=storedObservations.get(id);
       return stored?[{pos_item_id:id,toast_publication_observed_at:stored.observedAt}]:[];
      }),error:null};
     }};
    return q;
   }
   if(table!=="toast_optional_sync_state")throw new Error("unexpected:"+table);
   const q={select(_s:string){return q;},eq(_k:string,_v:unknown){return q;},
    async maybeSingle(){return {data:{...now},error:null};},
    async upsert(input:Record<string,unknown>){
     Object.assign(now,input);writes.push({...input});return {error:null};
    },
    update(input:Record<string,unknown>){
     const query={eq(_k:string,_v:unknown){return query;},
      then(resolve:(v:{error:unknown})=>unknown){
       Object.assign(now,input);writes.push({...input});
       return Promise.resolve({error:null}).then(resolve);
      }};
     return query;
    }};
   return q;
  },rpc
 };
 return {db:db as unknown as SupabaseClient,rpc,writes,now,storedObservations};
}
beforeEach(()=>{
 for(const fn of Object.values(m))fn.mockReset();
 m.bundle.mockResolvedValue(bundle);m.stage.mockResolvedValue({staged:1});
 m.canonical.mockImplementation(async (_db:unknown,_business:unknown,adapter:{
  fetchCatalogItems:()=>Promise<unknown[]>})=>{
  expect(await adapter.fetchCatalogItems()).toEqual(expect.arrayContaining([expect.objectContaining({posItemId})]));
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
  expect(f.writes[0]).toEqual(expect.objectContaining({
   menu_last_updated:"pending:"+bundle.receipt.publicationVersion,
   menu_checked_local_day:null,menu_copied_at:bundle.receipt.observedAt}));
  expect(f.writes[1]).toEqual(expect.objectContaining({
   menu_last_updated:bundle.receipt.publicationVersion,
   menu_checked_local_day:null,menu_copied_at:bundle.receipt.observedAt}));
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
 it("persists the first receipt as pending when promotion fails after price import",async()=>{
  m.apply.mockRejectedValueOnce(new Error("incomplete provider relationships"));
  const f=mockDB();
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow(
   "incomplete provider relationships");
  expect(m.canonical).toHaveBeenCalledOnce();
  expect(f.now.menu_last_updated).toBe(bundle.receipt.publicationVersion);
  expect(f.now.menu_copied_at).toBe(bundle.receipt.observedAt);
  expect(f.now.menu_checked_local_day).toBeNull();
  expect(f.rpc).not.toHaveBeenCalled();
 });
 it("keeps receipt pending when a canonical writer fails",async()=>{
  m.canonical.mockRejectedValueOnce(new Error("database unavailable"));
  const f=mockDB();
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow("database unavailable");
  expect(f.now.menu_last_updated).toBe("pending:"+bundle.receipt.publicationVersion);
  expect(f.now.menu_copied_at).toBe(bundle.receipt.observedAt);
  expect(f.now.menu_checked_local_day).toBeNull();
  expect(f.writes).toHaveLength(1);
  expect(m.apply).not.toHaveBeenCalled();
 });
 it("reconciles a delayed pre-presence interruption with the first receipt",async()=>{
  const later={...bundle,receipt:{...bundle.receipt,observedAt:"2026-11-10T16:45:00Z"}};
  m.bundle.mockResolvedValueOnce(bundle).mockResolvedValueOnce(later);
  m.apply.mockRejectedValueOnce(new Error("presence SQL temporarily offline"));
  const f=mockDB();
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow("presence SQL temporarily offline");
  expect(f.now.menu_copied_at).toBe(bundle.receipt.observedAt);
  expect(f.now.menu_checked_local_day).toBeNull();
  m.canonical.mockResolvedValueOnce({imported:1,matched:1,needsReview:0,created:0,changed:0});
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(m.bundle).toHaveBeenCalledTimes(2);
  expect(m.apply).toHaveBeenLastCalledWith(f.db,business,expect.objectContaining({
   receipt:expect.objectContaining({observedAt:bundle.receipt.observedAt})}));
  expect(f.rpc).toHaveBeenLastCalledWith("toast_verify_existing_price_history",
   expect.objectContaining({p_observed_at:bundle.receipt.observedAt}));
  expect(result.changed).toBe(0);
  expect(result.verifiedPriceChanges).toBe(1);
  expect(f.now.menu_checked_local_day).not.toBeNull();
 });
 it("reuses the committed observation for price proof after a partial RPC outage",async()=>{
  const firstObserved=bundle.receipt.observedAt;
  const laterObserved="2026-11-10T16:15:00Z";
  m.bundle.mockResolvedValueOnce(bundle).mockResolvedValueOnce({
   ...bundle,receipt:{...bundle.receipt,observedAt:laterObserved}});
  const f=mockDB();
  f.rpc.mockResolvedValueOnce({error:{message:"temporary SQL outage"},data:null});
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toMatchObject({
   category:"unavailable"});
  expect(f.storedObservations.get(posItemId)?.observedAt).toBe(firstObserved);
  expect(f.now.menu_checked_local_day).toBeNull();
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(result.verifiedPriceChanges).toBe(1);
  expect(f.rpc).toHaveBeenLastCalledWith("toast_verify_existing_price_history",
   expect.objectContaining({p_observed_at:firstObserved}));
  expect(f.now.menu_checked_local_day).not.toBeNull();
 });
 it("does not count an unverified price-history RPC as a source-verified change",async()=>{
  const f=mockDB();
  f.rpc.mockImplementation(async()=>({error:null,data:false}));
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(result.verifiedPriceChanges).toBe(0);
  expect(f.rpc).toHaveBeenCalledWith("toast_verify_existing_price_history",expect.anything());
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

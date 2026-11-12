import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({bundle:vi.fn(),stage:vi.fn(),canonical:vi.fn(), apply:vi.fn(),legacyItems:vi.fn(),legacyFacts:vi.fn()}));
vi.mock("./adapter",()=>({createToastAdapter:()=>({
 provider:"toast",fetchPublishedCatalogBundle:m.bundle, fetchCatalogItems:m.legacyItems,fetchCatalogFacts:m.legacyFacts,
})}));
vi.mock("./operationalStaging",()=>({stageToastCatalog:m.stage, stageToastRoster:vi.fn(),reconcileToastOperationalHealth:vi.fn()}));
vi.mock("../syncCatalog",()=>({syncCanonicalCatalog:m.canonical, applyPublishedToastCatalogReceipt:m.apply}));
import {copyToastPublishedMenu} from "./operationalCopy";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const itemGuid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const posItemId="toast:"+restaurant+":"+itemGuid;
const scope={businessId:business,restaurantGuid:restaurant, locationId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
 timezone:"America/Los_Angeles",deadlineAt:Date.now()+600000};
const bundle={items:[{posItemId,name:"Latte",baseName:"Latte", category:"DRINK",sizeLabel:null,priceCents:550,modifierGroups:[]}],
 facts:[{kind:"item",provider_guid:itemGuid,name:"Latte",category:"Coffee",
 price_cents:550,pricing_strategy:"BASE_PRICE",modifier_group_guids:[]}],
 receipt:{restaurantGuid:restaurant,publicationVersion:"2026-11-10T15:00:00Z", observedAt:"2026-11-10T16:00:00Z"}};
function mockDB(){
 const previous={menu_last_updated:"2026-11-09T15:00:00Z", menu_copied_at:"2026-11-09T16:00:00Z",menu_checked_local_day:"2026-11-09",
  menu_pending_observations:[] as string[]};
 const now={...previous};
 const writes:Record<string,unknown>[]=[];
 const storedObservations=new Map<string,{version:string;observedAt:string}>();
 const failVerifyOnce={value:false},failRecord={value:false},failSuperseded={value:false};
 const verifyReceipt={value:null as string|null};
 const verifiedResult={value:true};
 // SQL preserves first active same-version item's observation on replay.
 m.apply.mockImplementation(async (_db:unknown,_business:unknown,published:typeof bundle)=>{
  for(const item of published.items){
   const old=storedObservations.get(item.posItemId);
   if(!old||old.version!==published.receipt.publicationVersion)
    storedObservations.set(item.posItemId,{
     version:published.receipt.publicationVersion,observedAt:published.receipt.observedAt});
  }
  return {inactiveItems:0,inactiveModifiers:0,inactiveGroups:0};
 });
 const rpc=vi.fn(async(name:string,args?:Record<string,unknown>):Promise<{
  error:{message:string}|null;data:boolean|string[]|null}>=>{
  if(name==="toast_record_pending_menu_observation"){
   if(failRecord.value)return {error:{message:"cannot persist receipt"},data:null};
   const observed=String(args?.p_observed_at);
   if(!now.menu_pending_observations.includes(observed))
    now.menu_pending_observations.push(observed);
   return {error:null,data:[...now.menu_pending_observations]};
  }
  if(name==="toast_reconcile_superseded_menu_history")
   return {error:failSuperseded.value?{message:"historic proof unavailable"}:null,data:!failSuperseded.value};
  if(name==="toast_verify_existing_price_history"){
   if(failVerifyOnce.value){failVerifyOnce.value=false;
    return {error:{message:"temporary SQL outage"},data:null};}
   return {error:null,data:verifyReceipt.value!==null ?now.menu_pending_observations.includes(verifyReceipt.value):verifiedResult.value};
  }
  return {error:null,data:null};
 });
 const db={
  from(table:string){
   if(table==="menu_items"){
    const q={select(_s:string){return q;},eq(_k:string,_v:unknown){return q;}, async in(_key:string,ids:string[]){
      return {data:ids.flatMap(id=>{
       const stored=storedObservations.get(id);
       return stored?[{pos_item_id:id,toast_publication_observed_at:stored.observedAt}]:[];
      }),error:null};
     }};
    return q;
   }
   if(table!=="toast_optional_sync_state")throw new Error("unexpected:"+table);
   const q={select(_s:string){return q;},eq(_k:string,_v:unknown){return q;}, async maybeSingle(){return {data:{...now},error:null};},
    async upsert(input:Record<string,unknown>){
     Object.assign(now,input);writes.push({...input});return {error:null};
    }, update(input:Record<string,unknown>){
     const query={eq(_k:string,_v:unknown){return query;}, then(resolve:(v:{error:unknown})=>unknown){
       Object.assign(now,input);writes.push({...input});
       return Promise.resolve({error:null}).then(resolve);
      }};
     return query;
    }};
   return q;
  },rpc
 };
 return {db:db as unknown as SupabaseClient,rpc,writes,now,storedObservations, failVerifyOnce,failRecord,failSuperseded,verifyReceipt,verifiedResult};
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
    p_item_pos_id:posItemId,p_version:bundle.receipt.publicationVersion, p_price_cents:550}));
  expect(f.now.menu_last_updated).toBe(bundle.receipt.publicationVersion);
  expect(f.writes[0]).toEqual(expect.objectContaining({
   menu_last_updated:"pending:"+bundle.receipt.publicationVersion, menu_checked_local_day:null,menu_copied_at:bundle.receipt.observedAt}));
  expect(f.writes[1]).toEqual(expect.objectContaining({
   menu_last_updated:bundle.receipt.publicationVersion, menu_checked_local_day:null,menu_copied_at:bundle.receipt.observedAt}));
  expect(f.now.menu_pending_observations).toEqual([bundle.receipt.observedAt]);
  expect(f.rpc).toHaveBeenCalledWith("toast_record_pending_menu_observation",
   expect.objectContaining({p_first_observed_at:bundle.receipt.observedAt, p_observed_at:bundle.receipt.observedAt}));
  expect(result.verifiedPriceChanges).toBe(1);
 });
 it("refuses a wrong-restaurant receipt before any writer runs",async()=>{
  m.bundle.mockResolvedValueOnce({...bundle,receipt:{...bundle.receipt, restaurantGuid:"ffffffff-ffff-4fff-8fff-ffffffffffff"}});
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
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow( "incomplete provider relationships");
  expect(m.canonical).toHaveBeenCalledOnce();
  expect(f.now.menu_last_updated).toBe(bundle.receipt.publicationVersion);
  expect(f.now.menu_copied_at).toBe(bundle.receipt.observedAt);
  expect(f.now.menu_checked_local_day).toBeNull();
  expect(f.rpc.mock.calls.some(([name])=>name==="toast_verify_existing_price_history")).toBe(false);
 });
 it("keeps receipt pending when a canonical writer fails",async()=>{
  m.canonical.mockRejectedValueOnce(new Error("database unavailable"));
  const f=mockDB();
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow("database unavailable");
  expect(f.now.menu_last_updated).toBe("pending:"+bundle.receipt.publicationVersion);
  expect(f.now.menu_copied_at).toBe(bundle.receipt.observedAt);
  expect(f.now.menu_checked_local_day).toBeNull();
  expect(f.writes).toHaveLength(1);
  expect(f.now.menu_pending_observations).toEqual([bundle.receipt.observedAt]);
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
 it("verifies a late first-write using the durably registered second receipt",async()=>{
  const retryObservedAt="2026-11-10T19:45:00Z";
  m.bundle.mockResolvedValueOnce(bundle).mockResolvedValueOnce({
   ...bundle,receipt:{...bundle.receipt,observedAt:retryObservedAt}});
  m.stage.mockRejectedValueOnce(new Error("staging interrupted before any price write"));
  const f=mockDB();
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow( "staging interrupted before any price write");
  expect(m.canonical).not.toHaveBeenCalled();
  expect(f.now.menu_last_updated).toBe("pending:"+bundle.receipt.publicationVersion);
  expect(f.now.menu_copied_at).toBe(bundle.receipt.observedAt);
  expect(f.now.menu_pending_observations).toEqual([bundle.receipt.observedAt]);
  f.verifyReceipt.value=retryObservedAt;
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(m.canonical).toHaveBeenCalledOnce();
  expect(m.apply).toHaveBeenCalledWith(f.db,business,expect.objectContaining({
   receipt:expect.objectContaining({observedAt:bundle.receipt.observedAt})}));
  expect(f.now.menu_pending_observations).toEqual([ bundle.receipt.observedAt,retryObservedAt]);
  expect(f.rpc.mock.calls.filter(([name])=>name==="toast_verify_existing_price_history"))
   .toHaveLength(1);
  expect(f.rpc).toHaveBeenLastCalledWith("toast_verify_existing_price_history",
   expect.objectContaining({p_observed_at:bundle.receipt.observedAt}));
  expect(result.verifiedPriceChanges).toBe(1);
  expect(f.now.menu_checked_local_day).not.toBeNull();
 });
 it("keeps a second-attempt price receipt across a third delayed retry",async()=>{
  const secondAt="2026-11-10T19:45:00Z",thirdAt="2026-11-10T21:45:00Z";
  m.bundle.mockResolvedValueOnce(bundle)
   .mockResolvedValueOnce({...bundle,receipt:{...bundle.receipt,observedAt:secondAt}})
   .mockResolvedValueOnce({...bundle,receipt:{...bundle.receipt,observedAt:thirdAt}});
  m.stage.mockRejectedValueOnce(new Error("staging temporarily unavailable"));
  const f=mockDB();
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow( "staging temporarily unavailable");
  m.apply.mockRejectedValueOnce(new Error("presence unavailable after price write"));
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow( "presence unavailable after price write");
  expect(m.canonical).toHaveBeenCalledOnce();
  expect(f.now.menu_pending_observations).toEqual([bundle.receipt.observedAt,secondAt]);
  expect(f.now.menu_checked_local_day).toBeNull();
  f.verifyReceipt.value=secondAt;
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(m.canonical).toHaveBeenCalledTimes(2);
  expect(m.bundle).toHaveBeenCalledTimes(3);
  expect(f.now.menu_pending_observations).toEqual([ bundle.receipt.observedAt,secondAt,thirdAt]);
  expect(f.rpc).toHaveBeenLastCalledWith("toast_verify_existing_price_history",
   expect.objectContaining({p_observed_at:bundle.receipt.observedAt}));
  expect(result.verifiedPriceChanges).toBe(1);
  expect(f.now.menu_checked_local_day).not.toBeNull();
 });
 it("aborts before staging if source receipt registration is not durable",async()=>{
  const f=mockDB();
  f.failRecord.value=true;
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toMatchObject({
   category:"unavailable"});
  expect(m.stage).not.toHaveBeenCalled();
  expect(m.canonical).not.toHaveBeenCalled();
  expect(f.now.menu_pending_observations).toEqual([]);
 });
 it("clears old-version observations when a new published version arrives",async()=>{
  const f=mockDB();
  await copyToastPublishedMenu(f.db,scope);
  const next={...bundle,receipt:{...bundle.receipt, publicationVersion:"2026-11-11T15:00:00Z",observedAt:"2026-11-11T16:00:00Z"}};
  m.bundle.mockResolvedValueOnce(next);
  await copyToastPublishedMenu(f.db,scope);
  expect(f.now.menu_pending_observations).toEqual([next.receipt.observedAt]);
 });
 it("reconciles unfinished V1 price evidence before advancing to V2",async()=>{
  const f=mockDB();m.apply.mockRejectedValueOnce(new Error("V1 promotion failed"));
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow("V1 promotion failed");
  const next={...bundle,receipt:{...bundle.receipt,
   publicationVersion:"2026-11-11T15:00:00Z",observedAt:"2026-11-11T16:00:00Z"}};
  m.bundle.mockResolvedValueOnce(next);
  await copyToastPublishedMenu(f.db,scope);
  expect(f.rpc).toHaveBeenCalledWith("toast_reconcile_superseded_menu_history",
   expect.objectContaining({p_version:bundle.receipt.publicationVersion,
    p_first_observed_at:bundle.receipt.observedAt}));
  expect(f.now.menu_pending_observations).toEqual([next.receipt.observedAt]);
  expect(f.now.menu_last_updated).toBe(next.receipt.publicationVersion);
 });
 it("retains unfinished V1 state if historical price proof fails",async()=>{
  const f=mockDB();m.apply.mockRejectedValueOnce(new Error("V1 promotion failed"));
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toThrow("V1 promotion failed");
  const writes=f.writes.length;f.failSuperseded.value=true;
  m.bundle.mockResolvedValueOnce({...bundle,receipt:{...bundle.receipt,
   publicationVersion:"2026-11-11T15:00:00Z",observedAt:"2026-11-11T16:00:00Z"}});
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toMatchObject({category:"unavailable"});
  expect(f.writes).toHaveLength(writes);
  expect(f.now.menu_last_updated).toBe(bundle.receipt.publicationVersion);
  expect(f.now.menu_pending_observations).toEqual([bundle.receipt.observedAt]);
 });
 it("reuses the committed observation for price proof after a partial RPC outage",async()=>{
  const firstObserved=bundle.receipt.observedAt;
  const laterObserved="2026-11-10T16:15:00Z";
  m.bundle.mockResolvedValueOnce(bundle).mockResolvedValueOnce({
   ...bundle,receipt:{...bundle.receipt,observedAt:laterObserved}});
  const f=mockDB();
  f.failVerifyOnce.value=true;
  await expect(copyToastPublishedMenu(f.db,scope)).rejects.toMatchObject({
   category:"unavailable"});
  expect(f.storedObservations.get(posItemId)?.observedAt).toBe(firstObserved);
  expect(f.now.menu_checked_local_day).toBeNull();
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(result.verifiedPriceChanges).toBe(1);
  expect(f.rpc).toHaveBeenLastCalledWith("toast_verify_existing_price_history", expect.objectContaining({p_observed_at:firstObserved}));
  expect(f.now.menu_checked_local_day).not.toBeNull();
 });
 it("does not count an unverified price-history RPC as a source-verified change",async()=>{
  const f=mockDB();
  f.verifiedResult.value=false;
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(result.verifiedPriceChanges).toBe(0);
  expect(f.rpc).toHaveBeenCalledWith("toast_verify_existing_price_history",expect.anything());
 });
 it("skips unverifiable open-price changes without claiming zero or a source delta",async()=>{
  m.bundle.mockResolvedValueOnce({...bundle,items:[{...bundle.items[0], priceCents:null}]});
  const f=mockDB();
  const result=await copyToastPublishedMenu(f.db,scope);
  expect(result.verifiedPriceChanges).toBe(0);
  expect(f.rpc.mock.calls.some(([name])=>name==="toast_verify_existing_price_history")).toBe(false);
 });
});

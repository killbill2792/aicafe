import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const calls=vi.hoisted(()=>({roster:vi.fn(),catalog:vi.fn(),request:vi.fn()}));
vi.mock("./client",async()=>{
 const {z}=await import("zod");
 class ToastApiError extends Error{
  constructor(public category:string,public status?:number,public retryAt?:string){super(category);}
 }
 return {GUID:z.uuid(),ToastApiError,createToastClient:()=>({request:calls.request})};
});
vi.mock("./adapter",()=>({createToastAdapter:()=>({
 fetchEmployeeRosterFacts:calls.roster,fetchCatalogFacts:calls.catalog
})}));
import {stageToastRoster,stageToastCatalog,reconcileToastOperationalHealth} from "./operationalStaging";
import {syncToastOperationalSources} from "./operationalCopy";
import {ToastApiError} from "./client";
import type {SupabaseClient} from "@supabase/supabase-js";
const s={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 restaurantGuid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"};
describe("Toast operational staging never mutates owner canonical data",()=>{
 it("separately stages employees including deleted records",async()=>{
  calls.roster.mockResolvedValue([
   {employee_guid:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",display_name:"A",deleted:false},
   {employee_guid:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",display_name:"B",deleted:true}
  ]);
  const rpc=vi.fn().mockResolvedValue({error:null});
  const db={rpc} as unknown as SupabaseClient;
  expect(await stageToastRoster(db,s)).toMatchObject({staged:2,canonicalEmployeesChanged:false});
  expect(rpc).toHaveBeenCalledWith("toast_stage_employee_roster",
    expect.objectContaining({p_rows:expect.arrayContaining([expect.objectContaining({deleted:true})])}));
 });
 it("stages menu and modifiers without updating recipes or canonical menu",async()=>{
  calls.catalog.mockResolvedValue([
   {kind:"item",provider_guid:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",name:"Coffee",price_cents:500},
   {kind:"modifier",provider_guid:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",name:"Oat milk",price_cents:null}
  ]);
  const rpc=vi.fn().mockResolvedValue({error:null});
  const upsert=vi.fn().mockResolvedValue({error:null});
  const db={rpc,from:()=>({upsert})} as unknown as SupabaseClient;
  expect(await stageToastCatalog(db,s)).toMatchObject({items:1,modifiers:1,recipeHistoryPreserved:true});
  expect(rpc).toHaveBeenCalledWith("toast_stage_catalog",expect.anything());
 });
});

const opScope={...s,locationId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
 timezone:"America/Los_Angeles",closeoutHour:4};
const observed=new Date("2026-10-23T19:00:00-07:00");
const guid1="11111111-1111-4111-8111-111111111111";
const guid2="22222222-2222-4222-8222-222222222222";
function operationalDb(scopes:Record<string,boolean>={}){
 const log:Array<{name:string;args:Record<string,unknown>}>=[];
 let sources:Record<string,unknown>={};
 let healthCategory:string|null=null;
 const healthWrites:Record<string,unknown>[]=[];
 const db={
  from(table:string){
   const q={
    select(_fields:string){return q;},eq(_key:string,_value:unknown){return q;},
    async maybeSingle(){return {data:table==="toast_api_credentials"
     ?{scopes_available:scopes}:table==="toast_sync_health"
      ?{last_failure_category:healthCategory}:{operational_sources:sources},error:null};},
    async upsert(values:Record<string,unknown>){
     if(table==="toast_optional_sync_state")sources=values.operational_sources as Record<string,unknown>;
     if(table==="toast_sync_health"){
      healthCategory=values.last_failure_category as string|null;
      healthWrites.push(values);
     }
     return {error:null};
    }
   };
   return q;
  },
  async rpc(name:string,args:Record<string,unknown>){
   log.push({name,args});
   return {error:null,data:(args.p_objects as unknown[]).length};
  }
 };
 return {db:db as unknown as SupabaseClient,log,healthWrites,
  state:()=>sources as Record<string,{status:string;error?:string|null;last_success_at?:string;next_at:string}>,
  health:()=>healthCategory,setHealth:(v:string|null)=>{healthCategory=v;},
  setStates:(v:Record<string,unknown>)=>{sources=v;}};
}
beforeEach(()=>{
 calls.request.mockReset();
 calls.request.mockImplementation(async(path:string)=>{
  if(path.includes("/restaurant-availability/"))
   return {restaurantGuid:s.restaurantGuid,status:"ONLINE",reasonKey:"AVAILABILITY_ONLINE"};
  if(path.includes("/ordermgmt-config/"))return {acceptScheduledOrders:true};
  return [];
 });
});
describe("POS0c operational source capture uses the shared staged current writer",()=>{
 it("keeps cash, stock, multiple kitchen levels and availability source-shaped and stable",async()=>{
  calls.request.mockImplementation(async(path:string)=>{
   if(path.startsWith("/cashmgmt/v1/entries"))return [
    {guid:guid1,amount:12.50,date:"2026-10-23T18:01:00Z",type:"CASH_IN"}];
   if(path.startsWith("/cashmgmt/v1/deposits"))return [
    {guid:guid2,amount:9.25,date:"2026-10-23T18:10:00Z"}];
   if(path==="/stock/v1/inventory")return [
    {guid:guid1,status:"QUANTITY",quantity:3.5,versionId:guid2},
    {guid:guid2,status:"OUT_OF_STOCK",quantity:null}];
   if(path.includes("/kitchen/v1/export/itemFulfillments"))return [
    {restaurantGuid:s.restaurantGuid,orderGuid:guid1,selectionGuid:guid2,
     itemFulfillmentLevel:0,prepStationGuid:guid1,itemStartedAt:"2026-10-23T18:00:00Z"},
    {restaurantGuid:s.restaurantGuid,orderGuid:guid1,selectionGuid:guid2,
     itemFulfillmentLevel:1,prepStationGuid:null,itemFulfilledAt:"2026-10-23T18:03:00Z"}];
   if(path==="/kitchen/v1/published/prepStations")return [
    {guid:guid1,name:"Hot station"}];
   if(path.includes("/restaurant-availability/"))
    return {restaurantGuid:s.restaurantGuid,status:"ONLINE"};
   if(path.includes("/ordermgmt-config/"))return {acceptScheduledOrders:true};
   return [];
  });
  const f=operationalDb();
  const result=await syncToastOperationalSources(f.db,opScope,observed,Date.now()+300000);
  expect(result.attempted).toHaveLength(9);
  expect(f.state().stock_inventory.status).toBe("current");
  expect(f.state().kitchen_fulfillments.status).toBe("current");
  const batch=f.log.filter(x=>x.name==="toast_stage_operational_batch");
  expect(batch.map(x=>x.args.p_endpoint)).toContain("cashmgmt/v1/entries");
  const stock=batch.find(x=>x.args.p_endpoint==="stock/v1/inventory")!;
  expect(stock.args.p_objects).toEqual(expect.arrayContaining([
   expect.objectContaining({guid:guid2,status:"OUT_OF_STOCK",quantity:null,
    provider_key:guid2,business_id:s.businessId,restaurant_guid:s.restaurantGuid,
    endpoint:"stock/v1/inventory"})]));
  const kitchen=batch.find(x=>x.args.p_endpoint==="kitchen/v1/export/itemFulfillments")!;
  const rows=kitchen.args.p_objects as Array<{provider_key:string;operational_object_uuid:string}>;
  expect(rows).toHaveLength(2);
  expect(rows[0].provider_key).not.toBe(rows[1].provider_key);
  expect(rows[0].operational_object_uuid).not.toBe(rows[1].operational_object_uuid);
  const requested=calls.request.mock.calls.map(c=>String(c[0]));
  expect(requested).toEqual(expect.arrayContaining([
   "/cashmgmt/v1/entries?businessDate=20261023",
   "/cashmgmt/v1/entries?businessDate=20261022",
   "/cashmgmt/v1/deposits?businessDate=20261023",
   "/cashmgmt/v1/deposits?businessDate=20261022",
   "/kitchen/v1/export/itemFulfillments?businessDate=20261023",
  ]));
  expect(requested).toContain("/stock/v1/inventory"); // no unsupported date query
  const before=calls.request.mock.calls.length;
  await syncToastOperationalSources(f.db,opScope,observed,Date.now()+300000);
  expect(calls.request).toHaveBeenCalledTimes(before); // independent bounded next_at
 });
 it("preserves last good stock/kitchen when unauthorized, 204, or partial provider rows",async()=>{
  const f=operationalDb();
  calls.request.mockImplementation(async(path:string)=>{
   if(path==="/stock/v1/inventory")return [
    {guid:guid1,status:"QUANTITY",quantity:1},{guid:"NOT-A-GUID",status:"QUANTITY",quantity:0}];
   if(path.includes("/kitchen/v1/export/"))
    throw new ToastApiError("unavailable",204);
   if(path.includes("/cashmgmt/"))throw new ToastApiError("missing_scope_or_location",403);
   if(path.includes("/restaurant-availability/"))
    return {restaurantGuid:guid1,status:"OFFLINE"}; // wrong café: not allowed
   if(path.includes("/ordermgmt-config/"))return {acceptScheduledOrders:true};
   return [];
  });
  await syncToastOperationalSources(f.db,opScope,observed,Date.now()+300000);
  expect(f.state().stock_inventory.status).toBe("invalid_response");
  expect(f.state().kitchen_fulfillments.status).toBe("subscription_unavailable");
  expect(f.state().cash_entries_today.status).toBe("missing_scope_or_location");
  expect(f.health()).toContain("operational:cash_entries_today:missing_scope_or_location");
  expect(f.state().online_availability.status).toBe("unauthorized_location");
  expect(f.log.filter(x=>x.args.p_endpoint==="stock/v1/inventory")).toHaveLength(0);
  expect(f.log.filter(x=>x.args.p_endpoint==="kitchen/v1/export/itemFulfillments")).toHaveLength(0);
 });
 it("refuses invalid zero-quantity stock rather than showing a provider-observed zero",async()=>{
  const f=operationalDb({cash:false,kitchen:false,availability:false,ordering:false});
  calls.request.mockImplementation(async(path:string)=>{
   if(path==="/stock/v1/inventory")return [
    {guid:guid1,status:"QUANTITY",quantity:0}];
   return [];
  });
  await syncToastOperationalSources(f.db,opScope,observed,Date.now()+300000);
  expect(f.state().stock_inventory.status).toBe("invalid_response");
  expect(f.log.filter(x=>x.args.p_endpoint==="stock/v1/inventory")).toHaveLength(0);
 });
 it("does not confuse a 429 retry clock with evidence of successful fetch",async()=>{
  const f=operationalDb({cash:false,kitchen:false,stock:false,ordering:false});
  calls.request.mockImplementation(async(path:string)=>{
   if(path.includes("/restaurant-availability/"))
    throw new ToastApiError("rate_limited",429,"2026-10-24T19:00:00Z");
   return [];
  });
  await syncToastOperationalSources(f.db,opScope,observed,Date.now()+300000);
  expect(f.state().online_availability.status).toBe("rate_limited");
  expect(f.health()).toContain("operational:cash_entries_today:missing_permissions");
  expect(f.state().online_availability.last_success_at).toBeUndefined();
  expect(Date.parse(f.state().online_availability.next_at))
   .toBeGreaterThanOrEqual(Date.parse("2026-10-24T19:00:00Z"));
  expect(f.log).toHaveLength(0);
 });
 it("paginates prep stations without claiming a truncated page is complete",async()=>{
  const f=operationalDb({cash:false,stock:false,availability:false,ordering:false});
  calls.request.mockImplementation(async(path:string,_r:string,_schema:unknown,opts?:{
   onResponse?:(v:{status:number;nextPageToken:string|null})=>void})=>{
   if(path.startsWith("/kitchen/v1/published/prepStations")){
    opts?.onResponse?.({status:200,nextPageToken:path.includes("pageToken=")?null:"next"});
    return path.includes("pageToken=")?[{guid:guid2}]:[
     {guid:guid1},...Array.from({length:204},(_,i)=>({
      guid:"33333333-3333-4333-8333-"+String(i+1).padStart(12,"0")}))];
   }
   return [];
  });
  await syncToastOperationalSources(f.db,opScope,observed,Date.now()+300000);
  const batch=f.log.filter(x=>x.args.p_endpoint==="kitchen/v1/published/prepStations");
  expect(batch).toHaveLength(1); // 206 validated objects, one atomic RPC; never two partial commits
  expect(batch[0].args.p_objects).toHaveLength(206);
  expect(batch[0].args.p_objects).toEqual(expect.arrayContaining([
   expect.objectContaining({guid:guid1}),expect.objectContaining({guid:guid2})]));
 });
});

describe("POS0c owner-facing operational health",()=>{
 it("preserves unrelated failure categories and clears only recovered operational errors",async()=>{
  const f=operationalDb();
  f.setHealth("timeout"); // another Toast family has an independent failure
  f.setStates({stock_inventory:{error:"rate_limited",next_at:"2026-10-24T19:00:00Z"}});
  await reconcileToastOperationalHealth(f.db,s);
  expect(f.health()).toBe("timeout|operational:stock_inventory:rate_limited");
  expect(f.healthWrites).toContainEqual(expect.objectContaining({
   business_id:s.businessId,restaurant_guid:s.restaurantGuid,
   last_failure_category:"timeout|operational:stock_inventory:rate_limited"}));
  f.setStates({stock_inventory:{error:null,next_at:"2026-10-24T19:00:00Z"}});
  await reconcileToastOperationalHealth(f.db,s);
  expect(f.health()).toBe("timeout"); // don't clear a sales/roster failure
  f.setHealth("operational:cash_entries_today:timeout");
  await reconcileToastOperationalHealth(f.db,s);
  expect(f.health()).toBeNull();
 });
 it("reasserts a still-pending source failure after another phase cleared the health row",async()=>{
  const f=operationalDb();
  f.setStates({ordering_schedule:{error:"invalid_response",next_at:"2026-10-24T19:00:00Z"}});
  await reconcileToastOperationalHealth(f.db,s);
  expect(f.health()).toBe("operational:ordering_schedule:invalid_response");
  f.setHealth(null); // a successful labor sync writes the same health row
  await reconcileToastOperationalHealth(f.db,s);
  expect(f.health()).toBe("operational:ordering_schedule:invalid_response");
 });
});

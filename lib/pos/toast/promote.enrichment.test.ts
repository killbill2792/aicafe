import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({rebuild:vi.fn(),daily:vi.fn()}));
vi.mock("@/lib/pos/salesFactRollups",()=>({rebuildSalesFactRollups:mocks.rebuild}));
vi.mock("@/lib/pos/rollup",()=>({recomputeDailyRollup:mocks.daily}));
import {promoteVerifiedToastDay} from "./promote";
import type {SupabaseClient} from "@supabase/supabase-js";

const guid="00000000-0000-4000-8000-000000000001";
const employeeGuid="00000000-0000-4000-8000-000000000002";
const linkedGuid="00000000-0000-4000-8000-000000000003";
const p={businessId:guid,locationId:guid,restaurantGuid:guid,businessDate:"2026-08-22",checksum:"a".repeat(64),confirmPromotion:true as const};
function fixture(changed=false){
 const fields:Record<string,unknown[]>={};
 const writes:Record<string,unknown>[]=[];
 const from=(table:string)=>{
  const filters:Record<string,unknown>={};
  const chain={
   select:()=>chain,eq:(key:string,value:unknown)=>{(fields[table]??=[]).push([key,value]);filters[key]=value;return chain;},
   update:(value:Record<string,unknown>)=>{if(table==="orders")writes.push(value);return chain;},
   then:(resolve:(value:{data:unknown[];error:null})=>unknown)=>{
    const data=table==="employees"?[]:table==="toast_employee_directory"?
      [{employee_guid:employeeGuid,linked_employee_id:linkedGuid}]:
      table==="orders"?[{net_sales_cents:100}]:[];
    return Promise.resolve({data,error:null}).then(resolve);
   },
   single:async()=> {
    if(table==="toast_pilot_days")return {data:changed||filters.snapshot_sha256!==p.checksum||filters.state!=="promoted"?
      null:{orders_snapshot:[{posOrderId:`toast:${guid}:${guid}`,posEmployeeId:employeeGuid,lines:[]}]},error:null};
    if(table==="orders")return {data:{id:guid},error:null};
    if(table==="businesses")return {data:{timezone:"America/Los_Angeles"},error:null};
    return {data:null,error:null};
   },
   maybeSingle:async()=>({data:table==="daily_rollups"?{net_sales_cents:100}:null,error:null})
  };return chain;
 };
 const db={rpc:vi.fn(async()=>({data:1,error:null})),from} as unknown as SupabaseClient;
 return {db,fields,writes};
}
describe("guarded Toast fact enrichment",()=>{
 it("uses checksum-pinned promoted snapshot and owner-approved roster identity",async()=>{
  mocks.rebuild.mockReset();mocks.daily.mockReset();
  const {db,fields,writes}=fixture();
  const result=await promoteVerifiedToastDay(db,p);
  expect(result.ordersPromoted).toBe(1);
  expect(fields.toast_pilot_days).toContainEqual(["snapshot_sha256",p.checksum]);
  expect(fields.toast_pilot_days).toContainEqual(["state","promoted"]);
  expect(fields.toast_employee_directory).toContainEqual(["business_id",p.businessId]);
  expect(fields.toast_employee_directory).toContainEqual(["restaurant_guid",p.restaurantGuid]);
  expect(writes).toMatchObject([{employee_id:linkedGuid}]);
  expect(mocks.rebuild).toHaveBeenCalledTimes(1);
 });
 it("rejects restaged or changed snapshots before touching canonical enrichment",async()=>{
  const {db,writes}=fixture(true);
  await expect(promoteVerifiedToastDay(db,p)).rejects.toThrow();
  expect(writes).toHaveLength(0);
 });
});
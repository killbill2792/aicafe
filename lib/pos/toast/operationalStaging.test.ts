import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const calls=vi.hoisted(()=>({roster:vi.fn(),catalog:vi.fn()}));
vi.mock("./adapter",()=>({createToastAdapter:()=>({
 fetchEmployeeRosterFacts:calls.roster,fetchCatalogFacts:calls.catalog
})}));
import {stageToastRoster,stageToastCatalog} from "./operationalStaging";
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

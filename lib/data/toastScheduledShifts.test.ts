import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
import {readToastPlannedShifts} from "./toastScheduledShifts.server";

const cafe="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const restaurant="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const location="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const employee="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
function db(){
 const scopeChecks:string[]=[];
 const sources:Record<string,Record<string,unknown>[]> = {
  pos_scheduled_shifts:[
   {business_id:cafe,location_id:location,external_shift_id:"toast-shift-1",
    external_employee_id:employee,scheduled_start:"2026-10-27T18:00:00Z",
    scheduled_end:"2026-10-27T20:00:00Z"},
   {business_id:cafe,location_id:location,external_shift_id:"toast-shift-old",
    external_employee_id:employee,scheduled_start:"2026-10-21T18:00:00Z",
    scheduled_end:"2026-10-21T20:00:00Z"}
  ],
  toast_location_mappings:[{business_id:cafe,location_id:location,restaurant_guid:restaurant}],
  toast_employee_directory:[{business_id:cafe,restaurant_guid:restaurant,
   employee_guid:employee,display_name:"Maria"}],
 };
 const conn={from(table:string){
  let scoped:string|null=null;
  const chain={
   select:()=>chain,
   eq:(field:string,value:unknown)=>{if(field==="business_id"){scopeChecks.push(table);scoped=String(value);}return chain;},
   gte:()=>chain,lte:()=>chain,order:()=>chain,limit:()=>chain,
   then:(cb:(value:{data:Record<string,unknown>[];error:null})=>unknown)=>
    Promise.resolve({data:(sources[table]??[]).filter(row=>row.business_id===scoped),error:null}).then(cb),
  };
  return chain;
 }};
 return {conn:conn as unknown as SupabaseClient,scopeChecks};
}
describe("Toast planned shifts never become wages",()=>{
 it("shows café-local scheduled hours as separate un-paid source evidence",async()=>{
  const f=db();
  const rows=await readToastPlannedShifts(f.conn,cafe,"2026-10-26","2026-11-01",
   "America/Los_Angeles");
  expect(rows).toEqual([{id:"toast-shift-1",employeeName:"Maria",
   locationId:location,source:"toast",paid:false,
   start:"2026-10-27T18:00:00Z",end:"2026-10-27T20:00:00Z"}]);
  expect(f.scopeChecks).toEqual([
   "pos_scheduled_shifts","toast_location_mappings","toast_employee_directory"]);
 });
});

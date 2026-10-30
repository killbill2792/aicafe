import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {queueStaleToastLaborRollups} from "./staleLaborRecovery";

const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const time=new Date("2026-10-30T19:00:00Z"),day="2026-10-14";
const staged=[{restaurant_guid:"r",external_time_entry_id:"one",
 clock_in:"2026-10-15T01:00:00Z",clock_out:"2026-10-15T03:00:00Z",
 hourly_wage_cents:null,provider_regular_hours:2,provider_overtime_hours:0,
 deleted:false}];
const canonical=[{pos_timecard_id:"toast:r:one",
 clock_in:staged[0].clock_in,clock_out:staged[0].clock_out,
 hourly_wage_cents:0,wage_source:"pos",source_type:"connected_pos",
 provider_regular_hours:2,provider_overtime_hours:0}];
function db(facts=staged,shifts=canonical,rollupMissing=true){
 const saved=new Set<string>(),upserts=vi.fn(async(value:{business_date:string},
   opts:{ignoreDuplicates:boolean})=>{
    expect(opts.ignoreDuplicates).toBe(true);
    saved.add(value.business_date);
    return {error:null};
 });
 const from=(table:string)=>{
  const q={select:()=>q,eq:()=>q,gte:()=>q,lt:()=>q,gt:()=>q,or:()=>q,
   in:()=>q,order:()=>q,
   limit:async()=>({data:table==="daily_rollups"&&rollupMissing?[{business_date:day}]:
    table==="toast_day_status"?[{business_date:day}]:[],error:null}),
   range:async(a:number,b:number)=>({data:(table==="toast_labor_entries"?facts:
    table==="timecards"?shifts:[]).slice(a,b+1),error:null}),
   upsert:upserts,
  };return q;
 };
 return {db:{from} as never,upserts,saved};
}
describe("bounded repair of stale Toast labor cost rollups",()=>{
 it("queues a stale missing rollup once canonical Toast $0 wage is verified",async()=>{
  const f=db();
  expect(await queueStaleToastLaborRollups(f.db,business,"America/Los_Angeles",time))
   .toEqual([day]);
  expect(f.upserts).toHaveBeenCalledWith(expect.objectContaining({
   business_id:business,business_date:day,generation:expect.any(String)
  }),expect.objectContaining({onConflict:"business_id,business_date",ignoreDuplicates:true}));
  expect(f.saved.size).toBe(1);
  await queueStaleToastLaborRollups(f.db,business,"America/Los_Angeles",time);
  expect(f.saved.size).toBe(1);
 });
 it("does not queue a partially promoted or unlinked shift",async()=>{
  const f=db(staged,[]);
  expect(await queueStaleToastLaborRollups(f.db,business,"America/Los_Angeles",time))
   .toEqual([]);
  expect(f.upserts).not.toHaveBeenCalled();
 });
 it("does not queue a day with no staged labor, or a rollup already recovered",async()=>{
  const missing=db([]);
  expect(await queueStaleToastLaborRollups(missing.db,business,"America/Los_Angeles",time))
   .toEqual([]);
  const recovered=db(staged,canonical,false);
  expect(await queueStaleToastLaborRollups(recovered.db,business,"America/Los_Angeles",time))
   .toEqual([]);
  expect(recovered.upserts).not.toHaveBeenCalled();
 });
});

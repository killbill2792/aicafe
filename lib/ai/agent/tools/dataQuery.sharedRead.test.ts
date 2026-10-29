import {describe,it,expect,vi,beforeEach} from "vitest";
const read=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/data/canonical/reads.server",()=>({readCanonicalView:read}));
vi.mock("server-only",()=>({}));
import {dataQueryTools} from "./dataQuery";
const business="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const db={} as never;
const input={view:"cv_orders",columns:["source","guest_count","business_date"],
 filters:null,group_by:null,metrics:null,date_from:"2026-10-17",
 date_to:"2026-10-20",order_by:null,limit:25};
describe("shared canonical row reader for unaggregated AI queries",()=>{
 beforeEach(()=>read.mockReset());
 it("uses the same view reader and café date scope as an owner screen",async()=>{
  read.mockResolvedValue({rows:[{source:"toast",status:"actual",guest_count:3,
   business_date:"2026-10-20"}],notes:[],empty:false,truncated:false,rowCount:1});
  const result=await dataQueryTools.query_data.execute(input,{db,businessId:business});
  expect(read).toHaveBeenCalledWith(db,business,"cv_orders",
   {dateFrom:"2026-10-17",dateTo:"2026-10-20"},25);
  expect(result).toMatchObject({source:"canonical_data",empty:false,sourceMix:{toast:1}});
  expect(result.rows).toEqual([{source:"toast",guest_count:3,business_date:"2026-10-20"}]);
 });
 it("does not hide recorded rows because they are incomplete",async()=>{
  read.mockResolvedValue({rows:[{source:"toast",status:"open",guest_count:null}],
   notes:[],empty:false,truncated:false,rowCount:1});
  const result=await dataQueryTools.query_data.execute(input,{db,businessId:business});
  expect(result.empty).toBe(false);
  expect(result.missing).toContain("incompleteEvidence");
 });
 it("a canonical read error is a failure and never becomes zero records",async()=>{
  read.mockResolvedValue({rows:[],notes:["source_read_failed"],empty:true,
   truncated:false,rowCount:0,error:"source_read_failed"});
  const result=await dataQueryTools.query_data.execute(input,{db,businessId:business});
  expect(result.error).toBe("source_read_failed");
  expect(result.missing).toContain("source_read_failed");
 });
});

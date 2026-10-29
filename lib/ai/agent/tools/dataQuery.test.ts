import {it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {dataQueryTools} from "./dataQuery";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function input(view="cv_sales_days"){return {view,columns:["business_date","net_sales_cents"],
 filters:null,group_by:["business_date"],metrics:[{fn:"sum",column:"net_sales_cents"}],
 date_from:"2026-10-01",date_to:"2026-10-10",order_by:null,limit:100};}
function testDb(rows:unknown[]=[],error:unknown=null){
 const rpc=vi.fn(async(_name:string,_params:unknown)=>({data:{rows,sourceMix:{app:1},
  truncated:false,rowCount:rows.length},error}));
 return {db:{rpc} as never,rpc};
}
it("does not issue an RPC for unknown views, columns or SQL injection fields",async()=>{
 const f=testDb(),ctx={db:f.db,businessId:b};
 expect((await dataQueryTools.query_data.execute(input("private_tables"),ctx)).error).toBe("invalid_query");
 expect((await dataQueryTools.query_data.execute({...input(),columns:["password"]},ctx)).error)
  .toBe("column_not_allowed");
 expect((await dataQueryTools.query_data.execute({...input(),raw_sql:"drop table businesses"},ctx)).error)
  .toBe("invalid_query");
 expect(f.rpc).not.toHaveBeenCalled();
});
it("always supplies the authenticated café identity and grouped metrics",async()=>{
 const f=testDb([{business_date:"2026-10-01",sum_net_sales_cents:1250}]);
 const result=await dataQueryTools.query_data.execute(input(),{db:f.db,businessId:b});
 expect(result.empty).toBe(false);
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({
  p_business_id:b,p_view:"cv_sales_days",p_group_by:["business_date"],
  p_metrics:[{fn:"sum",column:"net_sales_cents"}],p_limit:100
 }));
 expect(result.rows).toEqual([{business_date:"2026-10-01",sum_net_sales_cents:1250}]);
});
it("empty and failed queries are explicit, not invented zero totals",async()=>{
 const f=testDb();
 const result=await dataQueryTools.query_data.execute(input(),{db:f.db,businessId:b});
 expect(result.empty).toBe(true);
 const bad=testDb([],{message:"sensitive"});
 const failed=await dataQueryTools.query_data.execute(input(),{db:bad.db,businessId:b});
 expect(failed.error).toBe("source_read_failed");
 expect(JSON.stringify(failed)).not.toContain("sensitive");
});
it("reads retained history without arbitrary caps and still enforces range and row bounds",async()=>{
 const f=testDb(),ctx={db:f.db,businessId:b};
 expect((await dataQueryTools.query_data.execute({...input(),date_from:"2030-10-11"},ctx)).error)
  .toBe("invalid_date_range");
 expect((await dataQueryTools.query_data.execute({...input(),date_to:"2030-10-11"},ctx)).error)
  .toBeUndefined();
 expect((await dataQueryTools.query_data.execute({...input(),limit:101},ctx)).error)
  .toBe("invalid_query");
 expect(f.rpc).toHaveBeenCalledTimes(1);
});

it("does not certify open or estimated facts as complete",async()=>{
 const rpc=vi.fn(async()=>({data:{
   rows:[{status:"open",business_date:"2026-10-03",amount_cents:null}],
   sourceCount:1,hasIncomplete:true,truncated:false,sourceMix:{toast:1}
 },error:null}));
 const x=await dataQueryTools.query_data.execute(input(),{
   db:{rpc} as never,businessId:b});
 expect(x.empty).toBe(false);
 expect(x.missing).toContain("incompleteEvidence");
});
it("an aggregate null over no matching facts reports empty",async()=>{
 const rpc=vi.fn(async()=>({data:{
   rows:[{sum_net_sales_cents:null}],sourceCount:0,hasIncomplete:false,
   truncated:false,sourceMix:{}
 },error:null}));
 const x=await dataQueryTools.query_data.execute(input(),{
   db:{rpc} as never,businessId:b});
 expect(x.empty).toBe(true);
 expect(x.missing).toContain("empty");
});
it("defaults to a compact 50-row result when the model gives no limit",async()=>{
 const f=testDb([{business_date:"2026-10-01",sum_net_sales_cents:1}]);
 await dataQueryTools.query_data.execute({...input(),limit:null},{db:f.db,businessId:b});
 expect(f.rpc).toHaveBeenCalledWith("ai_query_view",expect.objectContaining({p_limit:50}));
});

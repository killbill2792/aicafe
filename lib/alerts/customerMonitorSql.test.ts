import {describe,it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocked=vi.hoisted(()=>({runSql:vi.fn(),trust:vi.fn()}));
vi.mock("@/lib/ai/research/tools.server",()=>({runSql:mocked.runSql}));
vi.mock("@/lib/data/toastDayTrust.server",()=>({readToastDayTrust:mocked.trust}));
import {customerMonitorStatement,readCustomerMonitorSql} from "./customerMonitorSql.server";
const businessId="10000000-0000-4000-8000-000000000001",ownerId="20000000-0000-4000-8000-000000000001";
const request={view:"cv_toast_records" as const,group_by:null,
 metrics:[{fn:"count" as const,column:"source_ref"},{fn:"sum" as const,column:"data.aiCafeCustomer.netSalesCents"}],
 filters:[{column:"record_type",op:"=",value:"check"},{column:"counts_in_sales",op:"=",value:true}],
 date_from:"2026-11-01",date_to:"2026-11-07",limit:1 as const};
const coverage={scope:"all_eligible_checks_in_period",eligibleChecks:10,linkedChecks:8,namedChecks:3,
 knownMoneyChecks:10,linkedKnownMoneyChecks:8,recordedNetCents:12000,linkedRecordedNetCents:9500,
 expectedLocationDays:7,completeLocationDays:7,complete:true};
const data={rows:[{count_source_ref:10,"sum_data.aiCafeCustomer.netSalesCents":12000}],
 source_count:10,incomplete:false,current_day:false,coverage};
function scope(owner=ownerId){
 const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),
  order:vi.fn().mockReturnThis(),limit:vi.fn().mockReturnThis(),maybeSingle:vi.fn(async()=>({data:owner?{user_id:owner}:null,error:null}))};
 const db={from:vi.fn(()=>query)};
 return {db:db as never,businessId,query};
}
beforeEach(()=>{vi.clearAllMocks();mocked.runSql.mockResolvedValue({ok:true,rows:[data]});mocked.trust.mockResolvedValue({quality:[],notes:[]});});
describe("customer monitor SQL source",()=>{
 it("uses bounded current-source SQL and preserves the unfiltered denominator",()=>{
  const sql=customerMonitorStatement(request,businessId);
  expect(sql).toContain("public.toast_records_for(");
  expect(sql).toContain("ARRAY['check']::text[]");
  expect(sql).toContain("business_id='"+businessId+"'::uuid");
  expect(sql).toContain("customer_query_coverage(");
  expect(sql).toContain("jsonb_typeof(data #> '{aiCafeCustomer,netSalesCents}')='number'");
  expect(sql).toContain("limit 2");
  expect(()=>customerMonitorStatement({...request,metrics:[{fn:"count",column:"source_ref); select 1;--"}]},businessId)).toThrow();
  expect(()=>customerMonitorStatement({...request,filters:[{column:"record_type",op:"=",value:"check';select 1;--"}]},businessId)).toThrow();
 });
 it("runs the statement as the scoped café owner and retains verified coverage",async()=>{
  const ctx=scope();
  const result=await readCustomerMonitorSql(request,ctx);
  expect(ctx.query.eq).toHaveBeenCalledWith("business_id",businessId);
  expect(ctx.query.eq).toHaveBeenCalledWith("role","owner");
  expect(mocked.runSql).toHaveBeenCalledWith({db:ctx.db,businessId,ownerUserId:ownerId},expect.stringContaining("customer_query_coverage"));
  expect(result).toMatchObject({rows:data.rows,customerCoverage:coverage,missing:[],truncated:false});
 });
 it("never converts a missing owner or SQL failure to an observed zero",async()=>{
  expect(await readCustomerMonitorSql(request,scope(""))).toMatchObject({error:"source_read_failed"});
  expect(mocked.runSql).not.toHaveBeenCalled();
  mocked.runSql.mockResolvedValueOnce({ok:false,error:"database error"});
  expect(await readCustomerMonitorSql(request,scope())).toMatchObject({error:"source_read_failed",rows:[]});
 });
 it("keeps incomplete periods and truncated groups from certifying recovery",async()=>{
  mocked.runSql.mockResolvedValueOnce({ok:true,rows:[{...data,rows:[...data.rows,...data.rows],current_day:true}]});
  mocked.trust.mockResolvedValueOnce({quality:["missing_day"],notes:["source_review"]});
  expect(await readCustomerMonitorSql(request,scope())).toMatchObject({truncated:true,missing:["currentDayIncomplete","missing_day","result_truncated"],notes:["source_review"]});
 });
});

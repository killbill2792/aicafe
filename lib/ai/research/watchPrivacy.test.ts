import {it,expect,vi} from "vitest";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
import {describeDatabase,runSql} from "./tools.server";
import {verifyResearchInvestigationTurn} from "@/lib/ai/supervisor/routines/investigation";
vi.mock("server-only",()=>({}));
const watchScope=(rpc:ReturnType<typeof vi.fn>)=>({db:{rpc} as never,businessId:"cafe",ownerUserId:"owner",watch:true as const});
it("exposes only aggregate operational fields in Watch discovery",async()=>{
 const rpc=vi.fn();
 const scope=watchScope(rpc);
 const discovery=JSON.stringify(await describeDatabase(scope,null));
 expect(discovery).toContain("daily_rollups");
 expect(discovery).not.toContain("employee_pay_period_facts");
 expect((await describeDatabase(scope,["staff_messages"])).rows).toEqual([]);
 expect(rpc).not.toHaveBeenCalled();
});
it("denies sensitive relations, aliases, nested raw payloads and whole rows before executing",async()=>{
 const rpc=vi.fn().mockResolvedValue({data:{ok:true,rows:[{total:900}]},error:null});
 const scope=watchScope(rpc);
 for(const sql of [
  "select sum(wage_cents) from employees",
  "select count(*) from public.staff_messages",
  "select count(*) from toast_raw_records",
  "select min(data::text) from cv_sales_days",
  "select min(source_ref) from cv_sales_days",
  "select min(d::text) from daily_rollups d",
  "with staff_messages as (select count(*) from daily_rollups) select count(*) from public.staff_messages",
  "select count(*) from cv_sales_days where exists(select 1 from employees)",
 ])expect((await runSql(scope,sql)).ok).toBe(false);
 expect(rpc).not.toHaveBeenCalled();
 expect((await runSql(scope,"select sum(net_sales_cents) as total from public.daily_rollups")).ok).toBe(true);
 expect(rpc).toHaveBeenCalledTimes(1);
});
it("does not change the authenticated owner SQL path",async()=>{
 const rpc=vi.fn().mockResolvedValue({data:{ok:true,rows:[]},error:null});
 await runSql({db:{rpc} as never,businessId:"cafe",ownerUserId:"owner"},"select count(*) from employees");
 expect(rpc).toHaveBeenCalledOnce();
});
it("never authorizes an unreproduced customer trend using an unrelated SQL read",()=>{
 const receipt={source:"sql_research",period:null,missing:[],tool:"run_sql"};
 const turn={text:"Customer visits changed.",endReason:"complete",unverified:[],toolInvocations:[{name:"run_sql",result:receipt}],results:[receipt]} as unknown as AgentTurn;
 const expected={sourceType:"alert" as const,sourceId:"alert",kind:"business_anomaly" as const};
 const claim={sourceType:expected.sourceType,sourceId:expected.sourceId,incidentKind:expected.kind,missing:[]};
 const selectors={family:"customer_trend",subject:"returning_visit_share",unit:"ratio",current:0.3,previous:0.4};
 const proof={key:selectors.subject,unit:selectors.unit,current:0.3,previous:0.4,active:true};
 for(const customerTrendProof of [null,{...proof,active:false},{...proof,current:0.2},{...proof,key:"other"}]){
 expect(verifyResearchInvestigationTurn(turn,expected,[],{...claim,selectors,customerTrendProof})).toEqual({ok:false,reason:"evidence_incomplete"});
 }
 expect(verifyResearchInvestigationTurn(turn,expected,[],{...claim,selectors,customerTrendProof:proof}).ok).toBe(true);
});

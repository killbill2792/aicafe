import {it,expect,vi} from "vitest";
import type {AgentTurn} from "@/lib/ai/agent/loop.server";
import {describeDatabase,runSql} from "./tools.server";
import {verifyResearchInvestigationTurn} from "@/lib/ai/supervisor/routines/investigation";
vi.mock("server-only",()=>({}));
it("does not restrict Luna's SQL in any mode",async()=>{
 const rpc=vi.fn().mockResolvedValue({data:{ok:true,rows:[]},error:null});
 const scope={db:{rpc} as never,businessId:"cafe",ownerUserId:"owner"};
 await runSql(scope,"select count(*) from employees");
 await runSql(scope,"with x as (select 1) select * from x");
 expect(rpc).toHaveBeenCalledTimes(2);
 expect(rpc).toHaveBeenCalledWith("supervisor_research_sql",expect.objectContaining({p_sql:"select count(*) from employees"}));
 void describeDatabase;
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

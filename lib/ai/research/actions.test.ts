import {isResearchIntegrationReadTool} from "./integrationReads";
import {describe,expect,it,vi} from "vitest";
import type {AgentProvider} from "@/lib/ai/agent/loop.server";

const execute=vi.fn();
vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/agent/tools",async importOriginal=>({
  ...(await importOriginal<typeof import("@/lib/ai/agent/tools")>()),
  executeAgentTool:(...a:unknown[])=>execute(...a),
}));
const {runResearchTurn,isResearchActionTool}=await import("./turn.server");

const done={type:"response.completed",response:{model:"m",usage:{input_tokens:1,output_tokens:1}}};
const call=(name:string,args:unknown,id:string)=>({type:"response.output_item.done",item:{type:"function_call",name,call_id:id,arguments:JSON.stringify(args)}});

describe("research turn action tools",()=>{
  it("offers only action tools, not reads or the old link tool",()=>{
    for(const n of ["propose_price_change","propose_gmail_action","propose_staff_question","draft_week_schedule","ask_owner"])expect(isResearchActionTool(n)).toBe(true);
    for(const n of ["get_sales","query_data","web_search","present_response","get_supervisor_permissions"])expect(isResearchActionTool(n)).toBe(false);
  });

  it("keeps scoped schedule, staff messages and saved events without restoring legacy metric readers",()=>{
    for(const name of ["get_events","get_schedule","get_week_schedule","get_staff_messages"])expect(isResearchIntegrationReadTool(name)).toBe(true);
    for(const name of ["get_sales","get_labor","get_profit","get_inventory","query_data","describe_data"])expect(isResearchIntegrationReadTool(name)).toBe(false);
  });

  it("runs an action through the existing executor, keeps its approval card, and lets the model retry after an error",async()=>{
    execute.mockReset();
    execute.mockRejectedValueOnce(new Error("employee not found"));
    execute.mockResolvedValueOnce({source:"staff_question",period:null,missing:[],draft:true,saved:false,proposalId:"p1"});
    const outputs:string[]=[];let step=0;
    const provider:AgentProvider=async function*(params){
      for(const item of params.input as {type?:string;output?:string}[])if(item.type==="function_call_output"&&item.output)outputs.push(item.output);
      expect((params.tools as {name:string}[]).map(t=>t.name)).toContain("propose_staff_question");
      step++;
      if(step===1){yield call("propose_staff_question",{employeeId:"wrong"},"c1");yield done;return;}
      if(step===2){yield call("propose_staff_question",{employeeId:"right"},"c2");yield done;return;}
      yield {type:"response.output_text.delta",delta:"Prepared the question for approval."};
      yield {type:"response.output_item.done",item:{type:"message",role:"assistant",content:[]}};
      yield done;
    };
    const context={ownerText:"ask Sam",locale:"en"} as never;
    const turn=await runResearchTurn({ownerText:"ask Sam about the missed break",cafeContext:"c",provider,
      scope:{db:{} as never,businessId:"b",ownerUserId:"o"},
      actions:{context,definitions:[{name:"propose_staff_question"}]}});
    expect(turn.endReason).toBe("complete");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.parse(outputs[0]).error).toBeTruthy();           // the failure reached the model as data
    expect(turn.results.at(-1)).toMatchObject({draft:true,saved:false,proposalId:"p1"}); // card data survives for persistence
    expect(turn.text).toContain("approval");
  });
});

describe("staff question refusal",()=>{
  it("tells the model why the server declined, so it can explain or choose another way",async()=>{
    const {staffQuestionTools}=await import("@/lib/ai/agent/tools/staffQuestion");
    const input={sourceKind:"alert",sourceTaskId:"a1",employeeId:"0b0f1b4e-7b1e-4b8e-8f4e-0b0f1b4e7b1e",
      question:"Did you get your meal break?",reason:"alert",evidence:[{source:"timecards",asOf:"2026-11-21"}],
      followUpAfter:"2999-01-01T00:00:00Z"};
    const decline=(m:string)=>staffQuestionTools.propose_staff_question.execute(input,
      {staffQuestionPropose:async()=>{throw new Error(m);}} as never);
    expect(await decline("worker_not_on_current_published_shift")).toMatchObject({draft:false,reason:"worker_not_on_current_published_shift"});
    // Free-form messages (possible internals) are never passed on.
    expect((await decline("connect ECONNREFUSED 10.0.0.1:5432")).reason).toBeUndefined();
  });
});

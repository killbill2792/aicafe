import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {validateSupervisorFinal} from "./runSupervisorTurn.server";
import type {ToolEvidence,SupervisorToolCall} from "./toolRegistry.server";
import type {RequestedGoal} from "./requestScope";

const source={source:"operating_tasks" as const,identifier:"persisted_team_tasks",asOf:"2026-10-12"};
const cardSource={...source,identifier:"task:price:latte"};
const card={type:"task_card" as const,taskId:"price:latte",agent:"alex" as const,
  title:"Review price: Latte",status:"needs_owner" as const,
  href:"/operations?status=needs_you&agent=alex&task=price%3Alatte#selected-task",source:cardSource};
const goals=(domain:"team"|"overview"):RequestedGoal[]=>[{
  domain,period:"today",from:null,to:null,comparison_period:null,comparison_from:null,comparison_to:null,
}];
const final=(ids:string[]=[])=>({
  headline:"Here is the recorded picture",summary:"Based on the available café records",
  fact_ids:[],task_ids:ids,insight_ids:[],evidence_refs:[],
});
const result=(n:number,overview=false):ToolEvidence=>({
  status:"verified",coverage:{},missingInputs:[],estimatedInputs:[],
  data:overview?{focus:"today"}:{view:"tasks",filterStatus:"needs_you"},
  facts:[{id:overview?"t1:attention":"t1:needsYou",
    label:"Needs you",kind:"count",value:n,source}],
  tasks:n?[card]:[],insights:[],evidence:n?[source,cardSource]:[source],
});
const call=(overview=false):SupervisorToolCall=>overview
  ? {name:"get_cafe_overview",arguments:{focus:"today"},call_id:"t1"}
  : {name:"get_team",arguments:{status:"needs_you",view:"tasks",agent:"all",limit:5},call_id:"t1"};
describe("Persisted cards cannot disappear due to model-selected task_ids",()=>{
  it.each([false,true])("returns actual task cards even if final task_ids is empty (overview=%s)",overview=>{
    const evidence=result(1,overview),step=call(overview);
    const answer=validateSupervisorFinal(final(),[evidence],[step.name],"en",
      goals(overview?"overview":"team"),[step]);
    expect(answer.blocks).toContainEqual(card);
    expect(answer.evidence).toContainEqual(cardSource);
    const duplicate=validateSupervisorFinal(final(["price:latte"]),[evidence],[step.name],
      "en",goals(overview?"overview":"team"),[step]);
    expect(duplicate.blocks.filter(b=>b.type==="task_card")).toHaveLength(1);
  });
  it("returns grounded zero and natural no-task message for verified empty Team inbox",()=>{
    const step=call();
    const answer=validateSupervisorFinal(final(),[result(0)],["get_team"],"en",goals("team"),[step]);
    expect(answer.status).toBe("verified");
    expect(answer.blocks).toContainEqual(expect.objectContaining({type:"count",value:0}));
    expect(answer.blocks).toContainEqual({type:"text",text:"No AI Team tasks currently need your attention."});
  });
});

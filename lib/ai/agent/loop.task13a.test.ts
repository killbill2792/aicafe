import {describe,expect,it,vi} from "vitest";

const schedule=vi.hoisted(()=>({
  preview:vi.fn(),absence:vi.fn(),ownerSavings:vi.fn(),
}));
vi.mock("@/lib/actions/oliviaPlanning",()=>({
  previewOliviaWeek:schedule.preview,
  previewOliviaAbsenceWhatIf:schedule.absence,
  previewOliviaOwnerSavings:schedule.ownerSavings,
}));
import {runAgentTurn,type AgentProvider} from "./loop.server";
import type {AgentToolContext} from "./tools";

const done={type:"response.completed",response:{usage:{
  input_tokens:30,output_tokens:15,input_tokens_details:{cached_tokens:0},
}}};
const tool=(name:string,args:object,id:string)=>({
  type:"response.output_item.done",item:{
    type:"function_call",name,arguments:JSON.stringify(args),call_id:id,
  },
});
const message=(value:string)=>({type:"response.output_text.delta",delta:value});
const context=():AgentToolContext=>({
  locale:"en",asOf:"2026-11-03",timezone:"America/Los_Angeles",
  tools:{
    getProfitability:async()=>({available:false,value:null,
      quality:{level:"low",missingInputs:["unavailable"],estimatedInputs:[],staleInputs:[]}}),
    getSalesTrend:async()=>({available:false,value:null,
      quality:{level:"low",missingInputs:["unavailable"],estimatedInputs:[],staleInputs:[]}}),
    getMenuCatalog:async()=>({available:true,value:[],
      quality:{level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]}}),
  },
});
const shift={employeeId:"11111111-1111-4111-8111-111111111111",
 locationId:"loc",startAt:"2026-11-09T16:00:00.000Z",
 endAt:"2026-11-09T18:00:00.000Z",paidMinutes:120};

describe("Task 13a registered Supervisor staffing conversation",()=>{
 it("answers a natural owner day-off hypothetical with the REAL registered tool and no writes",async()=>{
  schedule.absence.mockReset().mockResolvedValue({
    ok:true,period:{from:"2026-11-09",to:"2026-11-15"},employeeName:"Sarah Jones",
    absentDate:"2026-11-10",assumptions:["Scenario only"],
    warnings:[],baseline:{completeCoverage:true,cost:{cashWagesCents:25000},
      gaps:[],shiftCount:5,status:"feasible"},
    alternative:{completeCoverage:false,cost:{cashWagesCents:null},
      gaps:[{reason:"no_confirmed_availability"}],shiftCount:4,status:"infeasible"},
    changeInModeledCashWagesCents:null,laborCostDifferenceKnown:false,
  });
  const requests:Record<string,unknown>[]=[];
  const provider:AgentProvider=async function* (request){
    requests.push(request);
    if(requests.length===1)yield tool("simulate_staff_absence",{
      week_start:null,employee_name:"Sarah",weekday:2},"absence-1");
    else yield message("Sarah's proposed absence leaves an uncovered shift. Nothing was saved.");
    yield done;
  };
  const result=await runAgentTurn({
    ownerText:"What if Sarah cannot work Tuesday next week?",context:context(),provider,
  });
  expect(result.endReason).toBe("complete");
  expect(result.tools).toContain("simulate_staff_absence");
  expect(result.results).toEqual(expect.arrayContaining([
    expect.objectContaining({hypothetical:true,saved:false,absentDate:"2026-11-10",
      alternative:expect.objectContaining({completeCoverage:false})}),
  ]));
  expect(schedule.absence).toHaveBeenCalledExactlyOnceWith({
    week:"2026-11-09",employeeName:"Sarah",weekday:2});
  expect(result.text).toContain("Nothing was saved");
  expect(requests).toHaveLength(2);
 });
 it("absorbs an owner cost follow-up in the SAME turn and only previews alternatives",async()=>{
  schedule.absence.mockReset().mockResolvedValue({
    ok:true,period:{from:"2026-11-09",to:"2026-11-15"},
    employeeName:"Sarah Jones",absentDate:"2026-11-10",
    assumptions:["Scenario only"],warnings:[],
    baseline:{completeCoverage:true,cost:{cashWagesCents:25000},gaps:[],shiftCount:5,status:"feasible"},
    alternative:{completeCoverage:true,cost:{cashWagesCents:26500},gaps:[],shiftCount:5,status:"feasible"},
    changeInModeledCashWagesCents:1500,laborCostDifferenceKnown:true,
  });
  const best={objective:"cash",completeCoverage:true,hardConstraintsSatisfied:true,
    shifts:[shift],gaps:[],ownerMinutes:0,legalReview:"unverified_profile",
    cost:{cashWagesCents:25000,loadedPayrollCents:null,
      costState:"estimate",missingWageEmployeeIds:[]}};
  schedule.preview.mockReset().mockResolvedValue({ok:true,notices:[],
    locations:{loc:"America/Los_Angeles"},
    plan:{status:"feasible",horizonEnd:"2026-11-15",best,scenarios:[best],
      warnings:[],proof:"complete_candidate_solution"}});
  const requests:Record<string,unknown>[]=[];
  const provider:AgentProvider=async function* (request){
    requests.push(request);
    if(requests.length===1)yield tool("simulate_staff_absence",{
      week_start:null,employee_name:"Sarah",weekday:2},"absence-1");
    else if(requests.length===2)yield tool("draft_week_schedule",{
      week_start:null,purpose:"cash_preview"},"compare-2");
    else yield message("I compared the alternatives. No roster or availability was changed.");
    yield done;
  };
  const ownerFollowUp={id:"77777777-7777-4777-8777-777777777777",
    text:"What about a cheaper roster without saving it?"};
  let unread=true;
  const proposeStaff=vi.fn();
  const ctx={...context(),proposals:{proposePriceChange:vi.fn(),proposeStaff}};
  const result=await runAgentTurn({
    ownerText:"What if Sarah can't work Tuesday?",context:ctx,provider,
    takeFollowUps:async()=>{
      if(!unread)return [];
      unread=false;
      return [ownerFollowUp];
    },
  });
  expect(result.endReason).toBe("complete");
  expect(result.absorbedOwnerMessageIds).toEqual([ownerFollowUp.id]);
  expect(result.tools).toEqual(["simulate_staff_absence","draft_week_schedule"]);
  expect(requests).toHaveLength(3);
  expect(JSON.stringify(requests[1].input)).toContain(ownerFollowUp.text);
  expect(result.results).toEqual(expect.arrayContaining([
    expect.objectContaining({previewOnly:true,approvalTool:"not_created",saved:false}),
  ]));
  expect(proposeStaff).not.toHaveBeenCalled();
  expect(result.text).toContain("No roster or availability was changed");
 });
});

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
    week:"2026-11-09",employeeName:"Sarah",weekday:2,selectedEmployeeIds:[]});
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

 it("delivers a single natural-language roster request with Tuesday absence and ONE approval card",async()=>{
  const sarahAway={employeeName:"Sarah Jones",absentDate:"2026-11-10",saved:false};
  schedule.preview.mockReset().mockResolvedValue({
   ok:true,temporaryConstraint:sarahAway,locations:{loc:"America/Los_Angeles"},notices:[],
   plan:{status:"feasible",horizonEnd:"2026-11-15",warnings:[],scenarios:[],
    best:{objective:"balanced",completeCoverage:true,hardConstraintsSatisfied:true,
     gaps:[],shifts:[shift],cost:{cashWagesCents:2400,costState:"verified",
      loadedPayrollCents:null,missingWageEmployeeIds:[]}}}});
  const calls:Record<string,unknown>[]=[];
  const provider:AgentProvider=async function* (request){
   calls.push(request);
   if(calls.length===1)yield tool("draft_week_schedule",{
    week_start:null,purpose:"draft",
    temporary_absence:{employee_name:"Sarah",weekday:2}},"one-roster");
   else yield message("I prepared next week's roster without Sarah on Tuesday. Her saved availability is unchanged.");
   yield done;
  };
  const proposeStaff=vi.fn().mockResolvedValue({proposalId:"22222222-2222-4222-8222-222222222222",
   revision:1,capabilityId:"olivia.staff_propose_schedule.v2"});
  const result=await runAgentTurn({
   ownerText:"Make next week's schedule but keep Sarah off Tuesday",
   context:{...context(),proposals:{proposePriceChange:vi.fn(),proposeStaff}},
   provider,
  });
  expect(result.endReason).toBe("complete");
  expect(result.tools).toEqual(["draft_week_schedule"]);
  expect(schedule.preview).toHaveBeenCalledExactlyOnceWith({
   week:"2026-11-09",temporaryAbsence:{
    employeeName:"Sarah",weekday:2,selectedEmployeeIds:[]}});
  expect(result.results).toEqual(expect.arrayContaining([
   expect.objectContaining({approvalTool:"existing_card_created",
    temporaryConstraint:sarahAway})]));
  expect(proposeStaff).toHaveBeenCalledExactlyOnceWith({
    name:"propose_schedule",input:{
      week_start:"2026-11-09",shifts:[expect.objectContaining({start:"08:00",end:"10:00"})],
    }});
  expect(result.text).toContain("saved availability is unchanged");
  expect(calls).toHaveLength(2);
 });

 /**
  * Reference acceptance, NOT a head-to-head Grok/Muse or live-model score.
  * Recorded Responses function_calls are an oracle: they exercise the real
  * Supervisor runtime, tool boundaries, solver result handling, approval
  * rules and overhead without a billable model or production data.
  * Report synthetic-loop p95 separately from real hosted-model p95.
  */
 it("passes 8 repeatable Grok/Muse-style staffing journeys and reports synthetic-loop p95",async()=>{
  const scenarios=[
   {id:"show-roster-first",owner:"Show next week's roster before asking me to approve anything.",
    purpose:"compare_only",objective:"balanced",preview:true,approval:false,covered:true,missingWages:false,absence:false},
   {id:"cost-conversation",owner:"Is there a cheaper option? Just compare costs for now.",
    purpose:"cash_preview",objective:"cash",preview:true,approval:false,covered:true,missingWages:false,absence:false},
   {id:"owner-time-conversation",owner:"Can I work less next week? Show me alternatives, don't change anything.",
    purpose:"owner_time_preview",objective:"owner_time",preview:true,approval:false,covered:true,missingWages:false,absence:false},
   {id:"balanced-approval",owner:"Prepare a balanced schedule for my approval.",
    purpose:"balanced",objective:"balanced",preview:false,approval:true,covered:true,missingWages:false,absence:false},
   {id:"low-wages-approval",owner:"Draft the lower cash wage schedule for approval.",
    purpose:"cash_cost",objective:"cash",preview:false,approval:true,covered:true,missingWages:false,absence:false},
   {id:"week-one-exception",owner:"Draft next week's roster, but Sarah is off Tuesday. Don't alter her availability.",
    purpose:"draft",objective:"balanced",preview:false,approval:true,covered:true,missingWages:false,absence:true},
   {id:"zero-workers",owner:"No one is available next week. Tell me the gaps, don't fake a schedule.",
    purpose:"draft",objective:"balanced",preview:false,approval:false,covered:false,missingWages:false,absence:false},
   {id:"unknown-payroll",owner:"Show a roster comparison, but we don't have wage information yet.",
    purpose:"compare_only",objective:"balanced",preview:true,approval:false,covered:true,missingWages:true,absence:false},
  ] as const;
  const durations:number[]=[];
  let turns=0;
  for(const scenario of scenarios){
   for(let repetition=0;repetition<4;repetition++){
    schedule.preview.mockReset();
    const best={objective:scenario.objective,completeCoverage:scenario.covered,
     hardConstraintsSatisfied:scenario.covered,
     shifts:scenario.covered?[shift]:[],gaps:scenario.covered?[]:[{
      reason:"no_confirmed_availability",startAt:"2026-11-09T16:00:00.000Z",
     }],
     ownerMinutes:scenario.objective==="owner_time"?0:60,
     legalReview:"unverified_profile",
     cost:{cashWagesCents:scenario.missingWages?null:2400,
      loadedPayrollCents:null,costState:scenario.missingWages?"unknown":"verified",
      missingWageEmployeeIds:scenario.missingWages?[shift.employeeId]:[]}};
    const temp=scenario.absence?{
     employeeName:"Sarah Jones",absentDate:"2026-11-10",saved:false}:null;
    schedule.preview.mockResolvedValue({ok:true,notices:[],
     locations:{loc:"America/Los_Angeles"},
     ...(temp?{temporaryConstraint:temp}:{}),
     plan:{status:scenario.covered?"feasible":"infeasible",
      horizonEnd:"2026-11-15",warnings:[],scenarios:[best],best,
      proof:scenario.covered?"complete_candidate_solution":"incomplete_coverage"}});
    const approved=vi.fn().mockResolvedValue({
     proposalId:"33333333-3333-4333-8333-333333333333",
     revision:1,capabilityId:"olivia.staff_propose_schedule.v2"});
    let round=0;
    const model:AgentProvider=async function* (){
     round++;
     if(round===1)yield tool("draft_week_schedule",{
      week_start:null,purpose:scenario.purpose,
      temporary_absence:scenario.absence?{employee_name:"Sarah",weekday:2}:null,
     },"scenario-"+scenario.id+"-"+repetition);
     else yield message(scenario.covered
      ?"This is a planning preview only. Approval and delivery have not happened."
      :"The required hours are uncovered. No complete schedule can be proposed.");
     yield done;
    };
    const result=await runAgentTurn({
     ownerText:scenario.owner,context:{...context(),
      proposals:{proposePriceChange:vi.fn(),proposeStaff:approved}},provider:model});
    turns++;
    expect(result.endReason,scenario.id).toBe("complete");
    expect(result.tools,scenario.id).toEqual(["draft_week_schedule"]);
    expect(result.usage.modelCalls,scenario.id).toBe(2);
    expect(result.usage.toolCalls,scenario.id).toBe(1);
    expect(result.usage.latencyMs,scenario.id).toBeGreaterThanOrEqual(0);
    const data=result.results.find(x=>x.source==="olivia_schedule");
    expect(data,scenario.id).toBeDefined();
    expect(data,scenario.id).toMatchObject({
     saved:false,previewOnly:scenario.preview,
     completeCoverage:scenario.covered,
     approvalTool:scenario.approval?"existing_card_created":"not_created"});
    if(scenario.missingWages)expect(data?.laborCost).toMatchObject({
     cashWagesCents:null,missingWageEmployeeIds:[shift.employeeId]});
    if(scenario.absence)expect(data?.temporaryConstraint).toEqual(temp);
    if(!scenario.covered)expect(data).toMatchObject({
     proposalReady:false,missing:expect.arrayContaining(["approvalShiftLimitOrInvalidShift"]),
     gaps:expect.arrayContaining([expect.objectContaining({
      reason:"no_confirmed_availability"})]),
    });
    expect(approved,scenario.id).toHaveBeenCalledTimes(scenario.approval?1:0);
    expect(result.text).not.toMatch(/published|sent/i);
    durations.push(result.usage.latencyMs);
   }
  }
  const sorted=[...durations].sort((a,b)=>a-b);
  const p95Ms=sorted[Math.ceil(sorted.length*0.95)-1];
  expect(turns).toBe(32);
  // This is only synchronous recorded-provider runtime overhead, not hosted
  // model/network latency. Keep the bound generous under parallel CI load.
  expect(p95Ms).toBeLessThan(3000);
  console.info("TASK13A_OFFLINE_CONVERSATION_SCORECARD",JSON.stringify({
   cases:scenarios.length,repeatCount:4,passed:turns,total:turns,
   p95SyntheticLoopMs:p95Ms,hostedModelMeasured:false,
   competitorModelsMeasured:false,productionDataUsed:false,
  }));
 });
});

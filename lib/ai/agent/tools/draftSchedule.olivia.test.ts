import {describe,it,expect,vi,beforeEach} from "vitest";
const mocks=vi.hoisted(()=>({preview:vi.fn(),ownerSavings:vi.fn(),absence:vi.fn()}));
vi.mock("@/lib/actions/oliviaPlanning",()=>({previewOliviaWeek:mocks.preview,previewOliviaOwnerSavings:mocks.ownerSavings,previewOliviaAbsenceWhatIf:mocks.absence}));
import {draftScheduleTools} from "./draftSchedule";
import {staffProposalTools} from "./staffProposals";
import {askOwnerTools} from "./askOwner";
import {newResolveState,observeToolResult} from "../resolve";
import type {AgentToolContext} from "./index";
const ctx:AgentToolContext={asOf:"2026-11-03",timezone:"America/Los_Angeles",locale:"en",
 tools:{} as AgentToolContext["tools"]};
describe("Supervisor delegates to one Olivia scheduler",()=>{
 beforeEach(()=>{mocks.preview.mockReset();mocks.ownerSavings.mockReset();mocks.absence.mockReset();});
 it("previews Olivia and returns proposal-ready assignments without writing",async()=>{
  mocks.preview.mockResolvedValue({ok:true,locations:{location:"America/Los_Angeles"},
   notices:[],plan:{status:"feasible",horizonEnd:"2026-11-15",
   warnings:[],best:{completeCoverage:true,cost:{cashWagesCents:25000},
   gaps:[],shifts:[{employeeId:"11111111-1111-4111-8111-111111111111",
    locationId:"location",startAt:"2026-11-09T16:00:00.000Z",
    endAt:"2026-11-10T00:00:00.000Z",paidMinutes:450}]}}});
  const result=await draftScheduleTools.draft_week_schedule.execute({week_start:null,purpose:"draft"},ctx);
  expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({week:"2026-11-09"});
  expect(result).toMatchObject({draft:true,saved:false,proposalReady:true,
   approvalTool:"not_created",proposedShifts:[{
    employee_id:"11111111-1111-4111-8111-111111111111",date:"2026-11-09",
    start:"08:00",end:"16:00",break_minutes:30}]});
 });
 it("one draft creates exactly one owner card and returns the full week",async()=>{
  const id="11111111-1111-4111-8111-111111111111";
  const shifts=Array.from({length:14},(_,i)=>({
   employeeId:id,locationId:"location",startAt:new Date(Date.UTC(2026,10,9+Math.floor(i/2),i%2?18:16)).toISOString(),
   endAt:new Date(Date.UTC(2026,10,9+Math.floor(i/2),i%2?20:18)).toISOString(),paidMinutes:120
  }));
  mocks.preview.mockResolvedValue({ok:true,locations:{location:"America/Los_Angeles"},
   notices:[],plan:{status:"feasible",horizonEnd:"2026-11-15",warnings:[],
    best:{completeCoverage:true,cost:{cashWagesCents:30000},gaps:[],shifts}}});
  const proposeStaff=vi.fn().mockResolvedValue({proposalId:"22222222-2222-4222-8222-222222222222",
   revision:1,capabilityId:"olivia.staff_propose_schedule.v2"});
  const turnCtx={...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}};
  const result=await draftScheduleTools.draft_week_schedule.execute(
   {week_start:"2026-11-09",purpose:"draft"},turnCtx);
  expect(proposeStaff).toHaveBeenCalledTimes(1);
  expect(proposeStaff.mock.calls[0][0].input.shifts).toHaveLength(14);
  // Even if a model mistakenly calls the direct proposal tool afterward,
  // the per-turn guard reuses the same card without a second write.
  const repeated=await staffProposalTools.propose_schedule.execute({
   week_start:"2026-11-09",shifts:proposeStaff.mock.calls[0][0].input.shifts
  },turnCtx);
  expect(repeated).toMatchObject({proposalId:"22222222-2222-4222-8222-222222222222",
   duplicateSuppressed:true});
  expect(proposeStaff).toHaveBeenCalledTimes(1);
  expect(result.proposedShifts).toHaveLength(14);
  expect(result).toMatchObject({proposalId:"22222222-2222-4222-8222-222222222222",
   approvalTool:"existing_card_created"});
 });
 it("also reuses one card if direct propose_schedule runs first",async()=>{
  const id="11111111-1111-4111-8111-111111111111";
  mocks.preview.mockResolvedValue({ok:true,locations:{location:"America/Los_Angeles"},
   notices:[],plan:{status:"feasible",horizonEnd:"2026-11-15",warnings:[],
    best:{completeCoverage:true,cost:{cashWagesCents:2000},gaps:[],
     shifts:[{employeeId:id,locationId:"location",startAt:"2026-11-09T16:00:00Z",
      endAt:"2026-11-09T18:00:00Z",paidMinutes:120}]}}});
  const proposeStaff=vi.fn().mockResolvedValue({proposalId:"22222222-2222-4222-8222-222222222222",
   revision:1,capabilityId:"olivia.staff_propose_schedule.v2"});
  const turnCtx={...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}};
  await staffProposalTools.propose_schedule.execute({week_start:"2026-11-09",
   shifts:[{employee_id:id,date:"2026-11-09",start:"08:00",end:"10:00",break_minutes:0}]},turnCtx);
  const r=await draftScheduleTools.draft_week_schedule.execute(
   {week_start:"2026-11-09",purpose:"draft"},turnCtx);
  expect(proposeStaff).toHaveBeenCalledTimes(1);
  expect(r).toMatchObject({proposalId:"22222222-2222-4222-8222-222222222222"});
 });
 it("answers zero-pay owner savings with no approval proposal",async()=>{
  mocks.ownerSavings.mockResolvedValue({ok:true,
   period:{from:"2026-11-09",to:"2026-11-15"},
   baselineCashWagesCents:4000,withOwnerCashWagesCents:0,
   savingsCents:4000,ownerMinutes:120,completeCoverage:true,
   replacementRows:[{startAt:"2026-11-09T17:00:00Z",
    endAt:"2026-11-09T19:00:00Z",paidMinutes:120,
    baselineWorker:"Barista",baselineHourlyWageCents:2000}],
   assumptions:[],warnings:[],notices:[],locations:{main:"America/Los_Angeles"}});
  const proposeStaff=vi.fn();
  const result=await draftScheduleTools.draft_week_schedule.execute(
   {week_start:"2026-11-09",purpose:"owner_savings"},
   {...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}});
  expect(result).toMatchObject({source:"olivia_owner_what_if",
   savingsCents:4000,approvalTool:"not_created",saved:false});
  expect(proposeStaff).not.toHaveBeenCalled();
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.ownerSavings).toHaveBeenCalledExactlyOnceWith({week:"2026-11-09"});
 });
 it("honors foundation feature gates without retrying a parallel scheduler",async()=>{
  mocks.preview.mockResolvedValue({ok:false,error:"disabled"});
  const result=await draftScheduleTools.draft_week_schedule.execute({week_start:"2026-11-09",purpose:"draft"},ctx);
  expect(result).toMatchObject({saved:false,missing:["disabled"]});
  expect(mocks.preview).toHaveBeenCalledTimes(1);
 });

 it("returns recorded historical demand with contributing dates, not invented staffing levels",async()=>{
  mocks.preview.mockResolvedValue({ok:true,locations:{loc:"America/Los_Angeles"},
   notices:[],demandEvidence:{status:"available",source:"hourly_sales_rollup",
    basis:"observed_comparable_weekday_close_hours",targetWeekStart:"2026-11-09",
    historicalPeriod:{from:"2026-09-14",to:"2026-11-08"},
    readAt:"2026-11-09T17:00:00Z",sourceUpdatedAt:null,totalComparableHours:1,truncated:false,missing:[],
    hours:[{targetDate:"2026-11-09",hourLocal:9,locationId:"loc",
      observedAverageOrders:6,observedAverageNetSalesCents:900,
      sampleDays:["2026-10-26","2026-11-02"]}]},
   plan:{status:"feasible",horizonEnd:"2026-11-15",warnings:[],
    best:{completeCoverage:true,hardConstraintsSatisfied:true,
      cost:{cashWagesCents:1800,costState:"verified"},gaps:[],
      shifts:[{employeeId:"11111111-1111-4111-8111-111111111111",
        locationId:"loc",startAt:"2026-11-09T16:00:00Z",
        endAt:"2026-11-09T17:00:00Z",paidMinutes:60}]}}});
  const result=await draftScheduleTools.draft_week_schedule.execute(
    {week_start:"2026-11-09",purpose:"draft"},ctx);
  expect(result.demandEvidence).toMatchObject({status:"available",
   source:"hourly_sales_rollup",availableComparableHours:1,
   sampledHours:[{observedAverageOrders:6,sampleDays:["2026-10-26","2026-11-02"]}]});
  expect((result.demandEvidence as {note:string}).note).toContain("not a customer arrival forecast");
  expect(result.laborCost).toMatchObject({cashWagesCents:1800,costState:"verified"});
 });
 it("never issues a proposal card when confirmed coverage remains incomplete",async()=>{
  mocks.preview.mockResolvedValue({ok:true,locations:{loc:"America/Los_Angeles"},notices:[],
   demandEvidence:{status:"unavailable",missing:["hourlySalesUnavailable"],hours:[],
    historicalPeriod:{from:"2026-09-14",to:"2026-11-08"},readAt:"2026-11-09T17:00:00Z",
    source:"hourly_sales_rollup",basis:"observed_comparable_weekday_close_hours",sourceUpdatedAt:null,totalComparableHours:0,truncated:false},
   plan:{status:"infeasible",horizonEnd:"2026-11-15",warnings:[],
    best:{completeCoverage:false,hardConstraintsSatisfied:false,gaps:[{reason:"no_active_staff"}],
    cost:{cashWagesCents:null,costState:"unavailable"},
    shifts:[{employeeId:"11111111-1111-4111-8111-111111111111",
      locationId:"loc",startAt:"2026-11-09T16:00:00Z",
      endAt:"2026-11-09T17:00:00Z",paidMinutes:60}]}}});
  const proposeStaff=vi.fn();
  const r=await draftScheduleTools.draft_week_schedule.execute(
   {week_start:"2026-11-09",purpose:"draft"},
   {...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}});
  expect(proposeStaff).not.toHaveBeenCalled();
  expect(r).toMatchObject({proposalReady:false,approvalTool:"not_created",
   missing:expect.arrayContaining(["hourlySalesUnavailable"])});
 });

 it("lets the owner compare only solver-backed costs and reasons, not invented savings",async()=>{
  mocks.preview.mockResolvedValue({ok:true,locations:{location:"America/Los_Angeles"},
   notices:[],plan:{status:"feasible",horizonEnd:"2026-11-15",proof:"complete_candidate_solution",
    warnings:["not a global optimum"],best:{completeCoverage:true,
    hardConstraintsSatisfied:true,cost:{cashWagesCents:35000,costState:"estimate",
      loadedPayrollCents:null,missingWageEmployeeIds:["other"]},gaps:[],
    shifts:[{employeeId:"11111111-1111-4111-8111-111111111111",
      locationId:"location",startAt:"2026-11-09T16:00:00Z",
      endAt:"2026-11-09T18:00:00Z",paidMinutes:120}]},
    scenarios:[
      {objective:"cash",shifts:[{id:"first"}],gaps:[],completeCoverage:true,
       hardConstraintsSatisfied:true,ownerMinutes:0,
       cost:{cashWagesCents:35000,loadedPayrollCents:null,costState:"estimate",
        missingWageEmployeeIds:["other"]},legalReview:"unverified_profile"},
      {objective:"owner_time",shifts:[],gaps:[{reason:"no_active_staff"}],
       completeCoverage:false,hardConstraintsSatisfied:false,ownerMinutes:0,
       cost:{cashWagesCents:null,loadedPayrollCents:null,costState:"unavailable",
        missingWageEmployeeIds:["other"]},legalReview:"unverified_profile"},
    ]}});
  const result=await draftScheduleTools.draft_week_schedule.execute({
    week_start:"2026-11-09",purpose:"draft"},ctx);
  expect(result.scenarioAlternatives).toEqual([
    expect.objectContaining({objective:"cash",cashWagesCents:35000,
      loadedPayrollCents:null,costState:"estimate"}),
    expect.objectContaining({objective:"owner_time",completeCoverage:false,
      cashWagesCents:null}),
  ]);
  expect(result.solverProof).toBe("complete_candidate_solution");
  expect(result.explanationScope).toContain("not actual payroll");
 });

 it("honors a conversational request to minimize owner shifts using solver-verified alternatives",async()=>{
  const employeeId="11111111-1111-4111-8111-111111111111";
  const cashShift={employeeId,locationId:"loc",
    startAt:"2026-11-09T16:00:00Z",endAt:"2026-11-09T18:00:00Z",paidMinutes:120};
  const ownerTimeShift={...cashShift,startAt:"2026-11-09T18:00:00Z",
    endAt:"2026-11-09T20:00:00Z"};
  const cash={objective:"cash",shifts:[cashShift],gaps:[],completeCoverage:true,
    hardConstraintsSatisfied:true,ownerMinutes:120,
    cost:{cashWagesCents:2000,loadedPayrollCents:null,costState:"estimate",
      missingWageEmployeeIds:[]},legalReview:"unverified_profile"};
  const ownerTime={...cash,objective:"owner_time",ownerMinutes:0,
    shifts:[ownerTimeShift],cost:{...cash.cost,cashWagesCents:2500}};
  mocks.preview.mockResolvedValue({ok:true,locations:{loc:"America/Los_Angeles"},notices:[],
    plan:{status:"feasible",horizonEnd:"2026-11-15",scenarios:[cash,ownerTime],
      best:cash,warnings:[],proof:"complete_candidate_solution"}});
  const proposeStaff=vi.fn().mockResolvedValue({proposalId:"22222222-2222-4222-8222-222222222222",
    revision:1,capabilityId:"olivia.staff_propose_schedule.v2"});
  const result=await draftScheduleTools.draft_week_schedule.execute(
    {week_start:"2026-11-09",purpose:"owner_time"},
    {...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}});
  expect(result).toMatchObject({selectedObjective:"owner_time",requestedObjective:"owner_time",
    requestedObjectiveMet:true,laborCost:{cashWagesCents:2500},approvalTool:"existing_card_created"});
  expect(proposeStaff).toHaveBeenCalledExactlyOnceWith({
    name:"propose_schedule",
    input:{week_start:"2026-11-09",shifts:[expect.objectContaining({
      employee_id:employeeId,start:"10:00",end:"12:00"})]}
  });
 });
 it("explains an unavailable cheaper option instead of silently pretending it was selected",async()=>{
  const employeeId="11111111-1111-4111-8111-111111111111";
  const shift={employeeId,locationId:"loc",
    startAt:"2026-11-09T16:00:00Z",endAt:"2026-11-09T18:00:00Z",paidMinutes:120};
  const balanced={objective:"balanced",shifts:[shift],gaps:[],completeCoverage:true,
    hardConstraintsSatisfied:true,ownerMinutes:0,
    cost:{cashWagesCents:null,loadedPayrollCents:null,
      costState:"unavailable",missingWageEmployeeIds:[employeeId]},legalReview:"unverified_profile"};
  const cheaper={...balanced,objective:"cash",shifts:[],completeCoverage:false,
    hardConstraintsSatisfied:false,gaps:[{reason:"no_confirmed_availability"}]};
  mocks.preview.mockResolvedValue({ok:true,locations:{loc:"America/Los_Angeles"},notices:[],
   plan:{status:"feasible",horizonEnd:"2026-11-15",scenarios:[cheaper,balanced],
     best:balanced,warnings:[],proof:"complete_candidate_solution"}});
  const result=await draftScheduleTools.draft_week_schedule.execute(
    {week_start:"2026-11-09",purpose:"cash_cost"},ctx);
  expect(result).toMatchObject({requestedObjective:"cash",
    selectedObjective:"balanced",requestedObjectiveMet:false,
    laborCost:{cashWagesCents:null,costState:"unavailable"}});
  expect(result.scenarioAlternatives).toEqual(expect.arrayContaining([
    expect.objectContaining({objective:"cash",completeCoverage:false}),
    expect.objectContaining({objective:"balanced",completeCoverage:true}),
  ]));
 });

 it("answers a named day-off hypothetical without creating any proposal or real staff change",async()=>{
  const proposeStaff=vi.fn();
  mocks.absence.mockResolvedValue({
   ok:true,period:{from:"2026-11-09",to:"2026-11-15"},
   employeeName:"Sarah Jones",absentDate:"2026-11-10",
   baseline:{status:"feasible",completeCoverage:true,cost:{cashWagesCents:24000},gaps:[],shiftCount:12},
   alternative:{status:"unproven",completeCoverage:false,cost:{cashWagesCents:null},
    gaps:[{startAt:"2026-11-10T16:00:00Z",reason:"no_confirmed_availability"}],shiftCount:10},
   changeInModeledCashWagesCents:null,laborCostDifferenceKnown:false,
   assumptions:["Scenario only; no records modified"],warnings:[],
  });
  const r=await draftScheduleTools.simulate_staff_absence.execute(
    {week_start:null,employee_name:"Sarah",weekday:2},
    {...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}});
  expect(mocks.absence).toHaveBeenCalledExactlyOnceWith({
   week:"2026-11-09",employeeName:"Sarah",weekday:2,selectedEmployeeIds:[]});
  expect(r).toMatchObject({
   hypothetical:true,saved:false,absentDate:"2026-11-10",
   changeInModeledCashWagesCents:null,
   alternative:{completeCoverage:false},missing:[],
  });
  expect(proposeStaff).not.toHaveBeenCalled();
 });
 it("does not guess which same-named worker is absent",async()=>{
  mocks.absence.mockResolvedValue({ok:false,error:"employee_ambiguous",
   candidates:[{id:"11111111-1111-4111-8111-111111111111",name:"Sam Lee"},
    {id:"22222222-2222-4222-8222-222222222222",name:"Sam Lee"}]});
  const r=await draftScheduleTools.simulate_staff_absence.execute(
    {week_start:null,employee_name:"Sam Lee",weekday:2},ctx);
  expect(r).toMatchObject({missing:["ownerChoiceRequired","employee_ambiguous"],needsOwnerChoice:true});
  expect(r.candidates).toHaveLength(2);
 });
 it("comparison-only request never creates a needless approval card",async()=>{
  const shift={employeeId:"11111111-1111-4111-8111-111111111111",
   locationId:"main",startAt:"2026-11-09T16:00:00Z",
   endAt:"2026-11-09T18:00:00Z",paidMinutes:120};
  const best={objective:"cash",completeCoverage:true,hardConstraintsSatisfied:true,
   shifts:[shift],gaps:[],cost:{cashWagesCents:2100,costState:"verified",
    loadedPayrollCents:null,missingWageEmployeeIds:[]},ownerMinutes:0,
   legalReview:"unverified_profile"};
  mocks.preview.mockResolvedValue({ok:true,locations:{main:"America/Los_Angeles"},
   notices:[],plan:{best,scenarios:[best],horizonEnd:"2026-11-15",
    status:"feasible",proof:"complete_candidate_solution",warnings:[]}});
  const proposeStaff=vi.fn();
  const r=await draftScheduleTools.draft_week_schedule.execute({
    week_start:"2026-11-09",purpose:"cash_preview"},
    {...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}});
  expect(r).toMatchObject({previewOnly:true,proposalReady:false,
   approvalTool:"not_created",selectedObjective:"cash",
   requestedObjectiveMet:true,proposedShiftCount:1});
  expect(proposeStaff).not.toHaveBeenCalled();
 });

 it("does not falsely reuse a previous approval card after the owner changes the roster",async()=>{
  const shift={employeeId:"11111111-1111-4111-8111-111111111111",locationId:"loc",
   startAt:"2026-11-09T16:00:00Z",endAt:"2026-11-09T18:00:00Z",paidMinutes:120};
  const first={...shift};
  const revised={...shift,startAt:"2026-11-09T18:00:00Z",
   endAt:"2026-11-09T20:00:00Z"};
  const plan=(shifts:typeof shift[])=>({ok:true,locations:{loc:"America/Los_Angeles"},notices:[],
   plan:{status:"feasible",horizonEnd:"2026-11-15",warnings:[],
    best:{objective:"balanced",completeCoverage:true,hardConstraintsSatisfied:true,
     gaps:[],cost:{cashWagesCents:3500},shifts}}});
  mocks.preview.mockResolvedValueOnce(plan([first])).mockResolvedValueOnce(plan([revised]));
  const proposeStaff=vi.fn().mockResolvedValue({proposalId:"22222222-2222-4222-8222-222222222222",
   revision:1,capabilityId:"olivia.staff_propose_schedule.v2"});
  const context={...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}};
  const approved=await draftScheduleTools.draft_week_schedule.execute(
   {week_start:"2026-11-09",purpose:"draft"},context);
  const different=await draftScheduleTools.draft_week_schedule.execute(
   {week_start:"2026-11-09",purpose:"draft"},context);
  expect(approved).toMatchObject({approvalTool:"existing_card_created",proposalReady:true});
  expect(different).toMatchObject({approvalTool:"not_created",proposalReady:false,
   proposedShifts:[expect.objectContaining({start:"10:00",end:"12:00"})],
   missing:expect.arrayContaining(["existingScheduleCardDiffers"])});
  expect(different).not.toHaveProperty("proposalId");
  expect(proposeStaff).toHaveBeenCalledTimes(1);
  const staleDirect=await staffProposalTools.propose_schedule.execute({
   week_start:"2026-11-09",shifts:different.proposedShifts},context);
  expect(staleDirect).toMatchObject({missing:["existingScheduleCardDiffers"],
   duplicateSuppressed:true});
  expect(proposeStaff).toHaveBeenCalledTimes(1);
 });

 it("prepares one approval card for a weekly roster honoring Sarah off Tuesday without writing her availability",async()=>{
  const shift={employeeId:"11111111-1111-4111-8111-111111111111",
    locationId:"loc",startAt:"2026-11-10T16:00:00Z",
    endAt:"2026-11-10T18:00:00Z",paidMinutes:120};
  mocks.preview.mockResolvedValue({ok:true,
   temporaryConstraint:{employeeName:"Sarah Jones",absentDate:"2026-11-10",saved:false},
   locations:{loc:"America/Los_Angeles"},notices:[],
   plan:{status:"feasible",horizonEnd:"2026-11-15",warnings:[],
    best:{objective:"balanced",completeCoverage:true,hardConstraintsSatisfied:true,
     shifts:[shift],gaps:[],cost:{cashWagesCents:3500}}}});
  const proposeStaff=vi.fn().mockResolvedValue({
    proposalId:"22222222-2222-4222-8222-222222222222",revision:1,
    capabilityId:"olivia.staff_propose_schedule.v2"});
  const result=await draftScheduleTools.draft_week_schedule.execute({
   week_start:"2026-11-09",purpose:"draft",
   temporary_absence:{employee_name:"Sarah",weekday:2}},
   {...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}});
  expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({
   week:"2026-11-09",temporaryAbsence:{
    employeeName:"Sarah",weekday:2,selectedEmployeeIds:[]}});
  expect(result).toMatchObject({approvalTool:"existing_card_created",
   temporaryConstraint:{employeeName:"Sarah Jones",absentDate:"2026-11-10",saved:false},
   proposedShifts:[expect.objectContaining({start:"08:00",end:"10:00"})]});
  expect(result.note).toContain("saved availability record was not changed");
  expect(proposeStaff).toHaveBeenCalledTimes(1);
 });
 it("does not approve a fabricated one-week employee absence when names are ambiguous",async()=>{
  mocks.preview.mockResolvedValue({ok:false,error:"employee_ambiguous",
   candidates:[{id:"11111111-1111-4111-8111-111111111111",name:"Sam Lee"},
    {id:"22222222-2222-4222-8222-222222222222",name:"Sam Lee"}]});
  const proposeStaff=vi.fn();
  const r=await draftScheduleTools.draft_week_schedule.execute({
    week_start:"2026-11-09",purpose:"draft",
    temporary_absence:{employee_name:"Sam",weekday:2}},
   {...ctx,proposals:{proposePriceChange:vi.fn(),proposeStaff}});
  expect(r).toMatchObject({saved:false,needsOwnerChoice:true,
   missing:["ownerChoiceRequired","employee_ambiguous"],candidates:[
    expect.objectContaining({id:"11111111-1111-4111-8111-111111111111",
      label:"Sam Lee (11111111)"}),
    expect.objectContaining({id:"22222222-2222-4222-8222-222222222222",
      label:"Sam Lee (22222222)"}),
   ]});
  expect(proposeStaff).not.toHaveBeenCalled();
 });

 it("connects a weekly ambiguous staff name through the ACTUAL choice card to the selected roster",async()=>{
  const firstId="11111111-1111-4111-8111-111111111111";
  const secondId="22222222-2222-4222-8222-222222222222";
  const candidates=[{id:firstId,name:"Sam Lee"},{id:secondId,name:"Sam Lee"}];
  const replacementId="44444444-4444-4444-8444-444444444444";
  const assigned={employeeId:replacementId,locationId:"loc",
    startAt:"2026-11-10T16:00:00Z",endAt:"2026-11-10T18:00:00Z",paidMinutes:120};
  mocks.preview.mockResolvedValueOnce({ok:false,error:"employee_ambiguous",candidates})
   .mockResolvedValueOnce({ok:true,locations:{loc:"America/Los_Angeles"},
    temporaryConstraint:{employeeName:"Sam Lee",absentDate:"2026-11-10",saved:false},
    notices:[],plan:{status:"feasible",horizonEnd:"2026-11-15",warnings:[],
      best:{objective:"balanced",completeCoverage:true,hardConstraintsSatisfied:true,
        shifts:[assigned],gaps:[],cost:{cashWagesCents:3000}}}});
  const proposeStaff=vi.fn().mockResolvedValue({proposalId:"33333333-3333-4333-8333-333333333333",
   revision:1,capabilityId:"olivia.staff_propose_schedule.v2"});
  const choiceState=newResolveState("Make next week's roster; Sam off Tuesday");
  const firstContext={...ctx,resolveState:choiceState,
   proposals:{proposePriceChange:vi.fn(),proposeStaff}};
  const request={week_start:"2026-11-09",purpose:"draft" as const,
   temporary_absence:{employee_name:"Sam",weekday:2}};
  const first=await draftScheduleTools.draft_week_schedule.execute(request,firstContext);
  expect(first).toMatchObject({missing:["ownerChoiceRequired","employee_ambiguous"],
   needsOwnerChoice:true});
  expect(proposeStaff).not.toHaveBeenCalled();
  observeToolResult(choiceState,first);
  expect(choiceState.ambiguous).toHaveLength(1);
  const choices=first.candidates as Array<{id:string;label:string;detail:string}>;
  expect(choices).toEqual([
   {id:firstId,label:"Sam Lee (11111111)",detail:"Team member"},
   {id:secondId,label:"Sam Lee (22222222)",detail:"Team member"},
  ]);
  const options=choices.map(v=>({label:v.label,value:v.id}));
  const card=await askOwnerTools.ask_owner.execute({
   question:"Which Sam?",kind:"choice",options,allowOther:false,
   fields:[],changeSaved:null},firstContext);
  expect(card).toMatchObject({source:"ask_owner",kind:"choice",missing:[]});
  const history=[{role:"assistant",content:
   "Asked: Which Sam? Options: "+options.map(o=>o.label+" ("+o.value+")").join("; ")}];
  const chosenState=newResolveState(options[1].label,history);
  expect([...chosenState.chosenIds]).toEqual([secondId]);
  const second=await draftScheduleTools.draft_week_schedule.execute(request,{
   ...ctx,resolveState:chosenState,
   proposals:{proposePriceChange:vi.fn(),proposeStaff}});
  expect(mocks.preview).toHaveBeenLastCalledWith({week:"2026-11-09",
   temporaryAbsence:{employeeName:"Sam",weekday:2,selectedEmployeeIds:[secondId]}});
  expect(second).toMatchObject({approvalTool:"existing_card_created",
   temporaryConstraint:{saved:false,absentDate:"2026-11-10"},
   proposedShifts:[expect.objectContaining({employee_id:replacementId})]});
  expect(proposeStaff).toHaveBeenCalledTimes(1);
 });
 it("registers hypothetical ambiguity as a real owner choice instead of rejecting ask_owner",async()=>{
  const a="11111111-1111-4111-8111-111111111111";
  const b="22222222-2222-4222-8222-222222222222";
  mocks.absence.mockResolvedValueOnce({ok:false,error:"employee_ambiguous",
   candidates:[{id:a,name:"Sam Lee"},{id:b,name:"Sam Lee"}]})
   .mockResolvedValueOnce({ok:true,period:{from:"2026-11-09",to:"2026-11-15"},
    employeeName:"Sam Lee",absentDate:"2026-11-10",
    baseline:{completeCoverage:true},alternative:{completeCoverage:false},
    assumptions:[],warnings:[],changeInModeledCashWagesCents:null,
    laborCostDifferenceKnown:false,rosterChanges:{removed:[],added:[]}});
  const state=newResolveState("What if Sam is off Tuesday?");
  const context={...ctx,resolveState:state};
  const first=await draftScheduleTools.simulate_staff_absence.execute({
    week_start:"2026-11-09",employee_name:"Sam",weekday:2},context);
  expect(first).toMatchObject({missing:["ownerChoiceRequired","employee_ambiguous"],
   needsOwnerChoice:true});
  observeToolResult(state,first);
  const opts=(first.candidates as Array<{id:string;label:string}>)
   .map(v=>({label:v.label,value:v.id}));
  const card=await askOwnerTools.ask_owner.execute({
   question:"Which Sam?",kind:"choice",options:opts,allowOther:false,
   fields:[],changeSaved:null},context);
  expect(card).toMatchObject({kind:"choice",missing:[]});
  const secondState=newResolveState(opts[1].label,[{role:"assistant",
   content:"Asked: Which Sam? Options: "+opts.map(o=>o.label+" ("+o.value+")").join("; ")}]);
  const result=await draftScheduleTools.simulate_staff_absence.execute({
   week_start:"2026-11-09",employee_name:"Sam",weekday:2},
   {...ctx,resolveState:secondState});
  expect(mocks.absence).toHaveBeenLastCalledWith({
   week:"2026-11-09",employeeName:"Sam",weekday:2,selectedEmployeeIds:[b]});
  expect(result).toMatchObject({hypothetical:true,saved:false,
   employeeName:"Sam Lee",absentDate:"2026-11-10"});
 });
});

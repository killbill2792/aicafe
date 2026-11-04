import {describe,it,expect,vi,beforeEach} from "vitest";
const mocks=vi.hoisted(()=>({preview:vi.fn(),ownerSavings:vi.fn()}));
vi.mock("@/lib/actions/oliviaPlanning",()=>({previewOliviaWeek:mocks.preview,previewOliviaOwnerSavings:mocks.ownerSavings}));
import {draftScheduleTools} from "./draftSchedule";
import {staffProposalTools} from "./staffProposals";
import type {AgentToolContext} from "./index";
const ctx:AgentToolContext={asOf:"2026-11-03",timezone:"America/Los_Angeles",locale:"en",
 tools:{} as AgentToolContext["tools"]};
describe("Supervisor delegates to one Olivia scheduler",()=>{
 beforeEach(()=>{mocks.preview.mockReset();mocks.ownerSavings.mockReset();});
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
   approvalTool:"propose_schedule",proposedShifts:[{
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
});
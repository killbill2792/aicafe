import {describe,it,expect,vi,beforeEach} from "vitest";
const mocks=vi.hoisted(()=>({preview:vi.fn()}));
vi.mock("@/lib/actions/oliviaPlanning",()=>({previewOliviaWeek:mocks.preview}));
import {draftScheduleTools} from "./draftSchedule";
import type {AgentToolContext} from "./index";
const ctx={asOf:"2026-11-03",timezone:"America/Los_Angeles",locale:"en",
 tools:{} as AgentToolContext["tools"]};
describe("Supervisor delegates to one Olivia scheduler",()=>{
 beforeEach(()=>mocks.preview.mockReset());
 it("previews Olivia and returns proposal-ready assignments without writing",async()=>{
  mocks.preview.mockResolvedValue({ok:true,locations:{location:"America/Los_Angeles"},
   notices:[],plan:{status:"feasible",horizonEnd:"2026-11-15",
   warnings:[],best:{completeCoverage:true,cost:{cashWagesCents:25000},
   gaps:[],shifts:[{employeeId:"11111111-1111-4111-8111-111111111111",
    locationId:"location",startAt:"2026-11-09T16:00:00.000Z",
    endAt:"2026-11-10T00:00:00.000Z",paidMinutes:450}]}}});
  const result=await draftScheduleTools.draft_week_schedule.execute({week_start:null},ctx);
  expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({week:"2026-11-09"});
  expect(result).toMatchObject({draft:true,saved:false,proposalReady:true,
   approvalTool:"propose_schedule",proposedShifts:[{
    employee_id:"11111111-1111-4111-8111-111111111111",date:"2026-11-09",
    start:"08:00",end:"16:00",break_minutes:30}]});
 });
 it("honors foundation feature gates without retrying a parallel scheduler",async()=>{
  mocks.preview.mockResolvedValue({ok:false,error:"disabled"});
  const result=await draftScheduleTools.draft_week_schedule.execute({week_start:"2026-11-09"},ctx);
  expect(result).toMatchObject({saved:false,missing:["disabled"]});
  expect(mocks.preview).toHaveBeenCalledTimes(1);
 });
});
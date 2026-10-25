import {describe,it,expect,vi} from "vitest";
vi.mock("@/lib/actions/schedule",()=>({
 getTeam:vi.fn(),getShiftCost:vi.fn(),getWeekSchedule:vi.fn(),getCoverageGaps:vi.fn()
}));
vi.mock("@/lib/actions/teamRules",()=>({getTeamRules:vi.fn()}));
vi.mock("@/lib/scheduling/staffScope.server",()=>({
 staffReadScope:vi.fn(),mondayOfLocalDate:vi.fn(()=> "2026-10-19")
}));
import {getTeam,getShiftCost} from "@/lib/actions/schedule";
import {scheduleReadTools} from "./scheduleReads";
import {newResolveState} from "../resolve";
import type {AgentToolContext} from "./index";
const id="11111111-1111-4111-8111-111111111111";
describe("overnight shift explanations",()=>{
 it("preserves known overnight wages and explicit breaks without crashing",async()=>{
  vi.mocked(getTeam).mockResolvedValue({ok:true,data:{
    team:[{id,name:"Maria",role:"Barista",wageCents:1800}],shifts:[],totals:{}
  }} as never);
  vi.mocked(getShiftCost).mockResolvedValue({ok:true,data:{
    employeeId:id,paidMinutes:210,costCents:6300,estimated:false,unknown:false
  }} as never);
  const ctx={asOf:"2026-10-24",locale:"en",resolveState:newResolveState("How much is Maria's overnight shift?")} as AgentToolContext;
  const result=await scheduleReadTools.get_shift_cost.execute({
    employee_id:id,date:"2026-10-24",start:"22:00",end:"02:00",break_minutes:30
  },ctx);
  expect(result).toMatchObject({costCents:6300,paidMinutes:210,missing:[]});
  expect(result.explain).toMatchObject([{formula:"prorate",result:{kind:"money",cents:6300}}]);
 });
});

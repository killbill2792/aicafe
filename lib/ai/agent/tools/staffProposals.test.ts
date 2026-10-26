import {describe,it,expect,vi} from "vitest";
import {staffProposalInputs,staffProposalTools} from "./staffProposals";
import type {AgentToolContext} from "./index";
const personId="11111111-1111-4111-8111-111111111111";
const shift={employee_id:personId,date:"2026-10-26",start:"06:30",end:"14:00",break_minutes:30};
const valid={
 propose_schedule:{week_start:"2026-10-26",shifts:[shift]},
 propose_shift_change:{shift_id:null,shift,remove:false},
 propose_add_staff:{name:"Maria",role:"Barista",wage_cents:2500,phone:null},
 propose_staff_change:{employee_id:personId,name:"Sam",role:null,wage_cents:2700,phone:null,active:true},
 propose_availability_change:{instruction:"Maria can only work Mon, Wed, Fri mornings"},
 propose_rule_change:{rule:"prep_minutes_before_open",boolean_value:null,number_value:30},
 propose_send_schedule:{week_start:"2026-10-26"},
} as const;
const ctx={tools:{} as AgentToolContext["tools"],asOf:"2026-10-23",locale:"en" as const};
describe("staff owner-approval tool registration",()=>{
 it("has a strict schema and emits an inert persisted card for all seven tools",async()=>{
  for(const name of Object.keys(valid) as Array<keyof typeof valid>){
   expect(staffProposalInputs[name].parse(valid[name])).toBeTruthy();
   const proposeStaff=vi.fn().mockResolvedValue({
    proposalId:"22222222-2222-4222-8222-222222222222",
    revision:1,capabilityId:"olivia.staff_"+name+".v1"});
   const result=await staffProposalTools[name].execute(valid[name],{...ctx,proposals:{
    proposePriceChange:vi.fn(),proposeStaff}});
   expect(proposeStaff).toHaveBeenCalledWith({name,input:valid[name]});
   expect(result).toMatchObject({source:"staff_proposal",draft:true,saved:false,
    proposalId:"22222222-2222-4222-8222-222222222222",missing:[]});
  }
 });
 it("cannot write or claim approval without the scoped proposal port",async()=>{
  for(const name of Object.keys(valid) as Array<keyof typeof valid>){
   expect(await staffProposalTools[name].execute(valid[name],ctx)).toMatchObject({
    saved:false,missing:["proposalsUnavailable"]});
  }
 });
 it("rejects malformed shift dates, hours and staff identifiers",()=>{
  expect(staffProposalInputs.propose_shift_change.safeParse({
   shift_id:null,shift:{...shift,start:"45:20"},remove:false}).success).toBe(false);
  expect(staffProposalInputs.propose_schedule.safeParse({
   week_start:"2026-10-26",shifts:[{...shift,employee_id:"not-an-id"}]}).success).toBe(false);
 });
});
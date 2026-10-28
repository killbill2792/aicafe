import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({sources:vi.fn(),token:vi.fn(),owner:vi.fn()}));
vi.mock("@/lib/data/staffProposalSources.server",()=>({
 readStaffProposalSources:mocks.sources,readStaffProposalToken:mocks.token,
}));
vi.mock("@/lib/scheduling/foundation.server",()=>({requireSchedulingOwner:mocks.owner}));
import {staffCapabilities} from "./staffProposals.server";
const employeeId="11111111-1111-4111-8111-111111111111";
describe("staff schedule approval partial wage",()=>{
 it("creates an inert approval card when a scheduled employee has no wage",async()=>{
  const scope={businessId:"22222222-2222-4222-8222-222222222222",
   ownerUserId:"33333333-3333-4333-8333-333333333333",
   threadId:"44444444-4444-4444-8444-444444444444",locale:"en" as const};
  const sources={people:[{id:employeeId,display_name:"Maria",role:"Barista",active:true,
    wage_period:"hour",wage_amount_cents:null,phone_e164:null,whatsapp_opt_in:false}],
   shifts:[],rules:null,availability:[],exceptions:[],timezone:"America/Los_Angeles",
   currency:"USD"};
  mocks.sources.mockResolvedValue(sources);
  mocks.token.mockResolvedValue("a".repeat(32));
  const capability=staffCapabilities.find(c=>c.id==="olivia.staff_propose_schedule.v2");
  expect(capability).toBeDefined();
  const result=await capability!.simulate(scope,{
   week_start:"2030-01-07",
   shifts:[{employee_id:employeeId,date:"2030-01-07",start:"09:00",
    end:"17:00",break_minutes:30}]
  });
  const effect=result.effect as {preview:Array<{after?:{kind?:string;text?:string}|null}>};
  expect(effect.preview.some(row=>row.after?.kind==="text"&&
   row.after.text==="Partial: wages missing for 1 staff")).toBe(true);
  expect(mocks.token).toHaveBeenCalledTimes(2);
 });
});

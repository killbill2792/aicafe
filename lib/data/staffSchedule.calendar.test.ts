import {describe,it,expect,vi,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({scope:vi.fn(),rules:vi.fn(),planned:vi.fn(),admin:vi.fn()}));
vi.mock("@/lib/scheduling/staffScope.server",()=>({staffReadScope:mocks.scope}));
vi.mock("@/lib/data/staffRules.server",()=>({getTeamRules:mocks.rules}));
vi.mock("@/lib/data/toastScheduledShifts.server",()=>({readToastPlannedShifts:mocks.planned}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.admin}));
import {getWeekSchedule} from "./staffSchedule.server";
import {DEFAULT_TEAM_RULES} from "@/lib/calc/scheduling/teamRuleDefaults";
const chain=(result:{data:unknown;error:unknown})=>{
 const q={then:(resolve:(value:unknown)=>unknown)=>Promise.resolve(result).then(resolve)} as Record<string,unknown>;
 for(const method of ["select","eq","gte","lte","is","order","limit","maybeSingle","single","or"])
  q[method]=()=>q;
 return q;
};
describe("one Staff calendar reads saved Toast and Olivia evidence",()=>{
 afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
 it("shows both Toast shift types and suppresses approved draft on their date",async()=>{
  vi.stubEnv("SCHEDULING_FOUNDATION_ENABLED","true");
  vi.stubEnv("SCHEDULING_PR3_DRAFTS_ENABLED","true");
  const person={id:"amy",display_name:"Amy",active:true,role:"Barista",
   wage_period:"hour",wage_amount_cents:1800,default_hourly_wage_cents:1800};
  const from=vi.fn((table:string)=>{
   if(table==="employees")return chain({data:[person],error:null});
   if(table==="scheduled_shifts"||table==="staff_availability_rules")
    return chain({data:[],error:null});
   if(table==="locations")return chain({data:null,error:null});
   if(table==="timecards")return chain({data:[{id:"actual",employee_id:"amy",
    clock_in:"2026-11-09T16:00:00Z",clock_out:"2026-11-09T20:00:00Z"}],error:null});
   if(table==="scheduling_plan_series")
    return chain({data:{id:"series",current_revision:1},error:null});
   if(table==="scheduling_plan_revisions")
    return chain({data:{id:"revision",status:"approved",
     scenario:{shifts:[
      {employeeId:"amy",startAt:"2026-11-09T16:00:00Z",endAt:"2026-11-09T20:00:00Z"},
      {employeeId:"amy",startAt:"2026-11-10T16:00:00Z",endAt:"2026-11-10T20:00:00Z"}]}},error:null});
   throw new Error("Unknown "+table);
  });
  mocks.scope.mockResolvedValue({ok:true,supabase:{from},businessId:"cafe",
   timezone:"America/Los_Angeles",currency:"USD",today:"2026-11-09",readOnly:false});
  mocks.rules.mockResolvedValue({ok:true,data:{...DEFAULT_TEAM_RULES}});
  mocks.admin.mockReturnValue({});
  mocks.planned.mockResolvedValue([{id:"planned",employeeId:"amy",employeeName:"Amy",
   start:"2026-11-09T16:00:00Z",end:"2026-11-09T20:00:00Z",
   source:"toast",paid:false,locationId:"loc"}]);
  const result=await getWeekSchedule({weekStart:"2026-11-09"});
  expect(result.ok).toBe(true);
  if(!result.ok)return;
  expect(result.data.calendarEntries.map(e=>[e.source,e.date])).toEqual([
   ["toast_actual","2026-11-09"],["toast_planned","2026-11-09"],
   ["ai_draft","2026-11-10"]]);
  expect(result.data.calendarEntries.every(e=>e.employeeName==="Amy")).toBe(true);
 });
});
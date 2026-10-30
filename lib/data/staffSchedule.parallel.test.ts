import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mock=vi.hoisted(()=>({scope:vi.fn(),rules:vi.fn(),admin:vi.fn(),external:vi.fn()}));
vi.mock("@/lib/scheduling/staffScope.server",()=>({staffReadScope:mock.scope}));
vi.mock("@/lib/data/staffRules.server",()=>({getTeamRules:mock.rules}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mock.admin}));
vi.mock("./toastScheduledShifts.server",()=>({readToastPlannedShifts:mock.external}));
vi.mock("@/lib/perf/timeReader.server",()=>({timeReader:(_page:string,_name:string,read:()=>Promise<unknown>)=>read()}));
import {getWeekSchedule} from "./staffSchedule.server";
import {DEFAULT_TEAM_RULES} from "@/lib/calc/scheduling/teamRuleDefaults";

function query(response:Promise<{data:unknown;error:null}>){
 const q={then:(resolve:(value:unknown)=>unknown)=>response.then(resolve)} as Record<string,unknown>;
 for(const name of ["select","eq","gte","lte","is","order","limit","maybeSingle","or"])
  q[name]=()=>q;
 return q;
}

describe("Staff schedule independent reads",()=>{
 it("starts the optional POS planned-shift read before the internal roster query completes",async()=>{
  const businessId="11111111-1111-4111-8111-111111111112";
  let releaseEmployees!:(value:{data:unknown;error:null})=>void;
  const employees=new Promise<{data:unknown;error:null}>(resolve=>{releaseEmployees=resolve;});
  const from=vi.fn((table:string)=>{
   if(table==="employees")return query(employees);
   if(table==="scheduled_shifts")return query(Promise.resolve({data:[{
    id:"shift-1",employee_id:"employee-1",local_date:"2026-11-02",
    start_local:"08:00",end_local:"12:00",overnight:false,break_minutes:0,
    status:"draft",source:"owner",break_source:"owner"
   }],error:null}));
   if(table==="locations")return query(Promise.resolve({data:null,error:null}));
   if(table==="staff_availability_rules")return query(Promise.resolve({data:[],error:null}));
   throw new Error("Unexpected query");
  });
  mock.scope.mockResolvedValue({ok:true,businessId,supabase:{from},
   today:"2026-10-30",timezone:"America/Los_Angeles",currency:"EUR",readOnly:false});
  mock.rules.mockResolvedValue({ok:true,data:{...DEFAULT_TEAM_RULES}});
  const admin={};
  mock.admin.mockReturnValue(admin);
  const planned=[{id:"pos-shift-1",date:"2026-11-03"}];
  mock.external.mockResolvedValue(planned);

  const pending=getWeekSchedule({weekStart:"2026-11-02"});
  // The employee read is deliberately unresolved; a serial POS query would
  // time out here, and the owner would wait for the sum of both delays.
  await vi.waitFor(()=>expect(mock.external).toHaveBeenCalledOnce());
  expect(mock.external).toHaveBeenCalledWith(
   admin,businessId,"2026-11-02","2026-11-08","America/Los_Angeles");
  releaseEmployees({data:[{
   id:"employee-1",display_name:"Casey",active:true,role:"Barista",
   wage_period:"hour",wage_amount_cents:1900,default_hourly_wage_cents:null,
   available_days:[1,2,3,4,5],min_weekly_minutes:null,max_weekly_minutes:null
  }],error:null});

  const result=await pending;
  expect(result.ok).toBe(true);
  if(!result.ok)return;
  expect(result.data.currency).toBe("EUR");
  expect(result.data.posScheduleError).toBeNull();
  expect(result.data.posShifts).toEqual(planned);
  expect(result.data.shifts).toMatchObject([{
   id:"shift-1",employeeId:"employee-1",date:"2026-11-02",status:"draft"
  }]);
  expect(result.data.team.map(p=>p.id)).toEqual(["employee-1"]);
 });
});

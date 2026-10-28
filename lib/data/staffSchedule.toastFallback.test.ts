import {describe,it,expect,vi,afterEach} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({scope:vi.fn(),rules:vi.fn(),admin:vi.fn()}));
vi.mock("@/lib/scheduling/staffScope.server",()=>({staffReadScope:mocks.scope}));
vi.mock("@/lib/data/staffRules.server",()=>({getTeamRules:mocks.rules}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:mocks.admin}));
import {getWeekSchedule} from "./staffSchedule.server";
import {DEFAULT_TEAM_RULES} from "@/lib/calc/scheduling/teamRuleDefaults";

function chain(result:{data:unknown;error:unknown}){
 const query={then:(resolve:(value:unknown)=>unknown)=>Promise.resolve(result).then(resolve)} as Record<string,unknown>;
 for(const method of ["select","eq","gte","lte","is","order","limit","maybeSingle","single","or"])
  query[method]=()=>query;
 return query;
}
describe("optional Toast schedule reads",()=>{
 afterEach(()=>vi.unstubAllEnvs());
 it("returns the verified café schedule when privileged Toast tables fail",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const businessId="11111111-1111-4111-8111-111111111112";
  const from=vi.fn((table:string)=>{
   if(table==="employees"||table==="scheduled_shifts"||table==="staff_availability_rules")
    return chain({data:[],error:null});
   if(table==="locations")return chain({data:null,error:null});
   throw new Error("Unexpected table: "+table);
  });
  mocks.scope.mockResolvedValue({ok:true,businessId,supabase:{from},
   timezone:"America/Los_Angeles",currency:"USD",today:"2026-10-27",readOnly:false});
  mocks.rules.mockResolvedValue({ok:true,data:{...DEFAULT_TEAM_RULES}});
  const protectedFrom=vi.fn((table:string)=>{
   if(table==="toast_location_mappings")
    return chain({data:null,error:{code:"42501",message:"revoked"}});
   throw new Error("Unexpected privileged table");
  });
  mocks.admin.mockReturnValue({from:protectedFrom});
  const result=await getWeekSchedule({weekStart:"2026-11-02"});
  expect(result.ok).toBe(true);
  if(!result.ok)return;
  expect(result.data.posShifts).toEqual([]);
  expect(result.data.team).toEqual([]);
  expect(mocks.admin).toHaveBeenCalledOnce();
  expect(protectedFrom).toHaveBeenCalledWith("toast_location_mappings");
 });
});

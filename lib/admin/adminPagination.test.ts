import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const f=vi.hoisted(()=>({calls:[] as Array<{table:string;method:string;args:unknown[]}>}));
vi.mock("@/lib/admin/auth.server",()=>({requireAdmin:async()=>({id:"admin"})}));
vi.mock("@/lib/access/access.server",()=>({getCafeAccess:async()=>({mode:"grandfathered",active:true})}));
vi.mock("@/lib/supabase/admin",()=>{
 type Result={data:unknown[];error:null;count:number};
 type Query={
  order:(name:string,opts?:unknown)=>Query;
  range:(start:number,end:number)=>Query;
  eq:(field:string,value:unknown)=>Query;
  neq:(field:string,value:unknown)=>Query;
  gt:(field:string,value:unknown)=>Query;
  gte:(field:string,value:unknown)=>Query;
  lte:(field:string,value:unknown)=>Query;
  then:(resolve:(result:Result)=>unknown,reject?:(error:unknown)=>unknown)=>Promise<unknown>;
 };
 const make=(table:string):Query=>{
  const call=(method:string,...args:unknown[])=>{f.calls.push({table,method,args});return q;};
  const q:Query={
   order:(...args)=>call("order",...args),range:(...args)=>call("range",...args),
   eq:(...args)=>call("eq",...args),neq:(...args)=>call("neq",...args),
   gt:(...args)=>call("gt",...args),gte:(...args)=>call("gte",...args),
   lte:(...args)=>call("lte",...args),
   then:(resolve,reject)=>Promise.resolve({data:[],error:null,count:1600}).then(resolve,reject),
  };
  return q;
 };
 return {createAdminSupabaseClient:()=>({from:(table:string)=>({select:()=>make(table)})})};
});
import {listCafes,listConversations} from "@/lib/data/adminData.server";
beforeEach(()=>{f.calls=[];});
describe("admin server-side pagination",()=>{
 it("can fetch café pages beyond the old first-200 limit",async()=>{
  const result=await listCafes(12);
  expect(result.total).toBe(1600);
  expect(result.page).toBe(12);
  expect(f.calls).toContainEqual({table:"businesses",method:"range",args:[300,324]});
  expect(f.calls).toContainEqual({table:"businesses",method:"order",args:["id",{ascending:false}]});
 });
 it("paginates filtered conversations without losing owner feedback filters",async()=>{
  const cafe="11111111-1111-4111-8111-111111111111";
  const result=await listConversations({
   cafe,from:"2026-10-01",to:"2026-10-23",failed:true,slow:true,down:true,
  },5);
  expect(result.page).toBe(5);
  expect(result.total).toBe(1600);
  expect(f.calls).toContainEqual({table:"agent_turn_logs",method:"range",args:[250,299]});
  expect(f.calls).toContainEqual({table:"agent_turn_logs",method:"eq",args:["business_id",cafe]});
  expect(f.calls).toContainEqual({table:"agent_turn_logs",method:"neq",args:["status","ok"]});
  expect(f.calls).toContainEqual({table:"agent_turn_logs",method:"eq",args:["owner_feedback","down"]});
  expect(f.calls).toContainEqual({table:"agent_turn_logs",method:"gt",args:["duration_ms",20000]});
 });
});

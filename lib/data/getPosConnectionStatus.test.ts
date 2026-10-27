import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const s=vi.hoisted(()=>({rows:[] as Array<{provider:string;status:string}>,
 businessId:"11111111-1111-4111-8111-111111111111",
 queried:"" as string}));
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>s.businessId}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
 auth:{getUser:async()=>({data:{user:{id:"owner"}}})},
 from:(name:string)=>{
  expect(name).toBe("pos_connections");
  const chain={
   select:()=>chain,eq:(key:string,value:string)=>{if(key==="business_id")s.queried=value;return chain;},
   limit:async()=>({data:s.rows,error:null}),
  };
  return chain;
 },
})}));
import {getPosConnectionStatus} from "./getPosConnectionStatus";
beforeEach(()=>{s.rows=[];s.queried="";});
describe("provider-neutral café connection status",()=>{
 it("returns no connection when no provider exists",async()=>{
  expect(await getPosConnectionStatus()).toBeNull();
  expect(s.queried).toBe(s.businessId);
 });
 it("chooses a working connection, not a .maybeSingle() error for two registers",async()=>{
  s.rows=[{provider:"square",status:"needs_reconnect"},{provider:"toast",status:"active"}];
  expect(await getPosConnectionStatus()).toEqual({provider:"toast",status:"active"});
 });
 it("shows a reconnect when all providers need attention",async()=>{
  s.rows=[{provider:"square",status:"needs_reconnect"},{provider:"toast",status:"disconnected"}];
  expect(await getPosConnectionStatus()).toEqual({provider:"square",status:"needs_reconnect"});
 });
});

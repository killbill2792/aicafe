import {beforeEach,describe,expect,it,vi} from "vitest";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {ownerCreateEmployeeLogin,readOwnerStaffHistory,getStaffInbox,staffResponseNoticePreviews}
 from "./channel.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/scheduling/foundation.server",()=>({requireSchedulingOwner:vi.fn()}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:vi.fn()}));
const cafe="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const employee="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const authUser="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ownerUser="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const input={employeeId:employee,email:"worker@example.test",password:"one-time-password-123"};
function setupAccount(linked=false){
 const rows=vi.fn(async()=>({data:{id:employee,active:true,
  staff_auth_user_id:linked?authUser:null},error:null}));
 const select=vi.fn();
 const eq=vi.fn();
 const chain={select,eq,maybeSingle:rows};
 select.mockReturnValue(chain);eq.mockReturnValue(chain);
 const rpc=vi.fn(async()=>({data:{linked:true},error:null}));
 const from=vi.fn((name:string)=>{
  if(name!=="employees")throw Error("unexpected auth lookup");
  return chain;
 });
 const matching=vi.fn(async()=>({data:[] as Array<{id:string}>,error:null}));
 const linkedQuery={limit:matching};
 const admin={from:vi.fn((table:string)=>{
  if(table!=="employees")throw Error("unexpected cleanup lookup");
  return {select:()=>({eq:(column:string,value:string)=>{
   if(column!=="staff_auth_user_id"||value!==authUser)throw Error("unscoped cleanup lookup");
   return linkedQuery;
  }})};
 }),auth:{admin:{
  createUser:vi.fn(async()=>({data:{user:{id:authUser}},error:null})),
  deleteUser:vi.fn(async()=>({error:null})),
 }}};
 vi.mocked(createAdminSupabaseClient).mockReturnValue(admin as never);
 vi.mocked(requireSchedulingOwner).mockResolvedValue({
  businessId:cafe,supabase:{from,rpc,auth:{getUser:vi.fn(async()=>({
   data:{user:{id:ownerUser}},error:null,
  }))}} as never,
 });
 return {rpc,from,rows,admin,eq};
}
beforeEach(()=>vi.clearAllMocks());
describe("owner creates employee-only login using the existing link authority",()=>{
 it("rejects invalid credentials before any database or Auth Admin call",async()=>{
  const a=setupAccount();
  await expect(ownerCreateEmployeeLogin({...input,password:"short"}))
   .rejects.toMatchObject({code:"invalid"});
  expect(a.from).not.toHaveBeenCalled();
  expect(a.admin.auth.admin.createUser).not.toHaveBeenCalled();
 });
 it("rejects wrong/unverified owner before touching Admin Auth",async()=>{
  const a=setupAccount();
  vi.mocked(requireSchedulingOwner).mockResolvedValueOnce(null as never);
  await expect(ownerCreateEmployeeLogin(input)).rejects.toMatchObject({code:"unauthorized"});
  expect(a.admin.auth.admin.createUser).not.toHaveBeenCalled();
 });
 it("does not overwrite an already-linked employee account",async()=>{
  const a=setupAccount(true);
  await expect(ownerCreateEmployeeLogin(input)).rejects.toMatchObject({code:"conflict"});
  expect(a.admin.auth.admin.createUser).not.toHaveBeenCalled();
 });
 it("creates one confirmed account and links it through the real owner-scoped RPC port",async()=>{
  const a=setupAccount();
  expect(await ownerCreateEmployeeLogin(input)).toEqual({linked:true,loginPath:"/crew/login"});
  expect(a.admin.auth.admin.createUser).toHaveBeenCalledExactlyOnceWith({
   email:input.email,password:input.password,email_confirm:true});
  expect(a.rpc).toHaveBeenCalledExactlyOnceWith("staff_link_existing_login",{
   p_business_id:cafe,p_employee_id:employee,p_email:input.email});
  expect(a.admin.auth.admin.deleteUser).not.toHaveBeenCalled();
 });
 it("on definitive link rejection deletes only the account created in this call",async()=>{
  const a=setupAccount();
  a.rpc.mockResolvedValueOnce({data:null as never,error:{code:"42501"} as never});
  await expect(ownerCreateEmployeeLogin(input)).rejects.toMatchObject({code:"storage"});
  expect(a.admin.auth.admin.deleteUser).toHaveBeenCalledExactlyOnceWith(authUser);
 });
 it("keeps an Auth user linked to another worker after an onboarding race",async()=>{
  const a=setupAccount();
  a.rpc.mockResolvedValueOnce({data:null as never,error:{code:"23505"} as never});
  const results=a.admin.from("employees").select().eq("staff_auth_user_id",authUser);
  results.limit.mockResolvedValueOnce({data:[{id:employee}],error:null});
  await expect(ownerCreateEmployeeLogin(input)).rejects.toMatchObject({code:"conflict"});
  expect(a.admin.auth.admin.deleteUser).not.toHaveBeenCalled();
 });
 it("recovers a linked account when the RPC acknowledgement was lost",async()=>{
  const a=setupAccount();
  a.rpc.mockResolvedValueOnce({data:null as never,error:{message:"lost"} as never});
  a.rows.mockResolvedValueOnce({data:{id:employee,active:true,staff_auth_user_id:null},error:null})
   .mockResolvedValueOnce({data:{id:employee,active:true,staff_auth_user_id:authUser},error:null});
  expect(await ownerCreateEmployeeLogin(input)).toEqual({linked:true,loginPath:"/crew/login"});
  expect(a.admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  const uncertain=setupAccount();uncertain.rpc.mockResolvedValueOnce({data:null as never,error:{message:"lost"} as never});
  await expect(ownerCreateEmployeeLogin(input)).rejects.toMatchObject({code:"storage"});expect(uncertain.admin.auth.admin.deleteUser).not.toHaveBeenCalled();
 });
});
describe("owner gets an uncapped paginated staff transcript, not a 25-row latest view",()=>{
 it("requires a verified owner and rejects malformed cursors",async()=>{
  setupAccount();
  await expect(readOwnerStaffHistory({at:"yesterday",id:employee}))
   .rejects.toMatchObject({code:"invalid"});
  vi.mocked(requireSchedulingOwner).mockResolvedValueOnce(null as never);
  await expect(readOwnerStaffHistory()).rejects.toMatchObject({code:"unauthorized"});
 });
 it("pages saved requests and preserves their original prompt and employee identity",async()=>{
  const a=setupAccount();
  const rows=Array.from({length:26},(_,i)=>({
   id:`00000000-0000-4000-8000-${String(26-i).padStart(12,"0")}`,
   employee_id:employee,title:"Check cups",prompt:`Count cups (request ${i})`,
   status:"open",source_type:"maintenance_task",
   created_at:new Date(Date.UTC(2026,10,21,18,0,i)).toISOString(),
  }));
  const queries:Record<string,ReturnType<typeof vi.fn>>={};
  const from=vi.fn((table:string)=>{
   if(table==="employees"){
    const q={select:()=>q,eq:()=>q,in:async()=>({data:[
     {id:employee,display_name:"Rahul"}],error:null})};return q;
   }
   const q={select:()=>q,eq:()=>q,or:vi.fn(()=>q),order:()=>q,
    limit:vi.fn(async()=>({data:table==="staff_communication_requests"?rows:[],
     error:null}))};
   queries[table]=q.or;
   return q;
  });
  vi.mocked(requireSchedulingOwner).mockResolvedValueOnce({
   businessId:cafe,supabase:{from} as never});
  const page=await readOwnerStaffHistory();
  expect(page.events).toHaveLength(25);
  expect(page.events[0]).toMatchObject({
   employeeName:"Rahul",actor:"supervisor",kind:"request",text:"Count cups (request 25)"});
  expect(page.events[24].text).toBe("Count cups (request 1)");
  expect(page.nextCursor).toEqual({at:page.events[24].at,id:page.events[24].id});
  expect(from).toHaveBeenCalledWith("staff_communication_requests");
  expect(queries.staff_communication_requests).not.toHaveBeenCalled();
  expect(a.admin.auth.admin.createUser).not.toHaveBeenCalled();
 });
});
describe("self-only employee facts do not block staff communication",()=>{
 it("returns private-data unavailable when a timecard reader fails but preserves worker messages",async()=>{
  const dbQuery={select:vi.fn(),eq:vi.fn(),in:vi.fn(),order:vi.fn(),limit:vi.fn()};
  dbQuery.select.mockReturnValue(dbQuery);
  dbQuery.eq.mockReturnValue(dbQuery);dbQuery.in.mockReturnValue(dbQuery);
  dbQuery.order.mockReturnValue(dbQuery);
  dbQuery.limit.mockImplementation(async()=>({data:[],error:null}));
  const session={auth:{getUser:vi.fn(async()=>({data:{user:{id:authUser}},error:null}))},
   from:vi.fn(()=>dbQuery)};
  vi.mocked(createServerSupabaseClient).mockResolvedValue(session as never);
  const employeeLookup={select:vi.fn(),eq:vi.fn(),limit:vi.fn()};
  employeeLookup.select.mockReturnValue(employeeLookup);
  employeeLookup.eq.mockReturnValue(employeeLookup);
  employeeLookup.limit.mockResolvedValue({data:[
   {id:employee,business_id:cafe,display_name:"Rahul"}],error:null});
  const badPrivate={select:()=>({eq:()=>({maybeSingle:async()=>({data:null,error:{message:"offline"}})})})};
  const admin={
   from:vi.fn((table:string)=>{
    if(table==="employees")return employeeLookup;
    if(table==="businesses")return badPrivate;
    throw Error("must not read owner data");
   }),
   rpc:vi.fn(async()=>({data:0,error:null})),
  };
  vi.mocked(createAdminSupabaseClient).mockReturnValue(admin as never);
  expect(await getStaffInbox()).toEqual({name:"Rahul",requests:[],messages:[],self:null});
  expect(admin.rpc).toHaveBeenCalledWith("staff_channel_sync_shift_requests",
   {p_business_id:cafe});
  expect(dbQuery.eq).toHaveBeenCalledWith("employee_id",employee);
  expect(session.from).not.toHaveBeenCalledWith("timecards");
 });
});
describe("compact staff notice preserves exact owner-visible source",()=>{
 it("does not infer employee names or message contents across cafés",async()=>{
  const messages={data:[{id:authUser,employee_id:employee,
   response_code:"message",body:["About 40 cups remaining","from the back room"].join(String.fromCharCode(10))}],error:null};
  const names={data:[{id:employee,display_name:"Rahul"}],error:null};
  const filters:Record<string,Array<[string,unknown]>>={};
  const from=vi.fn((table:string)=>{
   const q={
    select:vi.fn(()=>q),
    eq:vi.fn((field:string,value:unknown)=>{
     (filters[table]??=[]).push([field,value]);return q;
    }),
    in:vi.fn(()=>q),
    limit:vi.fn(async()=>table==="employees"?names:messages),
   };
   return q;
  });
  const title=await staffResponseNoticePreviews({from} as never,cafe,[authUser]);
  expect(title.get(authUser)).toBe("Rahul replied: About 40 cups remaining from the back room");
  expect(filters.staff_communication_messages).toContainEqual(["business_id",cafe]);
  expect(filters.staff_communication_messages).toContainEqual(["actor","employee"]);
  expect(filters.employees).toContainEqual(["business_id",cafe]);
 });
 it("rejects missing source data rather than claiming a response",async()=>{
  const from=vi.fn(()=>({select:()=>({
   eq:()=>({eq:()=>({in:()=>({
    limit:async()=>({data:null,error:{message:"unavailable"}}),
   })})}),
  })}));
  await expect(staffResponseNoticePreviews({from} as never,cafe,[authUser]))
   .rejects.toMatchObject({code:"storage"});
 });
});

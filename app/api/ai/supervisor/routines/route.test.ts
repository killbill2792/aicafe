import {beforeEach,describe,expect,it,vi} from "vitest";
const f=vi.hoisted(()=>({
  scope:{businessId:"11111111-1111-4111-8111-111111111111",
    ownerUserId:"22222222-2222-4222-8222-222222222222"},
  denied:false,client:{id:"authenticated-client"} as unknown,
  mutation:vi.fn(),reader:vi.fn(async(_scope:unknown,_client:unknown)=>[{id:"routine-1",title:"Daily source check"}]),
}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  ConversationApiError:class extends Error{
    constructor(public status:number,public code:string){super(code);}
  },
  authenticatedConversationContext:async()=>{
    if(f.denied)throw new Error("owner_access_required");
    return {scope:f.scope,service:{}};
  },
}));
vi.mock("@/lib/supabase/server",()=>({
  createServerSupabaseClient:async()=>f.client,
}));
vi.mock("@/lib/ai/supervisor/routines/repository.server",()=>({
  listOwnerRoutinesAcrossThreads:(scope:unknown,client:unknown)=>f.reader(scope,client),
  changeOwnerRoutine:(input:unknown,scope:unknown)=>f.mutation(input,scope),
}));
import {GET,POST} from "./route";
beforeEach(()=>{f.denied=false;f.reader.mockClear();
  f.client={id:"authenticated-client"};f.mutation.mockReset();});
describe("owner library routines read-only endpoint",()=>{
  it("reads real saved routines only for the authenticated café and owner",async()=>{
    const response=await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      routines:[{id:"routine-1",title:"Daily source check"}],
    });
    expect(f.reader).toHaveBeenCalledWith(f.scope,{id:"authenticated-client"});
  });
  it("cannot return routines without owner authentication",async()=>{
    f.denied=true;
    const response=await GET();
    expect(response.status).not.toBe(200);
    expect(f.reader).not.toHaveBeenCalled();
  });
  it("does not present a failed reader as an empty library",async()=>{
    f.reader.mockRejectedValueOnce(new Error("database offline"));
    const response=await GET();
    expect(response.status).not.toBe(200);
  });
});

const routineId="33333333-3333-4333-8333-333333333333";
const threadId="44444444-4444-4444-8444-444444444444";
const row={id:routineId,business_id:f.scope.businessId,
  owner_user_id:f.scope.ownerUserId,thread_id:threadId,revision:3,
  status:"active",execution_mode:"objective"};
function mockControlDb(saved:typeof row|null=row){
  const eq=vi.fn().mockReturnThis();
  const q={select:vi.fn().mockReturnThis(),eq,
    maybeSingle:vi.fn(async()=>({data:saved,error:null}))};
  f.client={from:vi.fn(()=>q)};
  f.mutation.mockImplementation(async(input:{id:string;revision:number;status:string})=>({
    id:input.id,revision:input.revision+1,status:input.status,threadId,
  }));
  return q;
}
function request(body:unknown,origin="https://app.test",mime="application/json"){
  return new Request("https://app.test/api/ai/supervisor/routines",{
    method:"POST",headers:{"content-type":mime,...(origin?{origin}:{})},
    body:typeof body==="string"?body:JSON.stringify(body),
  });
}
describe("U4 compact routine status mutations are authenticated and CAS",()=>{
  it("binds status updates to the persisted owner's row and its true source thread",async()=>{
    const q=mockControlDb();
    const response=await POST(request({action:"pause",routineId,revision:3}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      routine:{id:routineId,status:"paused",revision:4},
    });
    expect(q.eq.mock.calls).toEqual([["business_id",f.scope.businessId],
      ["owner_user_id",f.scope.ownerUserId],["id",routineId]]);
    expect(f.mutation).toHaveBeenCalledWith({
      id:routineId,revision:3,status:"paused",
    },expect.objectContaining({scope:f.scope,threadId}));
  });
  it("denies foreign/missing Origin, non-JSON input and oversized JSON before owner read",async()=>{
    for(const req of [
      request({action:"pause",routineId,revision:3},"https://attacker.invalid"),
      request({action:"pause",routineId,revision:3},""),
      request({action:"pause",routineId,revision:3},"https://app.test","text/plain"),
      request(" ".repeat(8193)),
    ]){
      const response=await POST(req);
      expect([403,413,415]).toContain(response.status);
    }
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("rejects forged fields, malformed ID and missing revision",async()=>{
    for(const body of [
      {action:"delete",routineId,revision:0},
      {action:"pause",routineId:"malformed",revision:3},
      {action:"pause",routineId,revision:3,ownerUserId:"another"},
      {action:"delete",routineId},
    ])expect((await POST(request(body))).status).toBe(422);
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("cannot use a Watch, foreign or terminal row as an owner-created routine",async()=>{
    for(const stored of [null,{...row,execution_mode:"watch"},
      {...row,status:"revoked"}]){
      mockControlDb(stored as typeof row|null);
      const response=await POST(request({action:"delete",routineId,revision:3}));
      expect(response.status).not.toBe(200);
    }
    expect(f.mutation).not.toHaveBeenCalled();
  });
  it("does not claim success when the exact revision CAS fails",async()=>{
    mockControlDb();
    f.mutation.mockRejectedValueOnce(new Error("stale"));
    const response=await POST(request({action:"pause",routineId,revision:2}));
    expect(response.status).not.toBe(200);
    expect(f.mutation).toHaveBeenCalledWith({id:routineId,revision:2,
      status:"paused"},expect.anything());
  });
});

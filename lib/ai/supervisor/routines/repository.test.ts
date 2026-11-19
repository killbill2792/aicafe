import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createOwnerRoutine,changeOwnerRoutine,claimRoutineOccurrence,listOwnerRoutinesAcrossThreads} from "./repository.server";
const uuid="11111111-1111-4111-8111-111111111111";
const scope={businessId:"business",ownerUserId:"owner"};
const turn=(rpc:ReturnType<typeof vi.fn>)=>({
  scope,threadId:uuid,client:{rpc},
}) as never;
const row={id:uuid,business_id:"business",owner_user_id:"owner",thread_id:uuid,
  title:"Review morning",cadence:"daily",weekdays:[],local_time:"08:00:00",
  timezone:"America/Los_Angeles",status:"active",revision:1,
  created_at:"2026-11-11T00:00:00Z",updated_at:"2026-11-11T00:00:00Z"};
describe("owner-only routine mutation port",()=>{
  it("reads only the currently authenticated owner's café for the control center",async()=>{
    const q={
      select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),
      order:vi.fn().mockReturnThis(),limit:vi.fn(async()=>({data:[row],error:null})),
    };
    const client={from:vi.fn(()=>q)};
    const routines=await listOwnerRoutinesAcrossThreads(scope,client as never);
    expect(routines).toMatchObject([{id:uuid,title:"Review morning"}]);
    expect(client.from).toHaveBeenCalledWith("supervisor_routines");
    expect(q.eq.mock.calls).toEqual([["business_id","business"],["owner_user_id","owner"]]);
    expect(q.limit).toHaveBeenCalledWith(100);
    await expect(listOwnerRoutinesAcrossThreads({businessId:"",ownerUserId:"owner"},
      client as never)).rejects.toThrow("scope");
    expect(client.from).toHaveBeenCalledTimes(1);
  });
  it("binds identities to verified turn, not model fields",async()=>{
    const rpc=vi.fn(async()=>({data:row,error:null}));
    const saved=await createOwnerRoutine({title:"Review morning",cadence:"daily",
      weekdays:[],localTime:"08:00"},turn(rpc));
    expect(saved.id).toBe(uuid);
    expect(rpc).toHaveBeenCalledWith("create_supervisor_routine",expect.objectContaining({
      p_business_id:"business",p_owner_user_id:"owner",p_thread_id:uuid,
    }));
  });
  it("does not permit revoke or edit without optimistic revision",async()=>{
    const rpc=vi.fn(async()=>({data:row,error:null}));
    await expect(changeOwnerRoutine({id:uuid,revision:0,status:"revoked"},turn(rpc)))
      .rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("retries only with the same immutable occurrence identity",async()=>{
    const rpc=vi.fn(async()=>({data:{run_id:uuid,lease_token:uuid,revision:2},error:null}));
    const first=await claimRoutineOccurrence({rpc} as never,{
      businessId:"business",routineId:uuid,revision:2,localDate:"2026-11-11",
      dueAt:new Date("2026-11-11T08:00:00Z"),now:new Date("2026-11-11T08:05:00Z")});
    expect(first?.runId).toBe(uuid);
    expect(rpc).toHaveBeenCalledWith("supervisor_claim_current_routine_occurrence",expect.objectContaining({p_revision:2}));
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

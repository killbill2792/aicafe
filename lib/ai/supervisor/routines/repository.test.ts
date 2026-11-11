import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {createOwnerRoutine,changeOwnerRoutine,claimRoutineOccurrence} from "./repository.server";
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
      businessId:"business",routineId:uuid,localDate:"2026-11-11",
      dueAt:new Date("2026-11-11T08:00:00Z"),now:new Date("2026-11-11T08:05:00Z")});
    expect(first?.runId).toBe(uuid);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  claim:vi.fn(),finish:vi.fn(),notice:vi.fn(),
}));
vi.mock("./repository.server",()=>({
  claimRoutineOccurrence:mocks.claim,finishRoutineOccurrence:mocks.finish,
}));
vi.mock("./notices.server",()=>({postPriorityNotice:mocks.notice}));
import {dispatchRoutinesForBusiness,readActionablePriorities} from "./dispatch.server";
function db(params?:{routines?:Record<string,unknown>[];owners?:{user_id:string}[];
  threads?:{id:string;owner_user_id:string}[];alerts?:Record<string,unknown>[];
  tasks?:Record<string,unknown>[]}) {
  const rows:Record<string,unknown[]>={
    memberships:params?.owners??[{user_id:"owner"}],
    ai_threads:params?.threads??[{id:"thread",owner_user_id:"owner"}],
    supervisor_routines:params?.routines??[],
    alerts:params?.alerts??[],
    operating_tasks:params?.tasks??[],
  };
  return {from:(table:string)=>{
    const builder={
      select(){return builder},eq(){return builder},in(){return builder},
      neq(){return builder},or(){return builder},order(){return builder},
      async limit(){return {data:rows[table],error:null}},
    };
    return builder;
  }} as never;
}
const routine={business_id:"cafe",id:"routine",owner_user_id:"owner",thread_id:"thread",
  title:"Opening check",cadence:"daily",weekdays:[],local_time:"08:00:00",
  timezone:"America/Los_Angeles",status:"active",revision:1,
  created_at:"2026-11-10T00:00:00Z",updated_at:"2026-11-10T00:00:00Z"};
describe("bounded independent routine dispatch",()=>{
  it("evaluates new evidence without any routine due",async()=>{
    mocks.notice.mockResolvedValue("posted");
    const result=await dispatchRoutinesForBusiness(db({alerts:[{
      id:"a",kind:"missing_bill",status:"new",payload:{dedupeKey:"a"},
      created_at:"2026-11-10T00:00:00Z",
    }]}),"cafe","America/Los_Angeles",new Date("2026-11-11T16:00:00Z"));
    expect(result.notices).toBe(1);
    expect(result.runs).toBe(0);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
  });
  it("never starts another run after the DB rejects a duplicate claim",async()=>{
    mocks.claim.mockResolvedValue(null);
    const result=await dispatchRoutinesForBusiness(db({routines:[routine]}),
      "cafe","America/Los_Angeles",new Date("2026-11-11T18:00:00Z"));
    expect(result.routinesChecked).toBe(1);
    expect(result.runs).toBe(0);
    expect(mocks.finish).not.toHaveBeenCalled();
  });
  it("one revoked owner's missing thread cannot halt other owners",async()=>{
    const result=await dispatchRoutinesForBusiness(db({
      owners:[{user_id:"owner"},{user_id:"no-thread"}],
    }),"cafe","America/Los_Angeles",new Date("2026-11-11T18:00:00Z"));
    expect(result.failed).toBe(1);
  });
  it("does not mix private tasks across owners",async()=>{
    const decisions=await readActionablePriorities(db({tasks:[
      {id:"private",kind:"commitment",status:"needs_owner",
        created_at:"2026-11-10T00:00:00Z",owner_user_id:"other"},
    ]}),{businessId:"cafe",ownerUserId:"owner",threadId:"thread",localDate:"2026-11-11"},
      new Date("2026-11-11T00:00:00Z"));
    expect(decisions).toEqual([]);
  });
});

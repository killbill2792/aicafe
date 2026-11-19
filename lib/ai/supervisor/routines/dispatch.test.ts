import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  claim:vi.fn(),finish:vi.fn(),notice:vi.fn(),candidates:vi.fn(),
  staff:vi.fn(async()=>({published:0,attempted:0,blocked:0})),
  reconcile:vi.fn(async()=>({data:{completed:0,expired:0},error:null})),
}));
vi.mock("./repository.server",()=>({
  claimRoutineOccurrence:mocks.claim,finishRoutineOccurrence:mocks.finish,
  listRoutineOccurrenceCandidates:mocks.candidates,
}));
vi.mock("./notices.server",()=>({postPriorityNotice:mocks.notice}));
vi.mock("@/lib/scheduling/staffPublication.server",()=>({
  followUpStaffPublicationForBusiness:mocks.staff,
}));
import {dispatchRoutinesForBusiness,readActionablePriorities} from "./dispatch.server";
import {choosePriorities} from "./priority";
function db(params?:{routines?:Record<string,unknown>[];owners?:{user_id:string}[];
  threads?:{id:string;owner_user_id:string}[];alerts?:Record<string,unknown>[];
  tasks?:Record<string,unknown>[];proposals?:Record<string,unknown>[]}) {
  const rows:Record<string,Record<string,unknown>[]>={
    memberships:params?.owners??[{user_id:"owner"}],
    ai_threads:params?.threads??[{id:"thread",owner_user_id:"owner"}],
    supervisor_routines:params?.routines??[],
    alerts:params?.alerts??[],
    operating_tasks:params?.tasks??[],
    supervisor_proposals:params?.proposals??[],
  };
  return {rpc:async(name:string)=>{
    if(name==="staff_coordination_reconcile")return mocks.reconcile();
    if(!["staff_channel_sync_shift_requests","staff_channel_escalate_unanswered","supervisor_sync_supplier_receiving_tasks"].includes(name))
      throw new Error("unexpected staff channel RPC "+name);
    return {data:0,error:null};
  },from:(table:string)=>{
    let selected=rows[table];
    const builder={
      select(){return builder},
      eq(field:string,value:unknown){
        if((table==="operating_tasks"&&(field==="kind"||field==="owner_user_id"))||
          (table==="supervisor_proposals"&&["business_id","owner_user_id","capability_id","status"].includes(field)))
          selected=selected.filter(row=>row[field]===value);
        return builder;
      },
      in(field:string,values:string[]){
        if(table==="operating_tasks"&&field==="dedupe_key")
          selected=selected.filter(row=>values.includes(String(row.dedupe_key)));
        return builder;
      },
      neq(){return builder},
      // Mirror the PostgREST negated IN predicate used by the production
      // scanner. A no-op mock returned commitments and falsely failed CI.
      not(field:string,operator:string,value:string){
        if(table!=="operating_tasks"||field!=="kind"||operator!=="in"||
          value!=="(priority_notice,commitment,event_plan,event_change,event_report)")
          throw new Error("Unexpected priority task exclusion");
        const forbidden=new Set(value.slice(1,-1).split(","));
        selected=selected.filter(row=>!forbidden.has(String((row as Record<string,unknown>)[field])));
        return builder;
      },
      or(){return builder},order(){return builder},
      lte(field:string,value:string){
        if(table==="supervisor_proposals")
          selected=selected.filter(row=>typeof row[field]==="string"&&String(row[field])<=value);
        return builder;
      },
      async limit(){return {data:selected,error:null}},
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
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
  });
  it("preserves Task 13B staff publication and Task 15A durable discovery in one cron",async()=>{
    const now=new Date("2026-11-11T16:00:00Z");
    const source=db({alerts:[{id:"alert",kind:"missing_bill",status:"new",
      payload:{dedupeKey:"alert"},created_at:"2026-11-10T00:00:00Z"}]});
    const enqueue=vi.fn(async()=>1);
    mocks.staff.mockClear();mocks.notice.mockResolvedValue("posted");
    const result=await dispatchRoutinesForBusiness(source,
      "cafe","America/Los_Angeles",now,enqueue);
    expect(mocks.staff).toHaveBeenCalledOnce();
    expect(mocks.staff).toHaveBeenCalledWith(source,"cafe","2026-11-11");
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(source,{
      businessId:"cafe",ownerUserId:"owner",threadId:"thread",localDate:"2026-11-11",
    },now);
    expect(result).toMatchObject({notices:1,investigationsQueued:1,failed:0});
  });
  it("never starts another run after the DB rejects a duplicate claim",async()=>{
    mocks.candidates.mockResolvedValue([{localDate:"2026-11-11",scheduledForUtc:null}]);
    mocks.claim.mockResolvedValue(null);
    const result=await dispatchRoutinesForBusiness(db({routines:[routine]}),
      "cafe","America/Los_Angeles",new Date("2026-11-11T18:00:00Z"));
    expect(result.routinesChecked).toBe(1);
    expect(result.runs).toBe(0);
    expect(mocks.finish).not.toHaveBeenCalled();
    expect(mocks.claim).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({localDate:"2026-11-11",revision:1}));
  });
  it("replays missed authorized dates using their original identity and current evidence",async()=>{
    mocks.candidates.mockReset().mockResolvedValue([
      {localDate:"2026-11-09",scheduledForUtc:null},
      {localDate:"2026-11-10",scheduledForUtc:null},
      {localDate:"2026-11-11",scheduledForUtc:"2026-11-11T16:00:00Z"},
    ]);
    mocks.claim.mockReset().mockResolvedValue({runId:"saved-run",leaseToken:"new-lease",revision:1});
    mocks.finish.mockReset().mockResolvedValue(true);
    const result=await dispatchRoutinesForBusiness(db({routines:[routine]}),"cafe","America/Los_Angeles",
      new Date("2026-11-12T18:00:00Z"));
    expect(result).toMatchObject({runs:2,failed:0});
    expect(mocks.claim.mock.calls.map(call=>call[1].localDate)).toEqual(["2026-11-10","2026-11-11"]);
    expect(mocks.claim.mock.calls.every(call=>call[1].revision===1)).toBe(true);
    expect(mocks.finish).toHaveBeenCalledTimes(2);
    expect(mocks.finish.mock.calls.every(call=>call[1].runId==="saved-run"&&call[1].success)).toBe(true);
  });
  it("one revoked owner's missing thread cannot halt other owners",async()=>{
    const result=await dispatchRoutinesForBusiness(db({
      owners:[{user_id:"owner"},{user_id:"no-thread"}],
    }),"cafe","America/Los_Angeles",new Date("2026-11-11T18:00:00Z"));
    expect(result.failed).toBe(1);
    expect(mocks.staff).toHaveBeenCalledWith(expect.anything(),"cafe","2026-11-11");
  });
  it("excludes already-delivered commitments and generated notices, keeping independent work",async()=>{
    const decisions=await readActionablePriorities(db({tasks:[
      {id:"commitment:existing",kind:"commitment",status:"needs_owner",
        created_at:"2026-11-10T00:00:00Z",owner_user_id:"owner"},
      {id:"priority:existing",kind:"priority_notice",status:"needs_owner",
        created_at:"2026-11-10T00:00:00Z",owner_user_id:"owner"},
      {id:"events:planned",kind:"event_plan",status:"needs_owner",
        created_at:"2026-11-10T00:00:00Z",owner_user_id:"owner"},
      {id:"events:changed",kind:"event_change",status:"needs_owner",
        created_at:"2026-11-10T00:00:00Z",owner_user_id:"owner"},
      {id:"events:report",kind:"event_report",status:"needs_owner",
        created_at:"2026-11-10T00:00:00Z",owner_user_id:"owner"},
      {id:"needs-review",kind:"data_quality",status:"needs_owner",
        created_at:"2026-11-10T00:00:00Z",owner_user_id:"owner"},
    ]}),{businessId:"cafe",ownerUserId:"owner",threadId:"thread",localDate:"2026-11-11"},
      new Date("2026-11-11T00:00:00Z"));
    expect(decisions.map(d=>d.source.sourceId)).toEqual(["needs-review"]);
  });
  it("skips the first three already-notified revisions so a fourth alert is delivered",async()=>{
    const now=new Date("2026-11-11T00:00:00Z");
    const alerts=Array.from({length:4},(_,i)=>({
      id:"alert-"+i,kind:"voids",status:"new",payload:{severity:"high"},
      created_at:new Date(Date.parse("2026-11-10T00:00:00Z")+i*60_000).toISOString(),
    }));
    const sourceRows=alerts.map(row=>({
      businessId:"cafe",ownerUserId:"owner",sourceType:"alert" as const,
      sourceId:row.id,kind:row.kind,status:row.status,
      createdAt:row.created_at,severity:"high",evidence:row.payload,
    }));
    const already=choosePriorities(sourceRows,now,3).map(decision=>({
      id:"priority:"+decision.stableKey,kind:"priority_notice",
      status:"needs_owner",owner_user_id:"owner",dedupe_key:decision.stableKey,
    }));
    const source=db({alerts,tasks:already});
    const scope={businessId:"cafe",ownerUserId:"owner",threadId:"thread",localDate:"2026-11-11"};
    const decisions=await readActionablePriorities(source,scope,now);
    expect(decisions.map(d=>d.source.sourceId)).toEqual(["alert-3"]);
    mocks.notice.mockReset().mockResolvedValue("posted");
    const result=await dispatchRoutinesForBusiness(source,"cafe","America/Los_Angeles",now);
    expect(result.notices).toBe(1);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][2].source.sourceId).toBe("alert-3");
  });
  it("proactively notifies a verified pending PO in its original owner thread, never a fresh or foreign draft",async()=>{
    mocks.notice.mockReset().mockResolvedValue("posted");
    const now=new Date("2026-11-14T08:00:00Z");
    const old={id:"po-old",business_id:"cafe",owner_user_id:"owner",
      thread_id:"original-thread",capability_id:"maya.supplier_purchase_order.v1",
      status:"draft",revision:2,created_at:"2026-11-13T00:00:00Z"};
    const fresh={...old,id:"po-fresh",created_at:"2026-11-14T07:30:00Z"};
    const foreign={...old,id:"po-foreign",owner_user_id:"other"};
    const rows=db({proposals:[old,fresh,foreign]});
    const decisions=await readActionablePriorities(rows,{
      businessId:"cafe",ownerUserId:"owner",threadId:"latest-thread",localDate:"2026-11-14"},now);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].source).toMatchObject({
      sourceType:"supplier_po",sourceId:"po-old",sourceThreadId:"original-thread",status:"draft"
    });
    expect(decisions[0].reason).toBe("Supplier purchase-order draft needs your approval");
    const outcome=await dispatchRoutinesForBusiness(rows,"cafe","America/Los_Angeles",now);
    expect(outcome.notices).toBe(1);
    expect(mocks.notice).toHaveBeenCalledWith(expect.anything(),
      expect.objectContaining({threadId:"original-thread"}),
      expect.objectContaining({source:expect.objectContaining({sourceType:"supplier_po"})}),now);
  });
  it("Task14B drafts remain actionable notices but cannot crowd out Task15A investigations",async()=>{
    const now=new Date("2026-11-16T14:00:00Z");
    const proposals=Array.from({length:90},(_,i)=>({
      id:"saved-po-"+i,business_id:"cafe",owner_user_id:"owner",
      thread_id:"original-po-thread",capability_id:"maya.supplier_purchase_order.v1",
      status:"draft",revision:1,created_at:"2026-11-13T00:00:00Z",
    }));
    const src=db({proposals,alerts:[{
      id:"urgent-alert",kind:"voids",status:"new",payload:{severity:"high"},
      created_at:"2026-11-16T12:00:00Z",
    }],tasks:[{
      id:"watching-task",kind:"staff_coverage",status:"watching",
      owner_user_id:"owner",created_at:"2026-11-16T11:00:00Z",
      confidence:"high",evidence:[{source:"schedule"}],
    }]});
    const scope={businessId:"cafe",ownerUserId:"owner",
      threadId:"owner-thread",localDate:"2026-11-16"};
    const notices=await readActionablePriorities(src,scope,now);
    expect(notices.some(x=>x.source.sourceType==="supplier_po")).toBe(true);
    const investigations=await readActionablePriorities(src,scope,now,
      {includeNotified:true,limit:2});
    expect(investigations.map(x=>x.source.sourceType)).toEqual([
      "alert","operating_task",
    ]);
    expect(investigations.map(x=>x.source.sourceId)).toContain("urgent-alert");
    expect(investigations.map(x=>x.source.sourceId)).toContain("watching-task");
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

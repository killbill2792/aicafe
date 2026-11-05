import {beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

vi.mock("server-only",()=>({}));
const readers=vi.hoisted(()=>({read:vi.fn()}));
vi.mock("@/lib/data/operatingTasks",()=>({readPersistedOperatingTasks:readers.read}));

import {createOwnerCommitment,closeOwnerCommitment,deliverDueCommitments,deliverPendingCommitments,listOwnerCommitments}
  from "./commitments.server";

const thread="9c57ad76-7be3-4fb0-870f-e9f33cd5ff53";
const title="Check coffee order";
const date="2026-11-10";
const utc="2026-11-10T05:00:00.000Z";
const ownerScope={businessId:"business-one",ownerUserId:"owner-one"};
const verified=()=>({scope:ownerScope,threadId:thread,client:session as unknown as SupabaseClient});
let status:"watching"|"needs_owner"|"handled";
let created:Map<string,Record<string,unknown>>;
let calls:string[];
let rows:unknown[];
let session:{rpc:(name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:null}>};

beforeEach(()=>{
  status="watching";created=new Map();calls=[];rows=[];
  readers.read.mockImplementation(async()=>rows);
  session={rpc:async(name,args)=>{
    calls.push(name);
    if(name==="create_operating_commitment"){
      const key=String(args.p_title).toLowerCase()+":"+args.p_due_date+":"+args.p_due_time;
      if(!created.has(key))created.set(key,{id:"commitment:stable",status:"watching",
        payload:{title:args.p_title},due_local_date:args.p_due_date,
        due_local_time:args.p_due_time,due_timezone:"America/New_York",
        origin:args.p_origin});
      return {data:created.get(key),error:null};
    }
    if(name==="close_operating_commitment"){
      if(args.p_task_id!=="commitment:stable")return {data:false,error:null};
      status="handled";
      const existing=created.get(title.toLowerCase()+":"+date+":null");
      if(existing)existing.status="handled";
      return {data:true,error:null};
    }
    return {data:null,error:null};
  }};
});

describe("durable owner commitments",()=>{
  it("saves two identical requests as one record and reads it after a fresh request",async()=>{
    const input={title,origin:"owner_chat" as const,dueDate:date,dueTime:null,threadId:thread};
    const first=await createOwnerCommitment(input,verified());
    const duplicate=await createOwnerCommitment({...input,title:title.toUpperCase()},verified());
    expect(first.id).toBe(duplicate.id);
    expect(created.size).toBe(1);
    expect(first).toMatchObject({status:"watching",dueDate:date,dueTime:null,
      timezone:"America/New_York"});
    rows=[{id:first.id,kind:"commitment",ownerUserId:"owner-one",origin:first.origin,
      status:"watching",payload:{title},dueLocalDate:date,dueLocalTime:null,dueTimezone:first.timezone},
      {id:"other-owner",kind:"commitment",ownerUserId:"owner-two",status:"watching",payload:{title:"Private"}}];
    expect(await listOwnerCommitments(verified())).toEqual([first]);
    expect(readers.read).toHaveBeenCalledWith("business-one",expect.objectContaining({
      client:session,businessId:"business-one",ownerUserId:"owner-one",
    }));
  });

  it("closing from chat is idempotent, and the same request cannot revive the closed row",async()=>{
    const input={title,origin:"owner_chat" as const,dueDate:date,dueTime:null,threadId:thread};
    await createOwnerCommitment(input,verified());
    expect(await closeOwnerCommitment("commitment:stable",verified())).toBe(true);
    expect(await closeOwnerCommitment("commitment:stable",verified())).toBe(true);
    const again=await createOwnerCommitment(input,verified());
    // The stored fixture emulates the database's immutable, unique commitment row.
    expect(again).toMatchObject({id:"commitment:stable",status:"handled"});
    expect(created.size).toBe(1);
    expect(calls.filter(x=>x==="close_operating_commitment")).toHaveLength(2);
  });

  it("uses the verified WhatsApp turn client without any browser session",async()=>{
    const input={title,origin:"owner_chat" as const,dueDate:date,dueTime:null,threadId:thread};
    // The only client in this fixture is the externally verified sessionless one.
    // No auth cookie helper is mocked; the service must use the supplied scope.
    const external=verified();
    const saved=await createOwnerCommitment(input,external);
    expect(saved.id).toBe("commitment:stable");
    expect(calls).toContain("create_operating_commitment");
    expect(await closeOwnerCommitment(saved.id,external)).toBe(true);
    await expect(createOwnerCommitment({...input,threadId:"00000000-0000-4000-8000-000000000001"},
      external)).rejects.toThrow("Commitment thread scope mismatch");
  });

  it("marks a due item once across two runs and uses one atomic database call",async()=>{
    const due=[{id:"commitment:stable",dueAt:utc,payload:{threadId:thread},due_local_date:date}];
    const claimed:string[]=[];
    const db={
      from:(table:string)=>{
        expect(table).toBe("operating_tasks");
        const q={
          select:()=>q,eq:()=>q,lte:()=>q,order:()=>q,
          limit:async()=>({data:status==="watching"?due:[],error:null}),
        };
        return q;
      },
      rpc:async(name:string,args:Record<string,unknown>)=>{
        expect(name).toBe("deliver_due_operating_commitment");
        expect(args).toMatchObject({p_business_id:"business-one",p_owner_user_id:"owner-one",
          p_task_id:"commitment:stable"});
        if(status!=="watching")return {data:false,error:null};
        status="needs_owner";claimed.push(String(args.p_task_id));
        return {data:true,error:null};
      },
    } as unknown as SupabaseClient;
    const scope={businessId:"business-one",ownerUserId:"owner-one"};
    expect(await deliverDueCommitments(db,scope,new Date(utc))).toEqual({delivered:1,remaining:0,failed:0});
    expect(await deliverDueCommitments(db,scope,new Date(utc))).toEqual({delivered:0,remaining:0,failed:0});
    expect(claimed).toEqual(["commitment:stable"]);
  });

  it("the existing cron discovers pending owner scopes and retries a failed item without blocking the next",async()=>{
    const scope={business_id:"business-one",owner_user_id:"owner-one"};
    const pending=[{id:"bad",payload:{threadId:thread},due_local_date:date},
      {id:"good",payload:{threadId:thread},due_local_date:date}];
    let deliveredGood=false;
    let dueQueries=0;
    const db={
      from:()=>{const q={
        select:()=>q,eq:()=>q,lte:()=>q,order:()=>q,
        limit:async()=>{
          dueQueries++;
          return {data:dueQueries%2===1?[scope]:pending.filter(x=>x.id!=="good"||!deliveredGood),error:null};
        },
      };return q;},
      rpc:async(name:string,args:Record<string,unknown>)=>{
        expect(name).toBe("deliver_due_operating_commitment");
        if(args.p_task_id==="bad")return {data:null,error:{code:"temporary_failure"}};
        deliveredGood=true;return {data:true,error:null};
      },
    } as unknown as SupabaseClient;
    const first=await deliverPendingCommitments(db,new Date(utc));
    expect(first).toEqual({scopes:1,delivered:1,failed:1});
    const second=await deliverPendingCommitments(db,new Date(utc));
    expect(second).toEqual({scopes:1,delivered:0,failed:1});
  });

  it("uses the resolved due instant across daylight-saving transitions, not a UTC day",async()=>{
    // Local 09:00 in New York is 13:00Z in summer, 14:00Z after fall-back.
    const summer="2026-07-07T13:00:00.000Z",winter="2026-11-10T14:00:00.000Z";
    const captured:string[]=[];
    const db={
      from:()=>{const q={
        select:()=>q,eq:()=>q,lte:(field:string,when:string)=>{
          captured.push(field+":"+when);return q;},order:()=>q,
        limit:async()=>({data:[],error:null}),
      };return q;},
    } as unknown as SupabaseClient;
    for(const instant of [summer,winter]){
      expect(await deliverDueCommitments(db,{businessId:"business-one",ownerUserId:"owner-one"},
        new Date(instant))).toEqual({delivered:0,remaining:0,failed:0});
    }
    expect(captured).toEqual(["due_at:"+summer,"due_at:"+winter]);
  });
});

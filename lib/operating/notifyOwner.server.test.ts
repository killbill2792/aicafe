import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {notifyOwner,type OwnerNoticeRequest} from "./notifyOwner.server";
import {deliverOwnerTemplate} from "@/lib/ai/notifications/whatsapp.server";

type Row={id:string;business_id:string;payload:Record<string,unknown>};
function fixture(){
  const tasks:Row[]=[];
  const messages:Array<{id:string;threadId:string}>=[];
  const db={
    from:(table:string)=>{
      const filters:Array<(row:Row)=>boolean>=[];
      const q={
        select:(_columns:string,_options?:unknown)=>q,
        eq:(key:string,value:unknown)=>{filters.push(r=>(r as unknown as Record<string,unknown>)[key]===value);return q;},
        contains:(_column:string,value:Record<string,unknown>)=>{
          filters.push(r=>Object.entries(value).every(([key,wanted])=>r.payload[key]===wanted));return q;
        },
        maybeSingle:async()=>({data:tasks.find(r=>filters.every(f=>f(r)))??null,error:null}),
        then:(resolve:(value:unknown)=>void)=>resolve({count:tasks.filter(r=>filters.every(f=>f(r))).length,error:null}),
      };
      if(table!=="operating_tasks")throw new Error("Unexpected notification table");
      return q;
    },
  };
  return {db:db as never,tasks,messages};
}
const request:OwnerNoticeRequest={
  businessId:"b0000000-0000-4000-8000-000000000001",
  ownerUserId:"a0000000-0000-4000-8000-000000000001",
  threadId:"c0000000-0000-4000-8000-000000000001",
  taskId:"event-change:verified-source-and-date",
  kind:"event_change",localDate:"2026-11-04",important:true,
};
function writeNotice(f:ReturnType<typeof fixture>,r:OwnerNoticeRequest){
  return async()=>{
    if(!f.tasks.some(t=>t.id===r.taskId))
      f.tasks.push({id:r.taskId,business_id:r.businessId,
        payload:{threadId:r.threadId,ownerNoticeDate:r.localDate}});
    const messageId="message:"+r.taskId;
    if(!f.messages.some(m=>m.id===messageId))
      f.messages.push({id:messageId,threadId:r.threadId});
    return f.messages.length;
  };
}
describe("one owner notice decision",()=>{
  it("three identical findings leave one inbox notice and one message",async()=>{
    const f=fixture();
    for(let attempt=0;attempt<3;attempt++){
      const result=await notifyOwner(f.db,request,writeNotice(f,request));
      expect(result.decision).toBe("posted");
    }
    expect(f.tasks).toHaveLength(1);
    expect(f.messages).toEqual([{id:"message:"+request.taskId,threadId:request.threadId}]);
  });
  it("respects muted kinds, disallowed channels and a café-local daily cap",async()=>{
    const f=fixture();
    const write=vi.fn(writeNotice(f,request));
    expect((await notifyOwner(f.db,{...request,policy:{mutedKinds:[request.kind]}},write)).decision)
      .toBe("muted");
    expect((await notifyOwner(f.db,{...request,policy:{allowedChannels:["whatsapp"]}},write)).decision)
      .toBe("channel_blocked");
    f.tasks.push({id:"another-finding",business_id:request.businessId,
      payload:{ownerNoticeDate:request.localDate}});
    expect((await notifyOwner(f.db,{...request,policy:{dailyCap:1}},write)).decision).toBe("capped");
    expect(write).not.toHaveBeenCalled();
  });
  it("repairs a partially written notice even when the daily cap is full",async()=>{
    const f=fixture();
    f.tasks.push({id:request.taskId,business_id:request.businessId,
      payload:{ownerNoticeDate:request.localDate}});
    const result=await notifyOwner(f.db,{...request,policy:{dailyCap:0}},writeNotice(f,request));
    expect(result.decision).toBe("posted");
    expect(f.tasks).toHaveLength(1);
    expect(f.messages).toEqual([{id:"message:"+request.taskId,threadId:request.threadId}]);
  });
  it("keeps the correct owner thread and never marks failed WhatsApp as delivered",async()=>{
    const f=fixture();
    const result=await notifyOwner(f.db,request,writeNotice(f,request));
    vi.stubEnv("AI_CAFE_WHATSAPP_ENABLED","true");
    vi.stubEnv("META_WHATSAPP_TOKEN","test-only-token");
    vi.stubEnv("META_WHATSAPP_PHONE_ID","test-only-sender");
    vi.stubEnv("CRON_SECRET","test-only-secret");
    const rejectedSend=vi.fn(async()=>new Response(null,{status:503}));
    let failedWhatsApp;
    try{
      failedWhatsApp=await deliverOwnerTemplate("+15551234567","menu price review",rejectedSend);
    }finally{
      vi.unstubAllEnvs();
    }
    expect(rejectedSend).toHaveBeenCalledTimes(1);
    expect(failedWhatsApp).toEqual({sent:false,reason:"provider_rejected"});
    expect(result.threadId).toBe(request.threadId);
    expect(f.messages[0].threadId).toBe(request.threadId);
    expect(result.channels).toEqual({inApp:"posted",whatsapp:"not_delivered"});
  });
  it("does not publish irrelevant findings, but never blocks required reports",async()=>{
    const f=fixture();
    const write=vi.fn(writeNotice(f,request));
    expect((await notifyOwner(f.db,{...request,important:false},write)).decision).toBe("ignored");
    expect((await notifyOwner(f.db,{...request,required:true,
      policy:{mutedKinds:[request.kind],dailyCap:0}},write)).decision).toBe("posted");
    expect(write).toHaveBeenCalledTimes(1);
  });
});

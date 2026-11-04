import {beforeEach,describe,expect,it,vi} from "vitest";
import {sameEventReportFacts,SupabaseLoopRepository} from "./supabase.server";
import type {LoopProposal,LoopReport,OwnerLoopScope} from "./engine";

vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({
  previous:null as {report:Record<string,unknown>;status:string}|null,
  writes:[] as Array<{table:string;operation:string;row:Record<string,unknown>}>,
  tasks:new Map<string,Record<string,unknown>>(),
  messages:new Map<string,Record<string,unknown>>(),
  failOnce:null as null|"task"|"taskUpdate"|"message"|"timezone"|"lookup",
}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
  from:(table:string)=>{
    const filters:Record<string,unknown>={};
    // The mock models durable rows, not merely calls: a successful report upsert
    // must survive a later inbox/message failure and be seen by the retry.
    const query:Record<string,unknown>={};
    query.select=()=>query;
    query.eq=(column:string,value:unknown)=>{filters[column]=value;return query;};
    query.contains=(column:string,value:unknown)=>{filters[column]=value;return query;};
    query.limit=()=>query;
    query.maybeSingle=async()=>{
      if(table==="supervisor_reports")return {data:state.previous,error:null};
      if(table==="operating_tasks")return {
        data:state.tasks.get(String(filters.id))??null,error:null};
      if(table==="ai_messages"){
        if(state.failOnce==="lookup"){
          state.failOnce=null;return {data:null,error:{code:"READ_UNAVAILABLE"}};
        }
        const probe=(filters.grounding as {evidence?:Array<{identifier:string;source:string}>})
          ?.evidence?.[0];
        const found=[...state.messages.values()].find(message=>{
          const evidence=(message.grounding as {
            evidence?:Array<{identifier:string;source:string}>}|undefined)?.evidence??[];
          return message.business_id===filters.business_id&&
            message.owner_user_id===filters.owner_user_id&&
            message.thread_id===filters.thread_id&&message.role===filters.role&&
            evidence.some(e=>e.identifier===probe?.identifier&&e.source===probe?.source);
        });
        return {data:found?{id:found.id}:null,error:null};
      }
      return {data:null,error:null};
    };
    query.single=async()=>{
      if(state.failOnce==="timezone"){
        state.failOnce=null;return {data:null,error:{code:"NO_TIMEZONE"}};
      }
      return {data:{timezone:"America/Los_Angeles"},error:null};
    };
    query.upsert=async(row:Record<string,unknown>)=>{
      state.writes.push({table,operation:"upsert",row});
      if(table==="supervisor_reports")state.previous={
        report:row.report as Record<string,unknown>,status:String(row.status)};
      if(table==="operating_tasks"){
        if(state.failOnce==="task"){
          state.failOnce=null;return {error:{code:"INBOX_UNAVAILABLE"}};
        }
        if(!state.tasks.has(String(row.id)))state.tasks.set(String(row.id),row);
      }
      return {error:null};
    };
    query.insert=async(row:Record<string,unknown>)=>{
      state.writes.push({table,operation:"insert",row});
      if(table==="ai_messages"){
        if(state.failOnce==="message"){
          state.failOnce=null;return {error:{code:"MESSAGE_UNAVAILABLE"}};
        }
        if(state.messages.has(String(row.id)))return {error:{code:"23505"}};
        state.messages.set(String(row.id),row);
      }
      return {error:null};
    };
    query.update=(row:Record<string,unknown>)=>{
      state.writes.push({table,operation:"update",row});
      query.then=(resolve:(value:{error:unknown})=>void)=>{
        if(state.failOnce==="taskUpdate"){
          state.failOnce=null;resolve({error:{code:"INBOX_UPDATE_UNAVAILABLE"}});return;
        }
        const current=state.tasks.get(String(filters.id));
        if(current)state.tasks.set(String(filters.id),{...current,...row});
        resolve({error:null});
      };
      return query;
    };
    return query;
  },
})}));
const scope:OwnerLoopScope={businessId:"cafe",ownerUserId:"owner",
  threadId:"thread",locale:"en"};
const proposal={id:"proposal",capabilityId:"alex.event_readiness.v1",
  threadId:scope.threadId} as LoopProposal;
const taskId="supervisor:"+proposal.capabilityId+":"+proposal.id;
const facts={startDate:"2026-11-02",endDate:"2026-11-02",
  days:[{date:"2026-11-02",actualCents:135844,typicalCents:120605,
    hours:[{hourLocal:7,actualCents:10550,usualCents:6135}]}],
  observedDays:1,expectedDays:1};
const result=()=>({...facts,reportText:"Sales $1,358.44",reportFactsHash:"v2",
  reportTextOrigin:"model",reportProvenance:[]});
const report=(data:Record<string,unknown>):LoopReport=>({
  status:"complete",source:"hourly_sales_rollup+daily_rollups",
  recommendation:"adjust",result:data,
  delivery:{agentId:"alex",taskKind:"event_plan",entityType:"event_day",
    entityId:"2026-11-02",confidence:"high",
    payload:{businessDate:"2026-11-02"},evidence:[],
    threadText:String(data.reportText)},
}) as LoopReport;
const previous=(data:Record<string,unknown>=facts)=>{
  state.previous={status:"complete",report:{
    ...data,source:"hourly_sales_rollup+daily_rollups",recommendation:"adjust",
    reportText:"Sales 135,844; currency not provided",
    reportFactsHash:"legacy-hash",reportTextOrigin:"model",reportProvenance:[],
    reportNumericEvidence:[],
  }};
};
/** A historical successful delivery has BOTH a persisted inbox row and a
 * scoped Supervisor chat message bearing the existing report evidence key. */
const delivered=()=>{
  state.tasks.set(taskId,{id:taskId,business_id:scope.businessId,status:"handled"});
  state.messages.set("historical-message-id",{
    id:"historical-message-id",business_id:scope.businessId,
    owner_user_id:scope.ownerUserId,thread_id:scope.threadId,role:"supervisor",
    grounding:{evidence:[{source:"operating_tasks",
      identifier:"supervisor-report:"+proposal.id}]},
  });
};
const save=()=>new SupabaseLoopRepository().saveReport(scope,proposal,report(result()));

describe("cached Events final report formatting and delivery retry",()=>{
  beforeEach(()=>{
    state.previous=null;state.writes.length=0;
    state.tasks.clear();state.messages.clear();state.failOnce=null;
  });
  it("compares all factual inputs, ignoring only narrative/provenance presentation",()=>{
    previous();
    expect(sameEventReportFacts(state.previous!.report,{
      ...facts,source:"hourly_sales_rollup+daily_rollups",recommendation:"adjust",
      reportText:"Sales $1,358.44",reportFactsHash:"v2",
      reportTextOrigin:"model",reportProvenance:[{start:6,end:15,source:"owner"}],
    })).toBe(true);
    expect(sameEventReportFacts(state.previous!.report,{
      ...facts,days:[{date:"2026-11-02",actualCents:135845}],
      source:"hourly_sales_rollup+daily_rollups",recommendation:"adjust",
      reportText:"Sales $1,358.45",
    })).toBe(false);
  });
  it("refreshes a legacy report after confirmed delivery without an extra message or alert",async()=>{
    previous();delivered();
    await save();
    expect(state.writes.map(x=>[x.table,x.operation])).toEqual([
      ["supervisor_reports","upsert"]]);
    expect(state.previous?.report.reportText).toBe("Sales $1,358.44");
    expect(state.messages.size).toBe(1);
    expect(state.tasks.size).toBe(1);
    expect(state.tasks.get(taskId)?.status).toBe("handled");
    await save();
    expect(state.messages.size).toBe(1);
    expect(state.tasks.size).toBe(1);
  });
  it("retries after the report was saved but the inbox failed, then delivers once",async()=>{
    previous();state.failOnce="task";
    await expect(save()).rejects.toThrow("Operations report inbox unavailable");
    expect(state.previous?.report.reportText).toBe("Sales $1,358.44");
    expect(state.tasks.size).toBe(0);
    expect(state.messages.size).toBe(0);
    await save();
    expect(state.tasks.size).toBe(1);
    expect(state.messages.size).toBe(1);
    await save();
    expect(state.tasks.size).toBe(1);
    expect(state.messages.size).toBe(1);
    expect(state.writes.filter(x=>x.table==="ai_messages")).toHaveLength(1);
  });
  it("retries a failed chat insert after a successful inbox write without duplicates",async()=>{
    previous();state.failOnce="message";
    await expect(save()).rejects.toThrow("Supervisor thread report unavailable");
    expect(state.tasks.size).toBe(1);
    expect(state.messages.size).toBe(0);
    await save();
    await save();
    expect(state.tasks.size).toBe(1);
    expect(state.messages.size).toBe(1);
    const attempts=state.writes.filter(x=>x.table==="ai_messages");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].row.id).toBe(attempts[1].row.id);
    expect(state.writes.filter(x=>x.table==="operating_tasks"&&
      x.operation==="upsert").map(x=>x.row.id)).toEqual([taskId,taskId]);
  });
  it("retries a failed timezone lookup after the inbox succeeded",async()=>{
    previous();state.failOnce="timezone";
    await expect(save()).rejects.toThrow("Café timezone unavailable");
    expect(state.tasks.size).toBe(1);
    expect(state.messages.size).toBe(0);
    await save();
    expect(state.messages.size).toBe(1);
  });
  it("repairs a missing inbox without reposting an already delivered chat message",async()=>{
    previous();delivered();
    state.tasks.clear();
    await save();
    expect(state.tasks.size).toBe(1);
    expect(state.messages.size).toBe(1);
    expect(state.writes.map(x=>x.table)).toEqual([
      "supervisor_reports","operating_tasks","operating_tasks"]);
  });
  it("fails visibly rather than suppressing delivery on an unreadable receipt",async()=>{
    previous();delivered();state.failOnce="lookup";
    await expect(save()).rejects.toThrow("Supervisor report delivery lookup unavailable");
    expect(state.writes.map(x=>x.table)).toEqual(["supervisor_reports"]);
  });
  it("still delivers corrected factual evidence after a Toast change",async()=>{
    previous({...facts,days:[{date:"2026-11-02",actualCents:125844}]});
    delivered();
    await save();
    expect(state.writes.map(x=>x.table)).toEqual([
      "supervisor_reports","operating_tasks","operating_tasks","ai_messages"]);
    expect(state.messages.size).toBe(2);
    expect(state.tasks.size).toBe(1);
  });
});

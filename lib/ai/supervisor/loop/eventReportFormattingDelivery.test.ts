import {beforeEach,describe,expect,it,vi} from "vitest";
import {sameEventReportFacts,SupabaseLoopRepository} from "./supabase.server";
import type {LoopProposal,LoopReport,OwnerLoopScope} from "./engine";

vi.mock("server-only",()=>({}));
const state=vi.hoisted(()=>({
  previous:null as {report:Record<string,unknown>;status:string}|null,
  writes:[] as Array<{table:string;operation:string;row:Record<string,unknown>}>,
}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({
  from:(table:string)=>{
    // Explicitly typed to avoid recursive inference in a self-returning query mock.
    const query:Record<string,unknown>={};
    for(const method of ["select","eq"])query[method]=()=>query;
    query.maybeSingle=async()=>({data:table==="supervisor_reports"?state.previous:null,error:null});
    query.single=async()=>({data:{timezone:"America/Los_Angeles"},error:null});
    query.upsert=async(row:Record<string,unknown>)=>{
      state.writes.push({table,operation:"upsert",row});
      if(table==="supervisor_reports")state.previous={
        report:row.report as Record<string,unknown>,status:String(row.status)};
      return {error:null};
    };
    query.insert=async(row:Record<string,unknown>)=>{
      state.writes.push({table,operation:"insert",row});return {error:null};
    };
    query.update=(row:Record<string,unknown>)=>{
      state.writes.push({table,operation:"update",row});return query;
    };
    return query;
  },
})}));
const scope:OwnerLoopScope={businessId:"cafe",ownerUserId:"owner",
  threadId:"thread",locale:"en"};
const proposal={id:"proposal",capabilityId:"alex.event_readiness.v1",
  threadId:scope.threadId} as LoopProposal;
const facts={startDate:"2026-11-02",endDate:"2026-11-02",
  days:[{date:"2026-11-02",actualCents:135844,typicalCents:120605,
    hours:[{hourLocal:7,actualCents:10550,usualCents:6135}]}],
  observedDays:1,expectedDays:1};
const report=(result:Record<string,unknown>):LoopReport=>({
  status:"complete",source:"hourly_sales_rollup+daily_rollups",
  recommendation:"adjust",result,
  delivery:{agentId:"alex",taskKind:"event_plan",entityType:"event_day",
    entityId:"2026-11-02",confidence:"high",
    payload:{businessDate:"2026-11-02"},evidence:[],
    threadText:String(result.reportText)},
}) as LoopReport;
const previous=(data:Record<string,unknown>=facts)=>{
  state.previous={status:"complete",report:{
    ...data,source:"hourly_sales_rollup+daily_rollups",recommendation:"adjust",
    reportText:"Sales 135,844; currency not provided",
    reportFactsHash:"legacy-hash",reportTextOrigin:"model",reportProvenance:[],
    reportNumericEvidence:[],
  }};
};

describe("cached Events final report formatting",()=>{
  beforeEach(()=>{state.previous=null;state.writes.length=0;});
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
  it("upserts the existing supervisor_reports row without inserting an ai_messages row or alert",async()=>{
    previous();
    await new SupabaseLoopRepository().saveReport(scope,proposal,
      report({...facts,reportText:"Sales $1,358.44",reportFactsHash:"v2",
        reportTextOrigin:"model",reportProvenance:[]}));
    expect(state.writes.map(x=>[x.table,x.operation])).toEqual([
      ["supervisor_reports","upsert"]]);
    expect(state.previous?.report.reportText).toBe("Sales $1,358.44");
  });
  it("still delivers corrected factual evidence after a Toast change",async()=>{
    previous({...facts,days:[{date:"2026-11-02",actualCents:125844}]});
    await new SupabaseLoopRepository().saveReport(scope,proposal,
      report({...facts,reportText:"Sales $1,358.44",reportFactsHash:"v2"}));
    expect(state.writes.map(x=>x.table)).toEqual([
      "supervisor_reports","operating_tasks","operating_tasks","ai_messages"]);
  });
});

import {describe,expect,it,vi} from "vitest";
import {monitorInitiatives,runWithMonitorDeadline} from "./monitor.server";
const state=vi.hoisted(()=>({claimed:[] as string[],released:[] as string[],read:[] as string[]}));
const base={
  business_id:"11111111-1111-4111-8111-111111111111",
  owner_user_id:"22222222-2222-4222-8222-222222222222",
  thread_id:"33333333-3333-4333-8333-333333333333",
  kind:"goal",title:"Timed monitor",change_description:"",change_spec:{},
  adapter_id:null,starts_on:"2026-10-01",ends_on:"2026-10-07",
  baseline_from:"2026-09-24",baseline_to:"2026-09-30",
  status:"active",checkin_cadence:"end_only",locale:"en",revision:1,
};
vi.mock("@/lib/data/initiatives.server",()=>({
  listMonitorBatch:async()=>Array.from({length:100},(_,i)=>({
    ...base,id:String(i+1).padStart(8,"0")+"-4444-4444-8444-444444444444",
  })),
  claimMonitorInitiative:async(i:{id:string})=>{
    state.claimed.push(i.id);return i;
  },
  readMonitorGraph:async(i:{id:string})=>{
    state.read.push(i.id);
    if(i.id.startsWith("00000001"))
      return new Promise<never>(()=>{}); // stubborn/uncooperative fetch
    return {metrics:[],observations:[],latest:null,timezone:"UTC",evidenceRevision:0};
  },
  releaseMonitorInitiative:async(id:string)=>{state.released.push(id);},
  readMetricDay:async()=>{throw Error("no computed metrics");},
  persistMetricObservation:async()=>true,
  persistInitiativeEvaluation:async()=>true,
}));
vi.mock("@/lib/teamUpdates/write.server",()=>({
  writeTeamUpdate:async()=>({created:false}),
}));
describe("cron deadline with a stalled tenant",()=>{
  it("aborts a never-settling request and continues to later tenants",async()=>{
    state.claimed.length=0;state.released.length=0;state.read.length=0;
    const start=Date.now();
    const report=await monitorInitiatives(new Date("2026-10-03T12:00:00Z"),{
      overallMs:1_000,perItemMs:40,
    });
    expect(Date.now()-start).toBeLessThan(1_000);
    expect(report.checked).toBe(100);
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(state.read.some(id=>id.startsWith("00000002"))).toBe(true);
    expect(state.released).toContain("00000001-4444-4444-8444-444444444444");
    expect(state.claimed.length).toBeGreaterThan(80);
  });
  it("rejects an uncooperative promise even without cooperative fetch abort",async()=>{
    const controller=new AbortController();
    const pending=runWithMonitorDeadline(controller.signal,
      async()=>new Promise<never>(()=>{}));
    controller.abort();
    await expect(pending).rejects.toThrow("deadline");
  });
});

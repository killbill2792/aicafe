import {beforeEach,describe,expect,it,vi} from "vitest";
import {monitorInitiatives} from "./monitor.server";
const state=vi.hoisted(()=>({
  keys:new Set<string>(),digest:new Set<string>(),sampled:0,rotated:0,
}));
vi.mock("@/lib/data/initiatives.server",()=>({
  listMonitorBatch:async()=>[{
    id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",business_id:"11111111-1111-4111-8111-111111111111",
    owner_user_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    thread_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",kind:"goal",
    title:"Coffee goal",change_description:"",change_spec:{},adapter_id:null,
    starts_on:"2026-10-14",ends_on:"2026-10-21",baseline_from:"2026-10-07",baseline_to:"2026-10-13",
    status:"active",checkin_cadence:"end_only",locale:"en",revision:2,
  }],
  readMonitorGraph:async()=>({timezone:"UTC",latest:null,observations:[],metrics:[{
    id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",source:"checkin",role:"primary",
    comparator:"gte",target_kind:"absolute",target:1,metric_key:null,
    checkin_question:"How did it go?",checkin_audience:"owner",data_gap:"manual check-in",
    params:{},
  }]}),
  readMetricDay:async()=>{throw new Error("No computed metric should read data");},
  persistMetricObservation:async()=>{state.sampled++;return true;},
  persistInitiativeEvaluation:async(_scope:unknown,_id:string,_date:string,_status:string,_recommendation:string)=>{
    const digest=_status+":"+_recommendation;
    const fresh=!state.digest.has(digest);state.digest.add(digest);return fresh;
  },
  rotateInitiative:async(i:{revision:number})=>{state.rotated++;return {...i,revision:i.revision+1};},
}));
vi.mock("@/lib/teamUpdates/write.server",()=>({
  writeTeamUpdate:async(input:{dedupeKey:string})=>{
    const fresh=!state.keys.has(input.dedupeKey);
    state.keys.add(input.dedupeKey);
    return {created:fresh};
  },
}));
beforeEach(()=>{state.keys.clear();state.digest.clear();state.sampled=0;state.rotated=0;});
describe("M1 monitor semantic idempotency",()=>{
  it("does not create a second check-in or evaluation on rerun",async()=>{
    const at=new Date("2026-10-23T12:00:00Z");
    const first=await monitorInitiatives(at);
    const again=await monitorInitiatives(at);
    expect(first.updates).toBe(2);
    expect(again.updates).toBe(0);
    expect(first.failed).toBe(0);
    expect(again.failed).toBe(0);
    expect(state.keys.size).toBe(2);
    expect(state.sampled).toBe(0);
    expect(state.rotated).toBe(4); // claim + terminal transition per run
  });
});

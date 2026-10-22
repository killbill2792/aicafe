import {beforeEach,describe,expect,it,vi} from "vitest";
import {monitorInitiatives} from "./monitor.server";
const state=vi.hoisted(()=>({
  kind:"computed" as "computed"|"checkin"|"skip",
  dates:[] as string[],updates:[] as string[],released:0,
}));
vi.mock("@/lib/data/initiatives.server",()=>({
  listMonitorBatch:async()=>[{
    id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    business_id:"11111111-1111-4111-8111-111111111111",
    owner_user_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    thread_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    kind:"goal",title:"Evidence window",change_description:"",change_spec:{},
    adapter_id:null,starts_on:state.kind==="computed"?"2026-10-01":"2026-10-01",
    ends_on:state.kind==="computed"?"2026-10-07":"2026-10-08",
    baseline_from:state.kind==="computed"?"2026-07-01":"2026-09-24",
    baseline_to:"2026-09-30",status:"active",
    checkin_cadence:"daily",locale:"en",revision:0,
  }],
  claimMonitorInitiative:async(i:unknown)=>state.kind==="skip"?null:i,
  releaseMonitorInitiative:async()=>{state.released++;},
  readMonitorGraph:async()=>({
    timezone:"UTC",latest:null,observations:[],
    metrics:state.kind==="computed"?[{
      id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",source:"computed",
      metric_key:"net_sales",params:{},role:"primary",
      comparator:"gte",target_kind:"relative_pct",target:5,
    }]:[{
      id:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",source:"checkin",
      metric_key:null,params:{},role:"primary",checkin_audience:"owner",
      checkin_question:"Was it ready?",comparator:"gte",
      target_kind:"absolute",target:1,
    }],
  }),
  readMetricDay:async(_business:string,date:string)=>{
    state.dates.push(date);
    return {date,facts:{
      date,netSalesCents:1000,ordersCount:1,drinksCount:1,
      ingredientsCents:0,wagesCents:0,staffTaxCents:0,
      cardFeesCents:0,voidsCents:0,salesDataStatus:"actual",
    }};
  },
  persistMetricObservation:async()=>true,
  persistInitiativeEvaluation:async()=>true,
}));
vi.mock("@/lib/teamUpdates/write.server",()=>({
  writeTeamUpdate:async(args:{facts?:{date?:string}})=>{
    if(args.facts?.date)state.updates.push(args.facts.date);
    return {created:true};
  },
}));
beforeEach(()=>{
  state.kind="computed";state.dates.length=0;
  state.updates.length=0;state.released=0;
});
describe("M1 bounded monitor fairness",()=>{
  it("samples live test evidence before a 92-day baseline backlog",async()=>{
    const result=await monitorInitiatives(new Date("2026-10-08T12:00:00Z"));
    expect(result.failed).toBe(0);
    expect(state.dates.slice(0,3)).toEqual(["2026-10-07","2026-10-06","2026-10-05"]);
    expect(state.dates.some(date=>date<"2026-10-01")).toBe(true);
    expect(state.dates.length).toBeLessThanOrEqual(7);
    expect(state.released).toBe(1);
  });
  it("issues older missed daily check-ins rather than permanently skipping them",async()=>{
    state.kind="checkin";
    const result=await monitorInitiatives(new Date("2026-10-07T12:00:00Z"));
    expect(result.failed).toBe(0);
    expect(state.updates).toEqual(["2026-10-01","2026-10-02","2026-10-03"]);
    expect(state.released).toBe(1);
  });
  it("never starts work without exclusive claim",async()=>{
    state.kind="skip";
    const result=await monitorInitiatives(new Date("2026-10-08T12:00:00Z"));
    expect(result.sampled).toBe(0);
    expect(state.dates).toEqual([]);
    expect(state.released).toBe(0);
  });
});

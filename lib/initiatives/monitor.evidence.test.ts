import {beforeEach,describe,expect,it,vi} from "vitest";
import {monitorInitiatives} from "./monitor.server";
const metricId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const state=vi.hoisted(()=>({
  current:200,
  rows:[] as Array<{metric_id:string;business_date:string;value:number|null;
    coverage:number;source:"computed";note:string|null;revision:number;verified_at:string}>,
  snapshots:[] as Array<Record<string,unknown>>,
  revision:1,
}));
const initiative={
  id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  business_id:"11111111-1111-4111-8111-111111111111",
  owner_user_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  thread_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  kind:"goal",title:"Sales",change_description:"",change_spec:{},
  adapter_id:null,starts_on:"2026-10-01",ends_on:"2026-10-07",
  baseline_from:"2026-09-24",baseline_to:"2026-09-30",status:"active",
  checkin_cadence:"end_only",locale:"en",
};
vi.mock("@/lib/data/initiatives.server",()=>({
  listMonitorBatch:async()=>[{...initiative,revision:state.revision}],
  claimMonitorInitiative:async(i:unknown)=>{state.revision++;return i;},
  releaseMonitorInitiative:async()=>{},
  readMonitorGraph:async()=>({
    timezone:"UTC",latest:null,observations:[...state.rows],
    metrics:[{id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",role:"primary",
      source:"computed",metric_key:"net_sales",params:{},comparator:"gte",
      target_kind:"absolute",target:100}],
  }),
  readMetricDay:async(_business:string,date:string)=>({
    date,facts:{date,netSalesCents:date==="2026-10-07"?state.current:200,
      ordersCount:1,drinksCount:1,ingredientsCents:0,wagesCents:0,
      staffTaxCents:0,cardFeesCents:0,voidsCents:0,salesDataStatus:"actual"},
  }),
  persistMetricObservation:async(_scope:unknown,_id:string,_token:string,row:{
    business_date:string;value:number|null;coverage:number;note:string|null;
    revision:number;verified_at:string;
  })=>{
    const index=state.rows.findIndex(r=>r.business_date===row.business_date);
    if(index<0)throw Error("fixture requires existing observations");
    state.rows[index]={...state.rows[index],value:row.value,coverage:row.coverage,
      note:row.note,revision:row.revision,verified_at:row.verified_at};
    return true;
  },
  persistInitiativeEvaluation:async(_scope:unknown,_id:string,_date:string,
    _status:string,_recommendation:string,_results:unknown,inputs:Record<string,unknown>)=>{
    state.snapshots.push(inputs);return true;
  },
}));
vi.mock("@/lib/teamUpdates/write.server",()=>({
  writeTeamUpdate:async()=>({created:false}),
}));
beforeEach(()=>{
  state.current=200;state.revision=1;state.snapshots.length=0;state.rows.length=0;
  for(let d=1;d<=7;d++)state.rows.push({metric_id:metricId,
    business_date:"2026-10-0"+d,value:200,coverage:1,source:"computed",
    note:null,revision:1,verified_at:"2026-10-08T12:00:00.000Z"});
});
describe("immutable evidence identities across corrections",()=>{
  it("distinguishes equal-valued A -> B -> A states without a status change",async()=>{
    const now=new Date("2026-10-10T12:00:00Z");
    await monitorInitiatives(now);
    state.current=300;
    await monitorInitiatives(now);
    state.current=200;
    await monitorInitiatives(now);
    expect(state.snapshots).toHaveLength(3);
    const version=(index:number)=>{
      const all=state.snapshots[index].evidenceVersions as Array<{
        metricId:string;date:string;revision:number;
      }>;
      return all.find(v=>v.metricId===metricId&&v.date==="2026-10-07")?.revision;
    };
    expect([version(0),version(1),version(2)]).toEqual([1,2,3]);
    expect(JSON.stringify(state.snapshots[0])).not.toBe(JSON.stringify(state.snapshots[2]));
    const results=state.snapshots.map(x=>(x.metrics as Array<{
      test:Array<{date:string;value:number|null}>;
    }>)[0].test.find(o=>o.date==="2026-10-07")?.value);
    expect(results).toEqual([200,300,200]);
  });
});

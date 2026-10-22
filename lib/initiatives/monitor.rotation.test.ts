import {beforeEach,describe,expect,it,vi} from "vitest";
import {monitorInitiatives} from "./monitor.server";
const metricId="22222222-2222-4222-8222-222222222222";
const itemId="33333333-3333-4333-8333-333333333333";
const state=vi.hoisted(()=>({
  rows:[] as Array<{metric_id:string;business_date:string;value:number|null;
    coverage:number;source:"computed";note:string|null;revision:number;verified_at:string}>,
  unavailable:true,active:true,revision:1,read:[] as string[],completed:0,
}));
const initiative={
  id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  business_id:"11111111-1111-4111-8111-111111111111",
  owner_user_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  thread_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  kind:"goal",title:"Item coverage recovery",change_description:"",change_spec:{},
  adapter_id:null,starts_on:"2026-10-01",ends_on:"2026-10-14",
  baseline_from:"2026-09-24",baseline_to:"2026-09-30",status:"active",
  checkin_cadence:"end_only",locale:"en",
};
vi.mock("@/lib/data/initiatives.server",()=>({
  listMonitorBatch:async()=>state.active?[{...initiative,revision:state.revision}]:[],
  claimMonitorInitiative:async(i:unknown)=>{state.revision++;return i;},
  releaseMonitorInitiative:async(_id:string,_token:string,completed:boolean)=>{
    if(completed){state.completed++;state.active=false;}
  },
  readMonitorGraph:async()=>({
    timezone:"UTC",latest:null,observations:[...state.rows],evidenceRevision:0,
    metrics:[{id:"22222222-2222-4222-8222-222222222222",role:"primary",
      source:"computed",metric_key:"item_units",params:{itemId:"33333333-3333-4333-8333-333333333333"},
      comparator:"gte",target_kind:"absolute",target:1}],
  }),
  readMetricDay:async(_id:string,date:string)=>{
    state.read.push(date);
    const blocked=state.unavailable&&date<="2026-10-08";
    return {date,salesTotalCoverageVerified:true,validItemIds:[itemId],
      itemCoverageInvalidated:false,items:blocked?undefined:[{
        itemId,units:3,revenueCents:300,recipeLines:[],ingredientPriceMicros:{},
        ownerCostCents:null,
      }],
      facts:{date,netSalesCents:300,ordersCount:1,drinksCount:3,
        ingredientsCents:0,wagesCents:0,staffTaxCents:0,cardFeesCents:0,
        voidsCents:0,salesDataStatus:"actual"},
    };
  },
  persistMetricObservation:async(_scope:unknown,_id:string,_token:string,row:{
    business_date:string;value:number|null;coverage:number;note:string|null;
    revision:number;verified_at:string;
  },invalidate:boolean)=>{
    const i=state.rows.findIndex(x=>x.business_date===row.business_date);
    if(i<0)throw Error("fixture requires an existing record");
    const previous=state.rows[i];
    if(row.coverage<previous.coverage&&!invalidate)return false;
    state.rows[i]={...previous,value:row.value,coverage:row.coverage,
      note:row.note,revision:row.revision,verified_at:row.verified_at};
    return true;
  },
  persistInitiativeEvaluation:async()=>true,
}));
vi.mock("@/lib/teamUpdates/write.server",()=>({writeTeamUpdate:async()=>({created:false})}));
beforeEach(()=>{
  state.rows.length=0;state.read.length=0;
  state.unavailable=true;state.active=true;state.revision=1;state.completed=0;
  for(let day=1;day<=14;day++)
    state.rows.push({metric_id:metricId,
      business_date:"2026-10-"+String(day).padStart(2,"0"),
      value:3,coverage:1,source:"computed",note:null,revision:1,
      verified_at:"2026-10-20T12:00:00.000Z"});
});
describe("post-correction fairness under unavailable sources",()=>{
  it("checks healthy dates despite eight repeatedly rejected stale refreshes",async()=>{
    const at=new Date("2026-11-01T12:00:00Z");
    for(let i=0;i<3;i++){
      const stats=await monitorInitiatives(at);
      expect(stats.failed).toBe(0);
    }
    expect(new Set(state.read).size).toBe(14);
    expect(state.rows.filter(r=>r.business_date>"2026-10-08"&&
      r.verified_at.startsWith("2026-11-")).length).toBe(6);
    expect(state.rows.filter(r=>r.business_date<="2026-10-08"&&
      r.verified_at.startsWith("2026-10-")).length).toBe(8);
    expect(state.completed).toBe(0);
    state.unavailable=false;
    for(let i=0;i<5&&state.active;i++)await monitorInitiatives(at);
    expect(state.completed).toBe(1);
    expect(state.rows.every(r=>r.verified_at.startsWith("2026-11-"))).toBe(true);
  });
});

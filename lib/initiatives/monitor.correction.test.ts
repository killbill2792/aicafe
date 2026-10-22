import {beforeEach,describe,expect,it,vi} from "vitest";
import {monitorInitiatives} from "./monitor.server";
const state=vi.hoisted(()=>({
  rows:[] as Array<{metric_id:string;business_date:string;value:number|null;coverage:number;
    source:"computed";note:null;revision:number;verified_at:string}>,
  active:true,revision:1,reads:[] as string[],completed:0,
}));
const metricId="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const initiative={
  id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  business_id:"11111111-1111-4111-8111-111111111111",
  owner_user_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  thread_id:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  kind:"goal",title:"Quarterly goal",status:"active",
  change_description:"",change_spec:{},adapter_id:null,
  starts_on:"2026-10-01",ends_on:"2026-12-31",
  baseline_from:"2026-09-25",baseline_to:"2026-09-30",
  checkin_cadence:"end_only",locale:"en",
};
vi.mock("@/lib/data/initiatives.server",()=>({
  listMonitorBatch:async()=>state.active?[{...initiative,revision:state.revision}]:[],
  claimMonitorInitiative:async(i:{revision:number})=>({...i,revision:++state.revision}),
  releaseMonitorInitiative:async(_id:string,_token:string,done:boolean)=>{
    if(done){state.completed++;state.active=false;}
  },
  readMonitorGraph:async()=>({
    timezone:"UTC",latest:null,observations:[...state.rows],
    metrics:[{id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      role:"primary",source:"computed",metric_key:"net_sales",
      params:{},comparator:"gte",target_kind:"absolute",target:100}],
  }),
  readMetricDay:async(_b:string,date:string)=>{
    state.reads.push(date);
    return {date,facts:{date,netSalesCents:200,ordersCount:1,drinksCount:1,
      ingredientsCents:0,wagesCents:0,staffTaxCents:0,cardFeesCents:0,voidsCents:0,
      salesDataStatus:"actual"}};
  },
  persistMetricObservation:async(_scope:unknown,_id:string,_token:string,row:{
    business_date:string;verified_at:string;value:number|null;coverage:number;
  })=>{
    const i=state.rows.findIndex(o=>o.business_date===row.business_date);
    if(i<0)throw Error("the sample already existed");
    state.rows[i]={...state.rows[i],value:row.value,coverage:row.coverage,
      verified_at:row.verified_at,revision:state.rows[i].revision+1};
    return true;
  },
  persistInitiativeEvaluation:async()=>true,
}));
vi.mock("@/lib/teamUpdates/write.server",()=>({
  writeTeamUpdate:async()=>({created:false}),
}));
beforeEach(()=>{
  state.rows.length=0;state.reads.length=0;state.revision=1;
  state.active=true;state.completed=0;
  for(let d=Date.parse("2026-10-01T12:00:00Z");d<=Date.parse("2026-12-31T12:00:00Z");d+=86400000){
    state.rows.push({metric_id:metricId,business_date:new Date(d).toISOString().slice(0,10),
      value:200,coverage:1,source:"computed",note:null,revision:1,
      verified_at:"2026-12-30T00:00:00.000Z"});
  }
});
describe("post-end correction completeness",()=>{
  it("cannot complete a 92-day initiative before all covered dates are rechecked",async()=>{
    const at=new Date("2027-01-16T12:00:00Z");
    for(let i=0;i<11;i++){
      const run=await monitorInitiatives(at);
      expect(run.failed).toBe(0);
      expect(state.active).toBe(true);
      expect(state.reads.length).toBe((i+1)*8);
    }
    expect(state.rows.filter(x=>x.verified_at.startsWith("2027-")).length).toBe(88);
    const final=await monitorInitiatives(at);
    expect(final.failed).toBe(0);
    expect(state.completed).toBe(1);
    expect(state.rows.every(x=>x.verified_at.startsWith("2027-"))).toBe(true);
    expect(state.reads.length).toBe(92);
  });
});

import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";

vi.mock("server-only",()=>({}));
const spies=vi.hoisted(()=>({
  materialize:vi.fn(),alerts:vi.fn(),readItems:vi.fn(),plans:vi.fn(),
}));
vi.mock("./materializeSchedule",()=>({
  ensureScheduledShiftsThroughDate:spies.materialize,
}));
vi.mock("@/lib/alerts/generate",()=>({generateAlerts:spies.alerts}));
vi.mock("./periodItemSales.server",()=>({
  readPeriodItemSales:spies.readItems,
}));
vi.mock("@/lib/pos/processingFeeEstimate.server",()=>({
  getOwnerConfirmedProcessingFeePlans:spies.plans,
}));
import {getBusinessSnapshotFromDb} from "./snapshot.server";

const cafeId="00000000-0000-4000-8000-000000000001";
function readOnlyClient(expenseCount=0){
  const tables:string[]=[];
  const filters:Array<{table:string;field:string;value:unknown}>=[];
  const values:Record<string,unknown[]>={
    businesses:[{id:cafeId,name:"Fixture Café",timezone:"America/Los_Angeles",
      payroll_tax_rate:.12,payroll_tax_rate_status:"confirmed",payroll_tax_rate_source:"owner",
      target_operating_margin:.15,target_operating_margin_status:"default",
      owner_monthly_payroll_extras_cents:0}],
    locations:[{open_hours:null}],
    daily_rollups:["2026-09-30","2026-10-01"].map(business_date=>({
      business_date,net_sales_cents:10000,orders_count:5,drinks_count:10,
      ingredients_cents:2000,staff_wages_cents:1000,staff_tax_cents:120,
      labor_wage_status:"actual",staff_tax_status:"actual",
      staff_tax_source:"recorded",sales_data_status:"actual",
      card_fees_cents:300,card_fees_status:"actual",voids_cents:0,
    })),
    recurring_costs:[{category_code:"rent",amount_cents:300000,is_estimate:false,
      active_from:"2026-01-01",active_to:null}],
    expenses:Array.from({length:expenseCount},(_,i)=>({id:"expense-"+i,category_code:"rent",
      amount_cents:100,status:"actual",spent_on:"2026-09-30"})),
  };
  const client={
    from(table:string){
      tables.push(table);
      const result={data:values[table]??[],error:null};
      let first=0,last=Number.MAX_SAFE_INTEGER;
      const q={
        select(){return q;},
        eq(field:string,value:unknown){filters.push({table,field,value});return q;},
        gte(){return q;},lte(){return q;},or(){return q;},order(){return q;},
        limit(){return q;},range(start:number,end:number){first=start;last=end;return q;},
        single(){return Promise.resolve({...result,data:result.data[0]??null});},
        maybeSingle(){return Promise.resolve({...result,data:result.data[0]??null});},
        then(ok:(value:typeof result)=>unknown,fail?:((err:unknown)=>unknown)){
          return Promise.resolve({...result,data:result.data.slice(first,last+1)}).then(ok,fail);
        },
        insert(){throw Error("Historical reader tried to write");},
        update(){throw Error("Historical reader tried to write");},
        upsert(){throw Error("Historical reader tried to write");},
        delete(){throw Error("Historical reader tried to write");},
      };
      return q;
    },
    rpc(){throw Error("Historical reader tried an RPC");},
  };
  return {client:client as unknown as SupabaseClient,tables,filters};
}
describe("historical snapshot is genuinely read-only",()=>{
  it("loads previous and cross-month dates while avoiding all materialization or alert writes",async()=>{
    spies.materialize.mockReset();spies.alerts.mockReset();
    spies.readItems.mockResolvedValue({
      period:{from:"2026-09-30",to:"2026-10-01"},covered:false,soldItems:[],
    });
    spies.plans.mockResolvedValue([]);
    const {client,tables,filters}=readOnlyClient();
    const result=await getBusinessSnapshotFromDb(client,cafeId,
      {from:"2026-09-30",to:"2026-10-01"});
    const historical=(result as typeof result & {historicalPeriod:{
      days:Array<{date:string}>,monthlyAmounts:Array<{monthKey:string}>,
    }}).historicalPeriod;
    expect(historical.days.map(day=>day.date)).toEqual(["2026-09-30","2026-10-01"]);
    expect(new Set(historical.monthlyAmounts.map(row=>row.monthKey)))
      .toEqual(new Set(["2026-09","2026-10"]));
    expect(spies.materialize).not.toHaveBeenCalled();
    expect(spies.alerts).not.toHaveBeenCalled();
    expect(tables).toEqual(["businesses","daily_rollups","recurring_costs","expenses","locations"]);
    for(const table of tables.filter(name=>name!=="businesses"))
      expect(filters).toContainEqual({table,field:"business_id",value:cafeId});
  });
  it("reads past the default 1000-row response cap without dropping money",async()=>{
    spies.readItems.mockResolvedValue({period:{from:"2026-09-30",to:"2026-10-01"},covered:false,soldItems:[]});
    spies.plans.mockResolvedValue([]);
    const {client,tables}=readOnlyClient(1001);
    const snapshot=await getBusinessSnapshotFromDb(client,cafeId,{from:"2026-09-30",to:"2026-10-01"});
    const history=(snapshot as typeof snapshot&{historicalPeriod:{monthlyAmounts:Array<{
      monthKey:string;categoryCode:string;amountCents:number}>}}).historicalPeriod;
    expect(history.monthlyAmounts.find(row=>row.monthKey==="2026-09"&&row.categoryCode==="rent")?.amountCents)
      .toBe(100100);
    expect(tables.filter(name=>name==="expenses")).toHaveLength(2);
  });
});

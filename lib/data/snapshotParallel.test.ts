import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  days:vi.fn(),period:vi.fn(),plans:vi.fn(),
}));
vi.mock("./dailyFacts.server",()=>({readDailyFactRows:mocks.days}));
vi.mock("./periodItemSales.server",()=>({readPeriodItemSales:mocks.period}));
vi.mock("@/lib/pos/processingFeeEstimate.server",()=>({
  getOwnerConfirmedProcessingFeePlans:mocks.plans,
}));
import {getBusinessSnapshotFromDb} from "./snapshot.server";

function mockDb(){
  const reads:string[]=[];
  const scope:Array<{table:string;businessId:string}>=[];
  const values:Record<string,Record<string,unknown>[]> = {
    businesses:[{id:"cafe1",name:"Test café",timezone:"America/Los_Angeles",currency:"EUR",
      payroll_tax_rate:.12,payroll_tax_rate_status:"confirmed",payroll_tax_rate_source:"owner",
      target_operating_margin:.15,target_operating_margin_status:"default",
      owner_monthly_payroll_extras_cents:1200}],
    locations:[{open_hours:null}],
    recurring_costs:[{category_code:"rent",amount_cents:60000,is_estimate:false,
      active_from:"2026-01-01",active_to:null}],
    expenses:[],recovery_order:[],menu_items:[],timecards:[],
    alerts:[{impact_cents:240}],
  };
  const client={
    from(table:string){
      reads.push(table);
      const payload={data:values[table]??[],error:null,count:(values[table]??[]).length};
      const q={
        select(){return q;},
        eq(field:string,value:unknown){
          if(field==="business_id")scope.push({table,businessId:String(value)});
          return q;
        },
        gte(){return q;},lte(){return q;},in(){return q;},
        order(){return q;},limit(){return q;},range(){return q;},
        single:async()=>({...payload,data:payload.data[0]??null}),
        maybeSingle:async()=>({...payload,data:payload.data[0]??null}),
        then(ok:(value:typeof payload)=>unknown,fail?:((err:unknown)=>unknown)){
          return Promise.resolve(payload).then(ok,fail);
        },
      };
      return q;
    },
    rpc(){throw Error("Empty menu must not request recipe quantities");},
  };
  return {db:client as unknown as SupabaseClient,reads,scope};
}

describe("canonical snapshot independent read phases",()=>{
  it("starts fee, menu, staff and alert reads before daily facts finish, without changing money",async()=>{
    let releaseDays!:(rows:unknown[])=>void;
    const pendingDays=new Promise<unknown[]>(resolve=>{releaseDays=resolve;});
    mocks.days.mockReset().mockReturnValue(pendingDays);
    mocks.period.mockReset().mockResolvedValue({
      period:{from:"2026-10-24",to:"2026-10-30"},covered:true,soldItems:[],
    });
    mocks.plans.mockReset().mockResolvedValue([]);
    const {db,reads,scope}=mockDb();
    const work=getBusinessSnapshotFromDb(db,"cafe1","week","2026-10-30");

    // The daily facts promise is deliberately blocked. Under the old two-wave
    // loader these reads could not begin until releaseDays(), delaying Home.
    await vi.waitFor(()=>{
      expect(mocks.days).toHaveBeenCalledOnce();
      expect(mocks.plans).toHaveBeenCalledOnce();
      expect(mocks.period).toHaveBeenCalledOnce();
      expect(reads).toContain("menu_items");
      expect(reads).toContain("timecards");
      expect(reads).toContain("alerts");
    });
    releaseDays([{
      business_date:"2026-10-30",net_sales_cents:12345,orders_count:12,
      drinks_count:14,ingredients_cents:2000,staff_wages_cents:3000,
      staff_tax_cents:360,labor_wage_status:"actual",staff_tax_status:"actual",
      staff_tax_source:"recorded",sales_data_status:"actual",
      card_fees_cents:375,card_fees_status:"actual",voids_cents:0,
    }]);
    const snapshot=await work;
    expect(snapshot.business).toMatchObject({
      id:"cafe1",currency:"EUR",ownerMonthlyPayrollExtrasCents:undefined,
    });
    expect(snapshot.ownerMonthlyPayrollExtrasCents).toBe(1200);
    expect(snapshot.monthActualDays.map(d=>d.netSalesCents)).toEqual([12345]);
    expect(snapshot.periodItemSales.period).toEqual({from:"2026-10-24",to:"2026-10-30"});
    expect(snapshot.runningCostLines.find(row=>row.categoryCode==="rent")).toMatchObject({
      amountCents:60000,isMissing:false,isEstimate:false,
    });
    expect(snapshot.alerts).toEqual({count:1,leakingCents:240});
    expect(snapshot.ownerFeePlans).toEqual([]);
    expect(reads.filter(table=>table==="menu_items")).toHaveLength(1);
    expect(reads.filter(table=>table==="alerts")).toHaveLength(1);
    expect(scope.every(row=>row.businessId==="cafe1")).toBe(true);
  });
});

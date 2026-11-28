import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {fixtureCostRows} from "./runningCostCatalog.fixture";
import {fixtureFinancialPeriodRows} from "./financialPeriods.fixture";
vi.mock("server-only",()=>({}));
const hooks=vi.hoisted(()=>({
  materialize:vi.fn(),generate:vi.fn(),period:vi.fn(async()=>({
    period:{from:"2026-10-01",to:"2026-10-28"},covered:false,soldItems:[],
  })),plans:vi.fn(async()=>[]),
}));
vi.mock("./materializeSchedule",()=>({ensureScheduledShiftsThroughDate:hooks.materialize}));
vi.mock("@/lib/alerts/generate",()=>({generateAlerts:hooks.generate}));
vi.mock("./periodItemSales.server",()=>({readPeriodItemSales:hooks.period}));
vi.mock("@/lib/pos/processingFeeEstimate.server",()=>({
  getOwnerConfirmedProcessingFeePlans:hooks.plans,
}));
import {getBusinessSnapshotFromDb} from "./snapshot.server";
import {formatInTimeZone} from "date-fns-tz";
function mockDb(options:{sold?:Array<{menu_item_id:string;total_quantity:number|string}>}={}){
  const reads:string[]=[];const writes:string[]=[];
  const data:Record<string,Record<string,unknown>[]>={
    businesses:[{id:"c1",name:"Café",timezone:"America/Los_Angeles",payroll_tax_rate:.12,
      payroll_tax_rate_status:"confirmed",payroll_tax_rate_source:"owner",
      target_operating_margin:.15,target_operating_margin_status:"default",
      owner_monthly_payroll_extras_cents:null}],
    locations:[{open_hours:null}],
    cv_sales_days:[],cv_bills:[],cv_expenses:[],recovery_order:[],
    menu_catalog_for:[],cv_staff_clock_entries:[],alerts:[],cv_financial_periods:fixtureFinancialPeriodRows(),
  };
  const db={from(table:string){
    reads.push(table);
    let records=table==="cv_menu_product_costs"?(data.menu_catalog_for??[]).map(item=>({menu_item_id:item.id,data:{costCents:null,status:"NO_RECIPE",source:null,estimated:false,recipe:[],recipeStatus:"NO_RECIPE",recipeCostCents:null,ownerTotalCostCents:null,differenceCents:null}})):data[table]??[];
    let monthStart="",asOf="";
    const payload={data:records,error:null,count:records.length};
    let range:{start:number;end:number}|null=null;
    const builder={
      select(){return builder},eq(field:string,value:unknown){if(field==="business_date")monthStart=String(value);if(field==="as_of_date")asOf=String(value);return builder},gte(){return builder},lte(){return builder},
      in(){return builder},like(){return builder},order(){return builder},limit(){return builder},
      range(start:number,end:number){range={start,end};return builder},
      single:async()=>({...payload,data:payload.data[0]??null}),
      maybeSingle:async()=>({...payload,data:payload.data[0]??null}),
      insert(){writes.push("insert");throw Error("Write in page load")},
      update(){writes.push("update");throw Error("Write in page load")},
      upsert(){writes.push("upsert");throw Error("Write in page load")},
      delete(){writes.push("delete");throw Error("Write in page load")},
      then(onSuccess:(value:typeof payload)=>unknown){if(table==="cv_running_cost_months")records=fixtureCostRows(data,monthStart,asOf);return Promise.resolve({...payload,
        data:range?records.slice(range.start,range.end+1):records}).then(onSuccess)},
    };
    return builder;
  },rpc(name:string){
    if(name==="menu_catalog_for")return this.from(name);
    if(name==="menu_item_quantities_sold"&&options.sold){
      const sold=options.sold;let start=0,end=999;
      const q={order(){return q},
        range(a:number,b:number){start=a;end=b;return q},
        then(resolve:(v:unknown)=>unknown){return Promise.resolve({
          data:sold.slice(start,end+1),error:null,count:sold.length
        }).then(resolve)}};
      return q;
    }
    writes.push("rpc");throw Error("Unexpected RPC in page load");
  }};
  return {db:db as unknown as SupabaseClient,reads,writes,seed:data};
}
describe("getSnapshot read-only current snapshot and Home database budget",()=>{
  it("makes zero inserts/updates/deletes and no alert/schedule regeneration",async()=>{
    hooks.materialize.mockClear();hooks.generate.mockClear();
    const {db,reads,writes}=mockDb();
    const result=await getBusinessSnapshotFromDb(db,"c1","today");
    expect(result.business.id).toBe("c1");
    expect(writes).toEqual([]);
    expect(hooks.materialize).not.toHaveBeenCalled();
    expect(hooks.generate).not.toHaveBeenCalled();
    // One snapshot loader (passed to Home and its attention section) has a
    // bounded number of read invocations, not a second full snapshot query set.
    expect(reads).toHaveLength(10);
    expect(reads.filter(table=>table==="alerts")).toHaveLength(1);
    expect(reads.filter(table=>table==="cv_sales_days")).toHaveLength(1);
  });
  it("keeps all 1001 menu records and their sold quantities across full source pages",async()=>{
    const menu=Array.from({length:1001},(_,i)=>({
      id:"menu-"+String(i).padStart(6,"0"),name:"Product "+i,
      price_cents:750,prep_seconds:15,category:"food",is_active:true
    }));
    const sold=menu.map((item,i)=>({menu_item_id:item.id,total_quantity:i===999?1.5:i===1000?"2.25":2}));
    const {db,seed,reads,writes}=mockDb({sold});
    seed.menu_catalog_for=menu;
    seed.recipe_lines=[];seed.menu_item_cost_fallbacks=[];
    seed.menu_combo_components=[];seed.ingredient_prices=[];
    const result=await getBusinessSnapshotFromDb(db,"c1","today");
    expect(result.menuItems).toHaveLength(1001);
    expect(result.menuItems[999]).toMatchObject({id:"menu-000999",quantitySoldLast28Days:1.5});
    expect(result.menuItems[1000]).toMatchObject({id:"menu-001000",quantitySoldLast28Days:2.25});
    expect(reads.filter(table=>table==="menu_catalog_for")).toHaveLength(2);
    expect(writes).toEqual([]);
  });
  it.each([-1, Infinity, NaN, Number.MAX_SAFE_INTEGER+1, ""])("rejects invalid sold quantities %s",async(total_quantity)=>{
    const {db,seed}=mockDb({sold:[{menu_item_id:"menu-1",total_quantity}]});
    seed.menu_catalog_for=[{id:"menu-1",name:"Product",price_cents:750,prep_seconds:15,category:"food",is_active:true}];
    await expect(getBusinessSnapshotFromDb(db,"c1","today")).rejects.toThrow("snapshot_product_sales_mapping_unverified");
  });
  it("never silently drops actual receipts after the 1000-row PostgREST page boundary",async()=>{
    const {db,seed,reads}=mockDb();
    const today=formatInTimeZone(new Date(),"America/Los_Angeles","yyyy-MM-dd");
    seed.cv_expenses=Array.from({length:1001},(_,i)=>({
      id:"receipt-"+String(i).padStart(5,"0"),category_code:"rent",
      amount_cents:100,status:"actual",spent_on:today
    }));
    const result=await getBusinessSnapshotFromDb(db,"c1","today");
    expect(result.runningCostLines.find(line=>line.categoryCode==="rent"))
      .toMatchObject({amountCents:100100,actualTodayCents:100100,
        amountSource:"recorded_expense",isEstimate:false});
    expect(reads.filter(table=>table==="cv_running_cost_months")).toHaveLength(2);
    expect(result.runningCostLines.find(line=>line.categoryCode==="rent")?.expenseEvidence).toHaveLength(1001);
  });
  it("rejects duplicated financial identities instead of manufacturing a complete source",async()=>{
    const {db,seed}=mockDb();
    const today=formatInTimeZone(new Date(),"America/Los_Angeles","yyyy-MM-dd");
    seed.cv_expenses=[{id:"same",category_code:"rent",amount_cents:100,status:"actual",spent_on:today},
      {id:"same",category_code:"rent",amount_cents:200,status:"actual",spent_on:today}];
    await expect(getBusinessSnapshotFromDb(db,"c1","today"))
      .rejects.toThrow("running_cost_source_incomplete");
  });
  it("never labels estimated expense rows as actual cash spent today",async()=>{
    const {db,seed}=mockDb();
    const today=formatInTimeZone(new Date(),"America/Los_Angeles","yyyy-MM-dd");
    seed.cv_expenses=[
      {id:"rent-actual",category_code:"rent",amount_cents:1500,status:"actual",spent_on:today},
      {id:"rent-estimate",category_code:"rent",amount_cents:5000,status:"estimated",spent_on:today}
    ];
    const result=await getBusinessSnapshotFromDb(db,"c1","today");
    expect(result.runningCostLines.find(line=>line.categoryCode==="rent"))
      .toMatchObject({amountCents:6500,actualTodayCents:1500,
        amountSource:"recorded_expense",isEstimate:true});
  });
});

import {describe,it,expect,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
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
function mockDb(){
  const reads:string[]=[];const writes:string[]=[];
  const data:Record<string,Record<string,unknown>[]>={
    businesses:[{id:"c1",name:"Café",timezone:"America/Los_Angeles",payroll_tax_rate:.12,
      payroll_tax_rate_status:"confirmed",payroll_tax_rate_source:"owner",
      target_operating_margin:.15,target_operating_margin_status:"default",
      owner_monthly_payroll_extras_cents:null}],
    locations:[{open_hours:null}],
    daily_rollups:[],recurring_costs:[],expenses:[],recovery_order:[],
    menu_items:[],timecards:[],alerts:[],
  };
  const db={from(table:string){
    reads.push(table);
    const payload={data:data[table]??[],error:null,count:0};
    const builder={
      select(){return builder},eq(){return builder},gte(){return builder},lte(){return builder},
      in(){return builder},order(){return builder},limit(){return builder},
      single:async()=>({...payload,data:payload.data[0]??null}),
      maybeSingle:async()=>({...payload,data:payload.data[0]??null}),
      insert(){writes.push("insert");throw Error("Write in page load")},
      update(){writes.push("update");throw Error("Write in page load")},
      upsert(){writes.push("upsert");throw Error("Write in page load")},
      delete(){writes.push("delete");throw Error("Write in page load")},
      then(onSuccess:(value:typeof payload)=>unknown){return Promise.resolve(payload).then(onSuccess)},
    };
    return builder;
  },rpc(){writes.push("rpc");throw Error("RPC in page load")}};
  return {db:db as unknown as SupabaseClient,reads,writes};
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
    expect(reads.filter(table=>table==="daily_rollups")).toHaveLength(1);
  });
});

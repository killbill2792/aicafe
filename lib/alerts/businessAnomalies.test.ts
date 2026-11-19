import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/timecardsForInterval.server",()=>({readTimecardsForInterval:async()=>[]}));
vi.mock("@/lib/data/posFactReaders.server",()=>({posFactReaders:()=>({peakHours:async()=>({available:false,value:null,quality:{missingInputs:["hours"],estimatedInputs:[],staleInputs:[]}})})}));
vi.mock("@/lib/data/todayLive.server",()=>({readSavedTodayLive:async()=>null,TODAY_LIVE_FRESH_MS:900000}));
const inputs=vi.hoisted(()=>({sales:vi.fn(),wages:vi.fn(),expenses:vi.fn(),costs:vi.fn(),products:vi.fn(),stock:vi.fn(),usage:vi.fn(),quotes:vi.fn(),snapshot:vi.fn(),menu:vi.fn()}));
vi.mock("@/lib/ai/supervisorReads.server",()=>({supervisorHistoricalReaders:()=>({salesTrend:inputs.sales})}));
vi.mock("@/lib/ai/supervisorFacts.server",()=>({supervisorFactReaders:()=>({recordedExpenses:inputs.expenses,productSales:inputs.products})}));
vi.mock("@/lib/data/agentReadSources.server",()=>({agentSourceReaders:()=>({ingredientCosts:inputs.costs})}));
vi.mock("@/lib/data/dailyFacts.server",()=>({readDailyFacts:inputs.wages}));
vi.mock("@/lib/data/getMenuItemsForEdit",()=>({getMenuItemsForEdit:inputs.menu}));
vi.mock("@/lib/data/canonical/reads.server",()=>({readCanonicalView:inputs.stock}));
vi.mock("@/lib/data/usageVariance.server",()=>({readUsageVariance:inputs.usage}));
vi.mock("@/lib/data/supplierPurchasing.server",()=>({readSupplierPurchasingEvidence:inputs.quotes}));
vi.mock("@/lib/data/snapshot.server",()=>({getBusinessSnapshotFromDb:inputs.snapshot}));
vi.mock("@/lib/operating/cafeState",()=>({cafeStateFromSnapshot:()=>({profitability:{available:false,value:null,quality:{missingInputs:["historical"],estimatedInputs:[],staleInputs:[]}}})}));
import {compareBusinessFacts,compareCheckedRefunds,refreshBusinessAnomalies} from "./businessAnomalies.server";
describe("canonical observation boundaries",()=>{
 it("distinguishes certified zero refunds, missing coverage and positive recovery",()=>{
  const check=(a:number|null,b:number|null)=>compareCheckedRefunds(a,b,"2026-11-12","2026-11-18");
  expect(check(3000,0)?.active).toBe(true);expect(check(0,0)?.active).toBe(false);
  expect(check(0,3000)?.active).toBe(false);expect(check(3000,null)).toBeNull();expect(check(null,3000)).toBeNull();
 });
 const compare=(current:number|null,previous:number|null)=>compareBusinessFacts("sales_decline","cafe",current,previous,"cents","2026-11-11","2026-11-17","2026-11-17","down");
 it("detects material decline, never turns missing into zero",()=>{
  expect(compare(800,1000)?.active).toBe(true);
  expect(compare(810,1000)?.active).toBe(false);
  expect(compare(1200,1000)?.active).toBe(false);
  expect(compare(null,1000)).toBeNull();
  expect(compare(0,null)).toBeNull();
  expect(compare(100,0)).toBeNull();
  expect(compare(0,1000)?.active).toBe(true);
 });
});

it("scheduled source reads create material incidents, retain unknown history and reconcile verified recovery",async()=>{
 const q={missingInputs:[],estimatedInputs:[],staleInputs:[]};
 const rows=(from:string,cents:number)=>Array.from({length:7},(_,i)=>({date:new Date(Date.parse(from+"T12:00:00Z")+i*86400000).toISOString().slice(0,10),netSalesCents:cents,wagesCents:100,laborWageStatus:"actual"}));
 let current=600,unknown=false;
 inputs.sales.mockImplementation(async(_id:string,period:{from:string;to:string})=>({available:true,value:rows(period.from,period.from==="2026-11-12"?current:1000),quality:unknown?{...q,missingInputs:["salesCoverage"]}:q}));
 inputs.wages.mockImplementation(async(_db:unknown,_id:string,from:string)=>rows(from,1000));
 inputs.expenses.mockResolvedValue({available:false,value:null,quality:q});
 inputs.costs.mockResolvedValue({value:{items:[]},quality:q});
 inputs.products.mockResolvedValue({available:false,value:null,quality:q});
 inputs.menu.mockResolvedValue({items:[]});
 inputs.stock.mockResolvedValue({rows:[],error:null,truncated:false});
 inputs.usage.mockResolvedValue({rows:[],provenance:{coverage:"incomplete"}});
 inputs.quotes.mockResolvedValue({quotes:[],ingredients:[],currency:"USD",truncated:false});
 inputs.snapshot.mockResolvedValue({});
 const incidents=new Map<string,boolean>();
 const rpc=vi.fn(async(_name:string,args:{p_key:string;p_active:boolean})=>{
  const created=args.p_active&&incidents.get(args.p_key)!==true;
  incidents.set(args.p_key,args.p_active);return {data:created,error:null};
 });
 const run=()=>refreshBusinessAnomalies({rpc} as never,"cafe","2026-11-19","America/Los_Angeles",new Date("2026-11-19T20:00:00Z"));
 await run();expect(incidents.get("sales_decline:cafe")).toBe(true);
 expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"sales_decline:cafe",p_active:true,p_payload:expect.objectContaining({current:4200,previous:7000})}));
 unknown=true;rpc.mockClear();await run();
 expect(incidents.get("sales_decline:cafe")).toBe(true);
 expect(rpc.mock.calls.some(([,args])=>args.p_key==="sales_decline:cafe")).toBe(false);
 expect(incidents.get("data_gap:sales_coverage")).toBe(true);
 unknown=false;current=1000;await run();
 expect(incidents.get("sales_decline:cafe")).toBe(false);
 expect(incidents.get("data_gap:sales_coverage")).toBe(false);
});

it("a failed reader persists an explicit gap without blocking independently verified sales",async()=>{
 inputs.sales.mockImplementation(async(_id:string,period:{from:string;to:string})=>({available:true,value:Array.from({length:7},()=>({netSalesCents:period.from==="2026-11-12"?600:1000})),quality:{missingInputs:[],estimatedInputs:[],staleInputs:[]}}));
 inputs.expenses.mockRejectedValueOnce(Error("source_read_failed"));
 const rpc=vi.fn(async()=>({data:true,error:null}));
 await expect(refreshBusinessAnomalies({rpc} as never,"cafe","2026-11-19","America/Los_Angeles",new Date("2026-11-19T20:00:00Z"))).rejects.toThrow("business_anomaly_refresh_incomplete");
 expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"data_gap:reader_unavailable:expenses",p_active:true}));
 expect(rpc).toHaveBeenCalledWith("supervisor_reconcile_business_anomaly",expect.objectContaining({p_key:"sales_decline:cafe",p_active:true}));
});

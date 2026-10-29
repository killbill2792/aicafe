import {beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const {rpc,select,eq,is,order,range}=vi.hoisted(()=>({
 rpc:vi.fn(),select:vi.fn(),eq:vi.fn(),is:vi.fn(),order:vi.fn(),range:vi.fn()
}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:vi.fn(async()=>({
  rpc,from:vi.fn(()=>({select}))
}))}));
import {saveOwnerFactAnswers,saveOwnerFact,loadOwnerFacts} from "./store.server";
describe("café-scoped owner facts persistence",()=>{
 beforeEach(()=>{
  rpc.mockReset();select.mockReset();eq.mockReset();is.mockReset();order.mockReset();range.mockReset();
  select.mockReturnValue({eq});eq.mockReturnValue({is});is.mockReturnValue({order});order.mockReturnValue({range});
 });
 it("submits six structured facts atomically, never as prose",async()=>{
  rpc.mockResolvedValue({data:[{id:"one",writeThroughApplied:true},{id:"two",writeThroughApplied:true}],error:null});
  const saved=await saveOwnerFactAnswers("cafe-A",[
   {fieldKey:"monthly_bills_cents",value:820000,unit:"cents",periodScope:"month"},
   {fieldKey:"payroll_extras_monthly_cents",value:40000,unit:"cents",periodScope:"month"}
  ]);
  expect(saved).toHaveLength(2);
  expect(rpc).toHaveBeenCalledWith("save_owner_fact_answers",{p_business_id:"cafe-A",
   p_answers:[{factKey:"monthly_bills_cents",value:820000,unit:"cents",periodScope:"month"},
    {factKey:"payroll_extras_monthly_cents",value:40000,unit:"cents",periodScope:"month"}]});
 });
 it("queries only current rows of the selected café on each turn",async()=>{
  range.mockResolvedValue({data:[{fact_key:"rent_monthly_cents",value_json:200000,
   created_at:"2026-10-28T12:00:00Z",unit:"cents",period_scope:"month"}],error:null});
  const rows=await loadOwnerFacts("cafe-A");
  expect(eq).toHaveBeenCalledWith("business_id","cafe-A");
  expect(is).toHaveBeenCalledWith("superseded_at",null);
  expect(rows[0].value_json).toBe(200000);
  expect(range).toHaveBeenCalledWith(0,199);
 });
 it("reads all active facts beyond first 200 without hiding old answers",async()=>{
  const make=(n:number)=>({fact_key:"key_"+n,value_json:n,
   created_at:"2026-10-28T12:00:00Z",unit:null,period_scope:null});
  range.mockImplementation(async(start:number)=>({data:start===0?
    Array.from({length:200},(_,i)=>make(i)):Array.from({length:5},(_,i)=>make(200+i)),error:null}));
  const rows=await loadOwnerFacts("cafe-A");
  expect(rows).toHaveLength(205);
  expect(rows[204].fact_key).toBe("key_204");
  expect(range).toHaveBeenCalledTimes(2);
  expect(range).toHaveBeenCalledWith(200,399);
 });
 it("does not hide owner-fact database failures as empty records",async()=>{
  range.mockResolvedValue({data:null,error:{code:"42P01"}});
  await expect(loadOwnerFacts("cafe-A")).rejects.toThrow("owner_facts_read_failed");
 });
 it("surfaces database failures instead of pretending a fact was saved",async()=>{
  rpc.mockResolvedValue({data:null,error:{code:"42501"}});
  await expect(saveOwnerFact("cafe-B",{fieldKey:"rent_monthly_cents",value:10000})).rejects.toThrow("owner_facts_write_failed");
 });
});

import {beforeEach,describe,expect,it,vi} from "vitest";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {recordPurchases,type PurchaseLineInput} from "./recordPurchases.server";

vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:vi.fn()}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:vi.fn()}));
const BUSINESS="11111111-1111-4111-8111-111111111111";
const INGREDIENT="22222222-2222-4222-8222-222222222222";
const ID1="33333333-3333-4333-8333-333333333333";
const ID2="44444444-4444-4444-8444-444444444444";
const line=(id:string):PurchaseLineInput=>({lineId:id,ingredientId:INGREDIENT,
 date:"2026-10-25",quantity:4,unit:"gal",costCents:2199});
function fakeDb(role="owner",is_demo=false){
 const rpc=vi.fn(async(_name:string,_args:Record<string,unknown>):Promise<{error:{code:string}|null}>=>({error:null}));
 const from=vi.fn((table:string)=>{
  if(table==="memberships")return {select:()=>({eq:()=>({eq:()=>({
    maybeSingle:async()=>({data:{role,businesses:{is_demo}},error:null})
  })})})};
  if(table==="ingredients")return {select:()=>({eq:()=>({eq:()=>({
   maybeSingle:async()=>({data:{id:INGREDIENT,base_unit:"ml"},error:null})
  })})})};
  if(table==="ingredient_unit_conversions")return {select:()=>({eq:async()=>({
    data:[],error:null
  })})};
  throw Error("Unexpected direct purchase table access: "+table);
 });
 return {db:{auth:{getUser:async()=>({data:{user:{id:"owner"}}})},from,rpc},rpc,from};
}
beforeEach(()=>{vi.mocked(getActiveBusinessId).mockResolvedValue(BUSINESS);});
describe("single transactional purchase path",()=>{
 it("uses one atomic RPC for stock and ingredient price, in canonical units",async()=>{
  const {db,rpc,from}=fakeDb();
  vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
  expect(await recordPurchases([line(ID1)],"bulk",null)).toEqual([{lineId:ID1,ok:true}]);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("pantry_write_purchase_line",expect.objectContaining({
   p_business_id:BUSINESS,p_line_id:ID1,p_ingredient_id:INGREDIENT,
   p_source:"bulk",p_cost_cents:2199,p_price_micros:expect.any(Number),
   p_base_quantity:15141.6474,p_expected_updated_at:null
  }));
  expect(from).not.toHaveBeenCalledWith("pantry_stock_purchases");
  expect(from).not.toHaveBeenCalledWith("ingredient_prices");
 });
 it("reports failures independently and forwards stable line IDs for retry",async()=>{
  const {db,rpc}=fakeDb();
  rpc.mockResolvedValueOnce({error:{code:"40001"}}).mockResolvedValueOnce({error:null});
  vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
  const results=await recordPurchases([line(ID1),line(ID2)],"csv","file-hash");
  expect(results).toEqual([{lineId:ID1,ok:false,error:"purchase_changed"},
   {lineId:ID2,ok:true}]);
  expect(rpc.mock.calls.map(c=>c[1].p_line_id)).toEqual([ID1,ID2]);
 });
 it("rejects demo and non-owner requests before writing stock",async()=>{
  for(const [role,demo] of [["owner",true],["member",false]] as const){
   const {db,rpc}=fakeDb(role,demo);
   vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
   expect(await recordPurchases([line(ID1)],"manual",null)).toEqual([
    {lineId:ID1,ok:false,error:"owner_required"}
   ]);
   expect(rpc).not.toHaveBeenCalled();
  }
 });
});

import {beforeEach,describe,expect,it,vi} from "vitest";
import {importInventoryCsv} from "./inventory";
import {recordPurchases} from "@/lib/inventory/recordPurchases.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/lib/inventory/recordPurchases.server",()=>({recordPurchases:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:vi.fn()}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:vi.fn()}));
const BUSINESS="11111111-1111-4111-8111-111111111111";
const ING="22222222-2222-4222-8222-222222222222";
const text="date,item,quantity,unit,cost\n2026-10-25,Milk,4,gal,20.00";
const mapping={date:"date",item:"item",quantity:"quantity",unit:"unit",cost:"cost"};
beforeEach(()=>{
 vi.mocked(getActiveBusinessId).mockResolvedValue(BUSINESS);
 vi.mocked(createServerSupabaseClient).mockResolvedValue({
  auth:{getUser:async()=>({data:{user:{id:"owner"}}})},
  from:(table:string)=>{
   if(table==="memberships")return {select:()=>({eq:()=>({eq:()=>({
    maybeSingle:async()=>({data:{role:"owner",businesses:{is_demo:false}},error:null})
   })})})};
   if(table==="ingredients")return {select:()=>({eq:()=>({
    limit:async()=>({data:[{id:ING,name:"Milk"}],error:null})
   })})};
   throw Error("Unexpected "+table);
  }
 } as never);
 vi.mocked(recordPurchases).mockImplementation(async lines=>lines.map(line=>({lineId:line.lineId,ok:true})));
});
describe("purchases CSV stable source identity",()=>{
 it("repeated identical uploads use the same canonical line ID and source hash",async()=>{
  const first=await importInventoryCsv(text,mapping);
  const second=await importInventoryCsv(text,mapping);
  expect(first).toHaveLength(1);
  expect(first[0].ok).toBe(true);
  expect(second).toEqual(first);
  const calls=vi.mocked(recordPurchases).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0][1]).toBe("csv");
  expect(calls[0][0][0]).toMatchObject({ingredientId:ING,quantity:4,unit:"gal",costCents:2000});
  expect(calls[1][0][0].lineId).toBe(calls[0][0][0].lineId);
  expect(calls[1][2]).toBe(calls[0][2]);
 });
});

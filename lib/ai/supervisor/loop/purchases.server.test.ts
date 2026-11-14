import {beforeEach,describe,expect,it,vi} from "vitest";
import {recordPurchases} from "@/lib/inventory/recordPurchases.server";
import {receiptStockLineId} from "./receiptAllocation";
import {simulationOwnerReader} from "./simulationOwner.server";
import {purchaseCapability} from "./purchases.server";

vi.mock("server-only",()=>({}));
vi.mock("./simulationOwner.server",()=>({simulationOwnerReader:vi.fn()}));
vi.mock("@/lib/inventory/recordPurchases.server",()=>({recordPurchases:vi.fn()}));
const owner={businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",
 threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const ingredientId="44444444-4444-4444-8444-444444444444";
const proposalId="55555555-5555-4555-8555-555555555555";
const groupId="66666666-6666-4666-8666-666666666666";
const line={ingredientId,name:"Milk",quantity:10,unit:"gal",costCents:4000,date:"2026-11-12",
 source:"chat_text" as const,receiptGroupId:groupId,receiptLineIndex:2,
 receiptVendor:"Shop",receiptTotalCents:4000};
beforeEach(()=>{vi.mocked(recordPurchases).mockReset().mockResolvedValue([{lineId:receiptStockLineId(groupId,2),ok:true}]);});
describe("new ingredient matching excludes archived stock",()=>{
 it("selects active café ingredients only before proposing an effect",async()=>{
  const last=vi.fn(async()=>({data:[{id:ingredientId,name:"Milk",base_unit:"gal"}],error:null}));
  const filterActive=vi.fn(()=>({limit:last}));
  const filterCafe=vi.fn(()=>({is:filterActive}));
  const select=vi.fn(()=>({eq:filterCafe}));
  vi.mocked(simulationOwnerReader).mockResolvedValue({client:{from:vi.fn(()=>({select}))}} as never);
  const result=await purchaseCapability.simulate(owner,{...line,ingredientId:null});
  expect(filterCafe).toHaveBeenCalledWith("business_id",owner.businessId);
  expect(filterActive).toHaveBeenCalledWith("archived_at",null);
  expect(result.effect.ingredientId).toBe(ingredientId);
 });
});
describe("single authoritative inventory purchase writer",()=>{
 it("commits photo-backed stock only, with source-derived stable id and no separate expense",async()=>{
  await purchaseCapability.commit(owner,line,proposalId);
  expect(recordPurchases).toHaveBeenCalledTimes(1);
  expect(recordPurchases).toHaveBeenCalledWith([{
   lineId:receiptStockLineId(groupId,2),ingredientId,date:"2026-11-12",
   quantity:10,unit:"gal",costCents:4000
  }],"chat_text",groupId+":2",owner.businessId);
 });
 it("a second proposal for identical receipt bytes and source index reuses the exact stock key",async()=>{
  await purchaseCapability.commit(owner,line,proposalId);
  await purchaseCapability.commit(owner,line,"77777777-7777-4777-8777-777777777777");
  const ids=vi.mocked(recordPurchases).mock.calls.map(call=>call[0][0].lineId);
  expect(ids).toEqual([receiptStockLineId(groupId,2),receiptStockLineId(groupId,2)]);
 });
 it("keeps the existing reviewed receipt expense+stock contract intact",async()=>{
  vi.mocked(recordPurchases).mockResolvedValue([{lineId:proposalId,ok:true}]);
  await purchaseCapability.commit(owner,{...line,source:"receipt_chat"},proposalId);
  expect(recordPurchases).toHaveBeenCalledWith([expect.objectContaining({
   lineId:proposalId,receipt:{groupId,index:2,vendor:"Shop",totalCents:4000,name:"Milk"}
  })],"receipt_chat",groupId,owner.businessId);
 });
 it("never reports success from a failed stock purchase",async()=>{
  vi.mocked(recordPurchases).mockResolvedValue([{lineId:receiptStockLineId(groupId,2),ok:false,error:"purchase_changed"}]);
  await expect(purchaseCapability.commit(owner,line,proposalId)).rejects.toThrow("purchase_changed");
 });
});

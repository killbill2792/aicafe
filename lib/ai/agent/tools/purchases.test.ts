import {describe,it,expect,vi} from "vitest";
import {purchasesTools,purchaseToolInput} from "./purchases";
import type {AgentToolContext} from "./index";
const id="33333333-3333-4333-8333-333333333333";
const line=(n:number)=>({
 ingredientId:id,name:"Milk",quantity:n+1,unit:"gal",costCents:(n+1)*100,
 date:"2026-10-25"
});
describe("purchase proposal tool: ten-line receipt, independent approvals",()=>{
 it("prepares ten inert lines without writing purchases; failed line remains distinct",async()=>{
  const proposePurchases=vi.fn(async(input:{lines:ReturnType<typeof line>[]})=>
   input.lines.map((row,i)=>i===3?{name:row.name,error:"needs_review"}:
    {name:row.name,proposalId:"proposal-"+i,revision:1}));
  const ctx={proposals:{proposePurchases}} as unknown as AgentToolContext;
  const raw={source:"receipt_chat",lines:Array.from({length:10},(_,n)=>line(n)),
   receiptVendor:"Market",receiptTotalCents:5500};
  const result=await purchasesTools.propose_purchases.execute(raw,ctx);
  expect(proposePurchases).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({source:"purchase_proposal",draft:true,saved:false,
   missing:["someLinesNeedReview"]});
  const proposed=(result as unknown as {proposals:Array<{proposalId?:string;error?:string}>}).proposals;
  expect(proposed).toHaveLength(10);
  expect(proposed[3].error).toBe("needs_review");
  expect(proposed.filter(row=>row.proposalId)).toHaveLength(9);
 });
 it("rejects eleven lines and invalid extracted totals without invoking writes",()=>{
  expect(purchaseToolInput.safeParse({source:"receipt_chat",
   lines:Array.from({length:11},(_,n)=>line(n)),receiptVendor:"Market",receiptTotalCents:5500}).success).toBe(false);
  expect(purchaseToolInput.safeParse({source:"receipt_chat",
   lines:[line(0)],receiptVendor:"Market",receiptTotalCents:-1}).success).toBe(false);
  expect(purchaseToolInput.safeParse({source:"receipt_chat",
   lines:[line(0)],receiptVendor:null,receiptTotalCents:null}).success).toBe(true);
 });
});

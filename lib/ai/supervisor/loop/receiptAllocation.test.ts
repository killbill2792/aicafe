import {describe,it,expect} from "vitest";
import {allocateReceiptIndexes,purchaseBatchKeys,receiptEvidenceGroupId,receiptStockLineId} from "./receiptAllocation";
const thread="11111111-1111-4111-8111-111111111111";
const owner="22222222-2222-4222-8222-222222222222";
describe("receipt-wide proposal indexes",()=>{
 it("reordered and partially repeated tool calls reuse original physical stock identities",()=>{
  const milk={ingredientId:"33333333-3333-4333-8333-333333333333",name:"Milk",quantity:10,unit:"gal",costCents:4500,date:"2026-11-12"};
  const beans={ingredientId:"44444444-4444-4444-8444-444444444444",name:"Beans",quantity:2,unit:"lb",costCents:1200,date:"2026-11-12"};
  const first=purchaseBatchKeys(thread,owner,"receipt_chat",[milk,beans]);
  const initial=allocateReceiptIndexes(first,[]);
  expect(initial).toEqual([0,1]);
  const stored=first.map((requestKey,index)=>({requestKey,index:initial[index]}));
  const overlapping=purchaseBatchKeys(thread,owner,"receipt_chat",[beans,milk]);
  expect(overlapping).toEqual([first[1],first[0]]);
  expect(allocateReceiptIndexes(overlapping,stored)).toEqual([1,0]);
  expect(purchaseBatchKeys(thread,owner,"receipt_chat",[milk])).toEqual([first[0]]);
  expect(allocateReceiptIndexes([first[0]],stored)).toEqual([0]);
  // Two physically distinct equal-valued lines in a single batch are still distinct.
  const identical=purchaseBatchKeys(thread,owner,"receipt_chat",[milk,milk]);
  expect(new Set(identical).size).toBe(2);
  expect(identical[0]).toBe(first[0]);
  expect(allocateReceiptIndexes(identical,stored)).toEqual([0,2]);
 });
 it("does not add stock twice for byte-identical photo reuploads",()=>{
  const group1=receiptEvidenceGroupId(thread,owner,"a".repeat(64));
  const group2=receiptEvidenceGroupId(thread,owner,"a".repeat(64));
  expect(group2).toBe(group1);
  expect(receiptStockLineId(group1,0)).toBe(receiptStockLineId(group2,0));
  expect(receiptStockLineId(group1,1)).not.toBe(receiptStockLineId(group2,0));
  expect(receiptEvidenceGroupId(owner,thread,"a".repeat(64))).not.toBe(group1);
  expect(receiptEvidenceGroupId(thread,owner,"b".repeat(64))).not.toBe(group1);
 });

 it("allocates 10 then 3 lines, and identical second-batch retry reuses indexes",()=>{
  const first=Array.from({length:10},(_,i)=>({name:"Milk",quantity:i+1}));
  // These really are NEW lines (11..13), not a repeated subset (1..3).
  const second=Array.from({length:3},(_,i)=>({name:"Milk",quantity:i+11}));
  const a=purchaseBatchKeys(thread,owner,"receipt_chat",first);
  const b=purchaseBatchKeys(thread,owner,"receipt_chat",second);
  const ai=allocateReceiptIndexes(a,[]);
  expect(ai).toEqual(Array.from({length:10},(_,i)=>i));
  const firstStored=a.map((requestKey,i)=>({requestKey,index:ai[i]}));
  const bi=allocateReceiptIndexes(b,firstStored);
  expect(bi).toEqual([10,11,12]);
  expect(new Set([...a,...b]).size).toBe(13);
  const repeated=allocateReceiptIndexes(b,[...firstStored,...b.map((requestKey,i)=>({requestKey,index:bi[i]}))]);
  expect(repeated).toEqual([10,11,12]);
 });
});

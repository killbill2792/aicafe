import {describe,it,expect} from "vitest";
import {allocateReceiptIndexes,purchaseBatchKeys,receiptEvidenceGroupId,receiptStockLineId} from "./receiptAllocation";
const thread="11111111-1111-4111-8111-111111111111";
const owner="22222222-2222-4222-8222-222222222222";
describe("receipt-wide proposal indexes",()=>{
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
  const second=Array.from({length:3},(_,i)=>({name:"Milk",quantity:i+1}));
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

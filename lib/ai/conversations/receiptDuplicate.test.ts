import {describe,it,expect} from "vitest";
import {possiblePriorReceipt} from "./receiptDuplicate";
const row=(overrides:Record<string,unknown>={})=>({
 status:"committed",created_at:"2026-11-12T10:00:00Z",
 canonical_effect_payload:{receiptGroupId:"photo-A",receiptVendor:"Market",
 receiptTotalCents:2500,date:"2026-11-12",...overrides}
});
const current={groupId:"photo-B",vendor:" market ",totalCents:2500,
 dates:["2026-11-12"],ownerMessageAt:"2026-11-12T11:00:00Z"};
describe("same sale photographed twice",()=>{
 it("requires review for equivalent printed merchant/date/total with different bytes",()=>{
  expect(possiblePriorReceipt([row()],current)).toBe(true);
 });
 it("does not block same source retry or unrelated receipts",()=>{
  expect(possiblePriorReceipt([row({receiptGroupId:"photo-B"})],current)).toBe(false);
  expect(possiblePriorReceipt([row({receiptTotalCents:2600})],current)).toBe(false);
  expect(possiblePriorReceipt([row({date:"2026-11-11"})],current)).toBe(false);
  expect(possiblePriorReceipt([{...row(),status:"draft"}],current)).toBe(false);
 });
 it("does not assume a duplicate when printed information is missing",()=>{
  expect(possiblePriorReceipt([row()],{...current,totalCents:null})).toBe(false);
  expect(possiblePriorReceipt([row()],{...current,vendor:null})).toBe(false);
 });
});

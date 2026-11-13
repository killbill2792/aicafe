import {describe,expect,it} from "vitest";
import {projectInventoryEvidence} from "./inventoryEvidence";
import en from "../../messages/en.json";

const base={source:"toast",source_ref:"toast-current:1",status:"open",
 business_date:"2026-11-12",menu_item_ref:"b",stock_status:"QUANTITY",quantity:4,
 data:{source_as_of:"2026-11-12T20:00:00.000Z",checked_at:"2026-11-12T20:00:00.000Z",
  reported_stock_status:"QUANTITY",evidence_state:"observed_current"}};
describe("English inventory evidence labels",()=>{
 it("has explicit, human-readable English status and unknown-vs-zero semantics",()=>{
  const labels=en.MenuBuilder;
  const keys=Object.keys(labels).filter(key=>key.startsWith("stockEvidence")).sort();
  expect(keys).toHaveLength(15);
  for(const key of keys){
   const text=labels[key as keyof typeof labels];
   expect(text).toBeTruthy();
   expect(text).not.toMatch(/source_unverified|not_observed|source_failed|observed_current/);
  }
  expect(labels.stockEvidenceCurrent).toContain("latest successful Toast");
  expect(labels.stockEvidenceNotObserved).toContain("Historical only");
  expect(labels.stockEvidenceFailed).toContain("failed");
  expect(labels.stockEvidenceUnknown).toContain("not zero");
  expect(labels.stockEvidenceNoRows).toContain("does not mean zero");
 });
});

describe("canonical inventory evidence projection",()=>{
 it("accepts only current successful Toast observation with explicit quantity",()=>{
  expect(projectInventoryEvidence([base]).rows[0]).toMatchObject({
   evidence_state:"observed_current",quantity:4,stock_status:"QUANTITY",
   quantity_state:"known",source_as_of:base.data.source_as_of});
 });
 it("keeps an omitted historic record but never presents it as current stock",()=>{
  const projected=projectInventoryEvidence([{...base,data:{...base.data,evidence_state:"not_observed"}}]);
  expect(projected.rows[0]).toMatchObject({
   evidence_state:"not_observed",quantity:null,stock_status:null,
   reported_stock_status:"QUANTITY"});
  expect(projected.missing).toContain("stockNotObservedInLatestSuccess");
 });
 it("rejects stale or unverified quantities even when an old record says OUT_OF_STOCK",()=>{
  for(const evidence_state of ["source_failed","source_unverified",undefined]){
   const row=projectInventoryEvidence([{...base,quantity:0,stock_status:"OUT_OF_STOCK",
    data:{...base.data,evidence_state}}]).rows[0];
   expect(row.quantity).toBeNull();
   expect(row.stock_status).toBeNull();
  }
 });
 it("preserves an explicit owner zero without turning an absent quantity into zero",()=>{
  const owner={source:"app",source_ref:"stock:1",status:"actual",
   business_date:"2026-11-12",quantity:0,data:{ingredient_id:"milk",
    ingredient_name:"Whole Milk",base_unit:"ml",count_date:"2026-11-12"}};
  expect(projectInventoryEvidence([owner,{...base,quantity:null}]).rows).toMatchObject([
   {quantity:0,evidence_state:"dated_owner_count",quantity_state:"known",
    ingredient_id:"milk",ingredient_name:"Whole Milk",quantity_unit:"ml"},
   {quantity:null,quantity_state:"unknown"}]);
 });
 it("does not count duplicate evidence rows as stock totals or assume a missing item",()=>{
  const result=projectInventoryEvidence([base,base]);
  expect(result.rows).toHaveLength(2);
  expect(result.rows[0].quantity).toBe(4);
  expect(result.rows[1].quantity).toBe(4);
  expect(result).not.toHaveProperty("total");
  expect(projectInventoryEvidence([]).rows).toEqual([]);
 });
 it("bounds output and drops dangerous arbitrary provider fields",()=>{
  const noisy={...base,data:{...base.data,secret:"not-for-tools"},customer:"private"};
  const r=projectInventoryEvidence([noisy,noisy,noisy],2);
  expect(r.rows).toHaveLength(2);
  expect(r.truncated).toBe(true);
  expect(JSON.stringify(r)).not.toContain("private");
  expect(JSON.stringify(r)).not.toContain("not-for-tools");
 });
});

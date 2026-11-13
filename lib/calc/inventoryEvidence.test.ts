import {describe,expect,it} from "vitest";
import {projectInventoryEvidence} from "./inventoryEvidence";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import ar from "../../messages/ar.json";

const base={source:"toast",source_ref:"toast-current:1",status:"open",
 business_date:"2026-11-12",menu_item_ref:"b",stock_status:"QUANTITY",quantity:4,
 data:{source_as_of:"2026-11-12T20:00:00.000Z",checked_at:"2026-11-12T20:00:00.000Z",
  reported_stock_status:"QUANTITY",evidence_state:"observed_current"}};
describe("localized inventory evidence labels",()=>{
 it("has matching human-readable EN/ES/AR keys and no raw provider-state jargon",()=>{
  const messages=[en,es,ar].map(lang=>lang.MenuBuilder);
  const keys=Object.keys(messages[0]).filter(key=>key.startsWith("stockEvidence")).sort();
  expect(keys).toHaveLength(15);
  for(const m of messages){
   expect(Object.keys(m).filter(key=>key.startsWith("stockEvidence")).sort()).toEqual(keys);
   for(const key of keys){
    const label=m[key as keyof typeof m];
    expect(label).toBeTruthy();
    expect(label).not.toMatch(/source_unverified|not_observed|source_failed|observed_current/);
   }
  }
  for(const key of keys){
   expect(es.MenuBuilder[key as keyof typeof es.MenuBuilder])
    .not.toBe(en.MenuBuilder[key as keyof typeof en.MenuBuilder]);
   expect(ar.MenuBuilder[key as keyof typeof ar.MenuBuilder])
    .not.toBe(en.MenuBuilder[key as keyof typeof en.MenuBuilder]);
  }
  expect(en.MenuBuilder.stockEvidenceUnknown).toContain("not zero");
  expect(es.MenuBuilder.stockEvidenceUnknown).toContain("no equivale a cero");
  expect(ar.MenuBuilder.stockEvidenceUnknown).toContain("لا يعني صفرًا");
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
   business_date:"2026-11-12",quantity:0,data:{ingredient_id:"milk",count_date:"2026-11-12"}};
  expect(projectInventoryEvidence([owner,{...base,quantity:null}]).rows).toMatchObject([
   {quantity:0,evidence_state:"dated_owner_count",quantity_state:"known"},
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

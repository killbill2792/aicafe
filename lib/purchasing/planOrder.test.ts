import {describe,it,expect} from "vitest";
import {planSupplierOrder,type SupplierQuote} from "./planOrder";
const ingredient={id:"11111111-1111-4111-8111-111111111111",name:"Milk",base_unit:"ml"};
const quote:SupplierQuote={id:"22222222-2222-4222-8222-222222222222",
 supplier_name:"Farm A",item_name:"Milk",ingredient_id:ingredient.id,
 price_cents:450,package_count:1,package_unit:"gal",currency_code:"CAD",
 source_kind:"supplier_quote",quoted_on:"2026-11-12",valid_until:"2026-11-20",
 available_status:"confirmed",available_checked_at:"2026-11-13",delivery_on:"2026-11-16"};
const plan=(overrides:Partial<Parameters<typeof planSupplierOrder>[0]>={})=>
 planSupplierOrder({needs:[{ingredientId:ingredient.id,itemName:"Milk",quantity:5,unit:"gal"}],
  ingredients:[ingredient],quotes:[quote],currency:"CAD",today:"2026-11-13",
  neededBy:"2026-11-17",preferredSupplier:null,...overrides});
describe("Task 14B deterministic purchasing decisions",()=>{
 it("uses physical units, ceiling packs and integer cents without claiming landed cost",()=>{
  const p=plan();
  expect(p.offers).toHaveLength(1);
  expect(p.offers[0]).toMatchObject({subtotalCents:2250,currency:"CAD",
   shippingCents:null,taxCents:null,totalCents:null,
   lines:[{packs:5,baseUnit:"ml",priceCents:450}]});
  expect(p.comparison).toBe("subtotal_only");
 });
 it("does not turn a different currency or legacy unknown currency into an offer",()=>{
  expect(plan({quotes:[{...quote,currency_code:"USD"}]}).offers).toHaveLength(0);
  expect(plan({quotes:[{...quote,currency_code:null}]}).missing).toContain("quote_currency_unconfirmed:Farm A:Milk");
 });
 it("rejects unconfirmed/stale availability, expired, public listings or late delivery",()=>{
  for(const candidate of [
   {...quote,available_status:"unknown"},
   {...quote,available_checked_at:"2026-10-01"},
   {...quote,valid_until:"2026-11-11"},
   {...quote,valid_until:null,quoted_on:"2026-01-01"},
   {...quote,source_kind:"public_listing"},
   {...quote,delivery_on:"2026-11-19"}
  ])expect(plan({quotes:[candidate]}).offers).toHaveLength(0);
 });
 it("normalizes supplier litre packs to the canonical metric unit without a density guess",()=>{
  const p=plan({needs:[{ingredientId:ingredient.id,itemName:"Milk",quantity:10,unit:"l"}],
   quotes:[{...quote,price_cents:200,package_unit:"liter",package_count:2}]});
  expect(p.offers).toHaveLength(1);
  expect(p.offers[0]).toMatchObject({subtotalCents:1000,lines:[{packs:5,packUnit:"liter"}]});
 });
 it("never over-orders exact multiples because of floating conversion noise",()=>{
  expect(plan({needs:[{ingredientId:ingredient.id,itemName:"Milk",quantity:11,unit:"gal"}]})
    .offers[0].lines[0].packs).toBe(11);
  expect(plan({needs:[{ingredientId:ingredient.id,itemName:"Milk",quantity:11.0001,unit:"gal"}]})
    .offers[0].lines[0].packs).toBe(12);
  expect(plan({needs:[{ingredientId:ingredient.id,itemName:"Milk",quantity:22,unit:"qt"}]})
    .offers[0].lines[0].packs).toBe(6);
 });
 it("the newest unavailable or repriced quote supersedes the old one",()=>{
  const old={...quote,created_at:"2026-11-12T10:00:00Z"};
  const newer={...quote,id:"55555555-5555-4555-8555-555555555555",
    created_at:"2026-11-13T10:00:00Z",available_status:"unavailable"};
  expect(plan({quotes:[old,newer]}).offers).toHaveLength(0);
  expect(plan({quotes:[newer,old]}).offers).toHaveLength(0);
  const corrected={...newer,available_status:"confirmed",price_cents:550};
  expect(plan({quotes:[old,corrected]}).offers[0]).toMatchObject({
    subtotalCents:2750,lines:[{quoteId:corrected.id,priceCents:550}]
  });
 });
 it("never guesses how many ingredients are in a case",()=>{
  expect(plan({quotes:[{...quote,package_unit:"case",package_count:12}]}).offers).toHaveLength(0);
 });
 it("makes multi-line supplier coverage a prerequisite, not two incomplete orders",()=>{
  const second={id:"33333333-3333-4333-8333-333333333333",name:"Sugar",base_unit:"g"};
  const p=plan({ingredients:[ingredient,second],needs:[
   {ingredientId:ingredient.id,itemName:"Milk",quantity:5,unit:"gal"},
   {ingredientId:second.id,itemName:"Sugar",quantity:1,unit:"kg"}
  ]});
  expect(p.offers).toHaveLength(0);
  expect(p.missing).toContain("supplier_does_not_cover_item:Farm A:Sugar");
 });
 it("does not trust unmatched ingredient names, stale quotes or incomplete reads",()=>{
  expect(plan({needs:[{ingredientId:null,itemName:"Cream",quantity:1,unit:"gal"}]}).offers).toHaveLength(0);
  expect(plan({truncated:true}).offers).toHaveLength(0);
 });
 it("sorts grounded subtotal candidates without implying an all-in cheapest supplier",()=>{
  const p=plan({quotes:[quote,{...quote,id:"44444444-4444-4444-8444-444444444444",
   supplier_name:"Farm B",price_cents:400}]});
  expect(p.offers.map(x=>x.supplierName)).toEqual(["Farm B","Farm A"]);
  expect(p.offers[0].totalCents).toBe(null);
 });
});
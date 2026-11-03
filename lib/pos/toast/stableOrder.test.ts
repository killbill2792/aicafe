import {createHash} from "node:crypto";
import {describe,expect,it} from "vitest";
import {stableToastOrder,stableToastOrderPage} from "./stableOrder";

const tax=(guid:string,name:string,amount:number)=>({guid,name,rate:0.01,type:"PERCENT",
 taxRate:{guid:"t-"+guid,entityType:"TaxRate"},taxAmount:amount,entityType:"AppliedTaxRate"});
const county=tax("1c2795c0-ef24-455b-b6cb-b2bcc26b70e5","CA COUNTY TAX",0.04);
const state=tax("0232db49-4d5b-41e9-9b62-9eb64e465182","CA STATE TAX",0.84);
const special=tax("33f3c70d-b180-4015-a419-5cfb894bb29c","CA SPECIAL TAX",0.19);
const order=(taxes:unknown[],selections:unknown[])=>({guid:"order-1",checks:[{guid:"check-1",
 amount:14,payments:[{guid:"pay-1",amount:15.21}],
 selections:selections.map(s=>({...(s as {guid:string;price:number}),appliedTaxes:(s as {guid:string}).guid==="sel-a"?taxes:[]}))}]});
const a={guid:"sel-a",price:4};
const b={guid:"sel-b",price:10};
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");

describe("stable Toast order content",()=>{
 it("gives two downloads of the same order the same hash when Toast shuffles its lists",()=>{
  const first=order([county,state,special],[a,b]);
  const second=order([county,special,state],[b,a]);
  expect(hash(first)).not.toBe(hash(second));
  expect(hash(stableToastOrder(first))).toBe(hash(stableToastOrder(second)));
 });
 it("keeps every item and value, only reordering GUID lists",()=>{
  const out=stableToastOrder(order([special,county,state],[b,a]));
  const check=out.checks[0];
  expect(check.selections.map(s=>s.guid)).toEqual(["sel-a","sel-b"]);
  const taxes=check.selections[0].appliedTaxes as typeof county[];
  expect(taxes.map(t=>t.name).sort()).toEqual(["CA COUNTY TAX","CA SPECIAL TAX","CA STATE TAX"]);
  expect(taxes.reduce((s,t)=>s+t.taxAmount,0)).toBeCloseTo(1.07);
  expect(check.payments).toEqual([{guid:"pay-1",amount:15.21}]);
 });
 it("still sees a real change as a new version",()=>{
  const before=order([county,state],[a]);
  const after=order([state,{...county,taxAmount:0.05}],[a]);
  expect(hash(stableToastOrder(before))).not.toBe(hash(stableToastOrder(after)));
 });
 it("leaves lists without GUIDs and the page itself in Toast's order",()=>{
  const page=[{guid:"z",tags:["b","a"],lines:[{amount:2},{amount:1}]},{guid:"a"}];
  const out=stableToastOrderPage(page) as typeof page;
  expect(out.map(o=>o.guid)).toEqual(["z","a"]);
  expect(out[0].tags).toEqual(["b","a"]);
  expect(out[0].lines).toEqual([{amount:2},{amount:1}]);
 });
});

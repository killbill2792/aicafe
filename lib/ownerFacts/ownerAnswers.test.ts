import {describe,it,expect} from "vitest";
import {validateOwnerAnswers} from "./answers";
const fields=[
 {key:"monthlyBills",inputType:"money",units:[],defaultUnit:""},
 {key:"staff_count",inputType:"number",units:[],defaultUnit:""},
 {key:"cardFeeRate",inputType:"percent",units:[],defaultUnit:""},
 {key:"supplier_name",inputType:"text",units:[],defaultUnit:""},
 {key:"next_invoice_date",inputType:"date",units:[],defaultUnit:""},
 {key:"supplier_choice",inputType:"choice",units:[],defaultUnit:"",
  choices:[{label:"A",value:"a"},{label:"B",value:"b"}]}
];
describe("structured owner card answers",()=>{
 it("rejects a café-wide unit cost but accepts a scoped per-item cost",()=>{
  const global=[{key:"unitCostCents",inputType:"money",units:[],defaultUnit:""}];
  expect(()=>validateOwnerAnswers(global,[{fieldKey:"unitCostCents",value:"1.25"}],"en"))
   .toThrow("unscoped_item_cost");
  const scoped=[{key:"unit_cost_cents:item:latte-id",inputType:"money",units:[],defaultUnit:""}];
  expect(validateOwnerAnswers(scoped,[{fieldKey:scoped[0].key,value:"1.25"}],"en"))
   .toMatchObject([{fieldKey:scoped[0].key,value:125}]);
 });
 it("parses six typed fields including Arabic digits",()=>{
  const answers=["١٣٠٠٫٥٠","٣","٢٫٥","Supplier","2026-10-29","a"].map((value,i)=>({fieldKey:fields[i].key,value}));
  const parsed=validateOwnerAnswers(fields,answers,"ar");
  expect(parsed[0]).toMatchObject({fieldKey:"monthly_bills_cents",value:130050,unit:"cents"});
  expect(parsed[1].value).toBe(3);
  expect(parsed[2].value).toBe(2.5);
  expect(parsed[4].value).toBe("2026-10-29");
  expect(parsed[5].value).toBe("a");
 });
 it("accepts partial card answers without saving blank fields",()=>{
  const parsed=validateOwnerAnswers(fields,[{fieldKey:"monthlyBills",value:"1,250.50"}],"en");
  expect(parsed).toEqual([{fieldKey:"monthly_bills_cents",value:125050,unit:"cents",periodScope:"month"}]);
 });
 it("rejects invalid choice or duplicate fields",()=>{
  expect(()=>validateOwnerAnswers(fields,[...fields.map(f=>({fieldKey:f.key,value:"2"}))],"en")).toThrow();
 });
});

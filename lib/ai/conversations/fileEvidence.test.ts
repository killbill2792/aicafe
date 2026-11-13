import {describe,expect,it} from "vitest";
import * as XLSX from "xlsx";
import {assertSafeWorkbook,fileEvidence} from "./fileEvidence.server";
const bytes=(s:string)=>new TextEncoder().encode(s);
describe("bounded untrusted source evidence",()=>{
 it("preserves CSV source-record ordinals and quoted newlines",()=>{
  const result=fileEvidence("text/csv",bytes("Item,Qty\n\"Whole\nmilk\",10\nBeans,2"),"order.csv");
  expect(result.text).toContain('Record 2 (not physical line): A="Whole\\nmilk" | B="10"');
 });
 it("preserves XLSX visible sheet cell names, and never evaluates formulae",()=>{
  const wb=XLSX.utils.book_new();
  const a=XLSX.utils.aoa_to_sheet([["Item","Qty"],["Milk",10]]);
  const b=XLSX.utils.aoa_to_sheet([["Coffee",5]]);
  XLSX.utils.book_append_sheet(wb,a,"January");
  XLSX.utils.book_append_sheet(wb,b,"February");
  const buf=XLSX.write(wb,{type:"buffer",bookType:"xlsx"}) as Uint8Array;
  const value=fileEvidence("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buf,"stock.xlsx");
  expect(value.text).toContain('Sheet 1 "January"');
  expect(value.text).toContain('A2="Milk"');
  expect(value.text).toContain('Sheet 2 "February"');
  expect(value.text).toContain('B1="5"');
 });
 it("rejects malicious, empty and invalid workbook input",()=>{
  expect(()=>assertSafeWorkbook(bytes("PK garbage"))).toThrow("invalid_xlsx");
  expect(()=>fileEvidence("text/plain",bytes("<script>not allowed</script>"),"hostile.txt")).not.toThrow();
  expect(()=>fileEvidence("text/csv",bytes("\u0000"),"bad.csv")).toThrow("unsupported_text_encoding");
 });
});

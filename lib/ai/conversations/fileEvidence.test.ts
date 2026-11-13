import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
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
 it("never trusts cached formula prices and labels truncated long worksheets",()=>{
  const wb=XLSX.utils.book_new();
  const rows=Array.from({length:120},(_,i)=>["Item "+i,i]);
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws.C2={t:"n",f:"1+1",v:9999};
  ws["!ref"]="A1:C120";
  XLSX.utils.book_append_sheet(wb,ws,"Long");
  const buf=XLSX.write(wb,{type:"buffer",bookType:"xlsx"}) as Uint8Array;
  const value=fileEvidence("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buf,"long.xlsx");
  expect(value.truncated).toBe(true);
  expect(value.text).toContain("C2=[formula; cached value withheld]");
  expect(value.text).not.toContain("9999");
 });
 it("rejects malicious, empty and invalid workbook input",()=>{
  expect(()=>assertSafeWorkbook(bytes("PK garbage"))).toThrow("invalid_xlsx");
  expect(()=>fileEvidence("text/plain",bytes("<script>not allowed</script>"),"hostile.txt")).not.toThrow();
  expect(()=>fileEvidence("text/csv",bytes("\u0000"),"bad.csv")).toThrow("unsupported_text_encoding");
 });
});

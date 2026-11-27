import {describe,it,expect,vi} from "vitest";
import {executablePdfSpec,pdfRenderProps,renderSavedAnswerPdf,savedAnswerPdfSpec} from "./pdfReport.server";
import type {RichPresentation} from "./presentation";
vi.mock("server-only",()=>({}));
const pdfSpec={root:"doc",elements:{doc:{type:"Document",props:{title:"Income statement"},children:["page"]},page:{type:"Page",props:{size:"LETTER"},children:["table"]},table:{type:"Table",props:{columns:[{header:"Account"},{header:"Amount"}],rows:[["Sales",1234],["Refund",-25],["Unknown",null]]},children:[]}}};
const block:RichPresentation={type:"rich_presentation",version:1,layout:"stack",panels:[],suggestions:[],report:true,pdfSpec};
const message={blocks:[{type:"text",text:"Income statement — prepared from the saved answer."},block],grounding:null,createdAt:"2026-11-26T10:00:00Z"};
describe("official PDF renderer",()=>{
 it("normalizes all financial table cells and retains exact column placement",()=>{
  expect(pdfRenderProps("Table",{columns:[{header:"Account"},{header:"Amount"}],rows:[{Amount:25,Account:"Sales"},["Refund",-12.5],["Zero",0],["Unknown",null]]})).toMatchObject({rows:[["Sales","25"],["Refund","-12.5"],["Zero","0"],["Unknown","Not recorded"]]});
 });
 it("never passes remote/local images or unsafe links to the renderer",()=>{
  for(const src of ["https://example.com/private","/etc/passwd","file:///etc/passwd"])expect(()=>pdfRenderProps("Image",{src})).toThrow();
  expect(()=>pdfRenderProps("Link",{text:"Unsafe",href:"javascript:alert(1)"})).toThrow();
 });
 it("renders an actual native PDF and falls back to a PDF for an invalid graph",async()=>{
  expect(executablePdfSpec(pdfSpec)).toBeDefined();
  for(const value of [block,{...block,pdfSpec:{...pdfSpec,root:"missing"}}]){
   const bytes=await renderSavedAnswerPdf(message,value);
   expect(Buffer.from(bytes).subarray(0,5).toString()).toBe("%PDF-");expect(bytes.length).toBeGreaterThan(1000);
  }
 },30000);
 it("keeps state-bound financial values and repeated PDF layout available to the official renderer",async()=>{
  const spec={...pdfSpec,state:{rows:[["State-bound sales",321]]},elements:{...pdfSpec.elements,table:{...pdfSpec.elements.table,props:{columns:[{header:"Account"},{header:"Amount"}],rows:{$state:"/rows"}}}}};
  expect(executablePdfSpec(spec)?.state).toEqual(spec.state);
  expect(Buffer.from(await renderSavedAnswerPdf(message,{...block,pdfSpec:spec})).subarray(0,5).toString()).toBe("%PDF-");
 });
 it("includes authored data and prose in the fallback without calling a model",()=>{
  const spec=savedAnswerPdfSpec(message,[block]);
  const values=JSON.stringify(spec);
  expect(values).toContain("1234");expect(values).toContain("prepared from the saved answer");
 });
});

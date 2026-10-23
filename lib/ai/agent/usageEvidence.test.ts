import {describe,it,expect} from "vitest";
import {compactEvidence,checkNumbers} from "./checkNumbers";
import {usageEvidenceRefresh} from "./usageEvidence";
import {projectUsageTool} from "@/lib/calc/usageToolProjection";
import type {UsageRow} from "@/lib/calc/usageVariance";

const row:UsageRow={ingredientId:"milk",name:"Milk",unit:"ml",expected:346,
 actual:320,differencePct:-7.51,status:"watch",missing:[],
 groups:[{key:"2026-10-20",label:"2026-10-20",staff:[],expected:346,actual:null,expectedOnly:true}]};
const read=(r:UsageRow,from="2026-10-20",to="2026-10-21")=>
 projectUsageTool({from,to,rows:[r],missing:r.missing,groupBy:"day"});

describe("cross-turn usage numeric evidence",()=>{
 it("revokes previously verified grouped use on an incomplete refresh, including persisted refresh evidence",()=>{
  const prior=compactEvidence([read(row)]);
  const claim="Expected 346 ml that day";
  expect(checkNumbers(claim,"",[], "en",prior)).toEqual([]);
  const unknown=read({...row,expected:null,actual:null,differencePct:null,status:null,
   groups:[],missing:["toastSalesCoverage"]});
  const refreshed=usageEvidenceRefresh([unknown],prior);
  expect(refreshed[0].items).toEqual(expect.arrayContaining([
   {id:"milk:group:0",quantity:null},
  ]));
  expect(checkNumbers(claim,"",refreshed,"en",prior)).toHaveLength(1);
  const persisted=[...prior,...compactEvidence(refreshed)];
  expect(checkNumbers(claim,"",[],"en",persisted)).toHaveLength(1);
 });
 it("revokes a complete group from a preceding tool read in the same turn",()=>{
  const complete=read(row);
  const unknown=read({...row,expected:null,groups:[],differencePct:null,status:null});
  const refreshed=usageEvidenceRefresh([complete,unknown]);
  expect((refreshed[1].items as Array<{id:string;quantity:number|null}>)).toContainEqual({id:"milk:group:0",quantity:null});
  expect(checkNumbers("Expected 346 ml that day","",refreshed,"en")).toHaveLength(1);
 });
 it("does not revoke evidence from a different ingredient or period",()=>{
  const earlier=compactEvidence([read({...row,ingredientId:"oat",name:"Oat"})]);
  const anotherDate=compactEvidence([read(row,"2026-10-10","2026-10-11")]);
  const unknown=read({...row,expected:null,groups:[],differencePct:null,status:null});
  const result=usageEvidenceRefresh([unknown],[...earlier,...anotherDate]);
  expect((result[0].items as unknown[]).some(item=>
   !!item&&typeof item==="object"&&"id" in item&&item.id==="milk:group:0")).toBe(false);
 });
});

import {describe,it,expect} from "vitest";
import {compactEvidence,checkNumbers} from "./checkNumbers";
import {usageEvidenceRefresh} from "./usageEvidence";
import {projectUsageTool,usageGroupEvidenceId} from "@/lib/calc/usageToolProjection";
import type {UsageRow} from "@/lib/calc/usageVariance";

const row:UsageRow={ingredientId:"milk",name:"Milk",unit:"ml",expected:346,
 actual:320,differencePct:-7.51,status:"watch",missing:[],
 groups:[{key:"2026-10-20",label:"2026-10-20",staff:[],expected:346,actual:null,expectedOnly:true}]};
const read=(r:UsageRow,from="2026-10-20",to="2026-10-21")=>
 projectUsageTool({from,to,rows:[r],missing:r.missing,groupBy:"day"});
const groupId=usageGroupEvidenceId("milk","day","2026-10-20");
const claim="Expected 346 ml that day";

describe("cross-turn usage numeric evidence lifecycle",()=>{
 it("revokes old grouped figures on an incomplete refresh, including persisted evidence",()=>{
  const prior=compactEvidence([read(row)]);
  expect(checkNumbers(claim,"",[], "en",prior)).toEqual([]);
  const unknown=read({...row,expected:null,actual:null,differencePct:null,status:null,
   groups:[],missing:["toastSalesCoverage"]});
  const refreshed=usageEvidenceRefresh([unknown],prior);
  expect(refreshed[0].items).toEqual(expect.arrayContaining([{id:groupId,quantity:null}]));
  expect(checkNumbers(claim,"",refreshed,"en",prior)).toHaveLength(1);
  expect(checkNumbers(claim,"",[],"en",[...prior,...compactEvidence(refreshed)])).toHaveLength(1);
 });
 it("revokes removed groups even when the new expected total is known zero",()=>{
  const prior=compactEvidence([read(row)]);
  const zero=read({...row,expected:0,groups:[],actual:0,differencePct:null,status:null});
  const refreshed=usageEvidenceRefresh([zero],prior);
  expect(refreshed[0].items).toEqual(expect.arrayContaining([{id:groupId,quantity:null}]));
  expect(checkNumbers(claim,"",refreshed,"en",prior)).toHaveLength(1);
  expect(checkNumbers(claim,"",[], "en",[...prior,...compactEvidence(refreshed)])).toHaveLength(1);
 });
 it("replaces removed groups but retains unchanged ones from a complete read",()=>{
  const second={key:"2026-10-21",label:"2026-10-21",staff:[],expected:155,actual:null as null,expectedOnly:true as const};
  const previous=read({...row,expected:501,groups:[row.groups[0],second]});
  const prior=compactEvidence([previous]);
  const changed=usageEvidenceRefresh([read(row)],prior);
  const removedId=usageGroupEvidenceId("milk","day",second.key);
  expect(changed[0].items).toEqual(expect.arrayContaining([{id:removedId,quantity:null}]));
  expect((changed[0].items as Array<{id:string;quantity:number|null}>))
   .find(x=>x.id===groupId)?.quantity).toBe(346);
  expect(checkNumbers("155 ml", "",changed,"en",prior)).toHaveLength(1);
  expect(checkNumbers(claim,"",changed,"en",prior)).toEqual([]);
 });
 it("does not invalidate omitted groups when a projection is truncated",()=>{
  const many=Array.from({length:55},(_,index)=>({
   key:"2026-10-"+String(index+1).padStart(2,"0"),
   label:"Day "+index,staff:[],expected:index+700,actual:null as null,expectedOnly:true as const
  }));
  const previous=read({...row,expected:40000,groups:many});
  const prior=compactEvidence([read(row)]);
  const updated=usageEvidenceRefresh([previous],prior);
  expect(previous.rows[0].groupsComplete).toBe(false);
  expect(previous.truncated).toBe(true);
  expect((updated[0].items as Array<{id:string;quantity:number|null}>)
   .some(item=>item.id===groupId&&item.quantity===null)).toBe(false);
 });
 it("revokes group evidence from an earlier read in the same turn",()=>{
  const complete=read(row);
  const zero=read({...row,expected:0,groups:[],differencePct:null,status:null});
  const refreshed=usageEvidenceRefresh([complete,zero]);
  expect((refreshed[1].items as Array<{id:string;quantity:number|null}>))
   .toContainEqual({id:groupId,quantity:null});
  expect(checkNumbers(claim,"",refreshed,"en")).toHaveLength(1);
 });
 it("does not reauthorize evidence cleared by a preceding same-turn invalidation",()=>{
  const unknown=read({...row,expected:null,groups:[],differencePct:null,status:null});
  const final=read({...row,expected:0,groups:[],differencePct:null,status:null});
  const refreshed=usageEvidenceRefresh([read(row),unknown,final]);
  expect(checkNumbers(claim,"",refreshed,"en")).toHaveLength(1);
 });
 it("preserves groups in a different ingredient or reporting period",()=>{
  const earlier=compactEvidence([read({...row,ingredientId:"oat",name:"Oat"})]);
  const anotherDate=compactEvidence([read(row,"2026-10-10","2026-10-11")]);
  const current=read({...row,expected:0,groups:[],differencePct:null,status:null});
  const result=usageEvidenceRefresh([current],[...earlier,...anotherDate]);
  expect((result[0].items as Array<{id:string;quantity:number|null}>)
   .some(item=>item.id===groupId&&item.quantity===null)).toBe(false);
 });
});

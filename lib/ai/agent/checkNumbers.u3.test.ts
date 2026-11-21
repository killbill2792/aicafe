import {describe,expect,it} from "vitest";
import {compactEvidence,checkNumbers} from "./checkNumbers";
import type {AgentToolResult} from "./tools";

const receipt=()=>({
 source:"u3_canonical_research",period:null,missing:[],truncated:false,
 rows:[{amount_cents:"12345",orders:"7",percent:"12.34"}],
 evidence:{
  scope:"verified_owner_cafe_lease",
  receipt_id:"11111111-1111-4111-8111-111111111111",
  query_fingerprint:"a".repeat(64),catalog_version:"b".repeat(16),
  column_units:{amount_cents:"cents",orders:"count",percent:"percent"}
 }
}) as AgentToolResult;
describe("U3 SQL source receipts in numeric claim verification",()=>{
 it("accepts exact PostgreSQL NUMERIC strings without model calculator detours",()=>{
  const rows=compactEvidence([receipt()]);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.values).toEqual(expect.arrayContaining([
   expect.objectContaining({unit:"cents",value:12345}),
   expect.objectContaining({unit:"count",value:7}),
   expect.objectContaining({unit:"bps",value:1234})
  ]));
  expect(checkNumbers("$123.45, 7 orders and 12.34%.","",[receipt()],"en")).toEqual([]);
  expect(checkNumbers("$123.46 and 8 orders.","",[receipt()],"en")).not.toEqual([]);
 });
 it("does not promote missing scope, untyped aliases or partial responses",()=>{
  const original=receipt() as Record<string,unknown>;
  const proof=original.evidence as Record<string,unknown>;
  for(const altered of [
   {...original,evidence:{...proof,column_units:{}}},
   {...original,evidence:{...proof,scope:"unverified"}},
   {...original,evidence:{...proof,receipt_id:"forged"}},
   {...original,truncated:true},
   {...original,missing:["source_read_failed"]},
   {...original,error:"source_read_failed"},
  ]){
   expect(compactEvidence([altered as AgentToolResult]).flatMap(v=>v.values)).toEqual([]);
  }
 });
 it("rejects fractional cents, unsafe huge integers and high-precision coercions",()=>{
  const original=receipt() as Record<string,unknown>;
  const bad={...original,rows:[{
   amount_cents:"12345.5",orders:"9007199254740993",percent:"12.3456789"
  }]};
  expect(compactEvidence([bad as unknown as AgentToolResult]).flatMap(v=>v.values)).toEqual([]);
 });
});

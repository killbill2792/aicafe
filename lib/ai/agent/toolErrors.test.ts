import {describe,it,expect} from "vitest";
import {ToolError,safeToolError,toolErrorCodes,toolErrorResult} from "./toolErrors";
describe("safe tool failures",()=>{
 it.each(["en","es","ar"] as const)("names a failed labor read and its dates in %s",locale=>{
  const failed=safeToolError(new Error("private database token"),false,
    {source:"get_labor",locale,period:"2026-10-01 – 2026-10-07"});
  expect(failed.what.length).toBeGreaterThan(3);
  expect(failed.period).toBe("2026-10-01 – 2026-10-07");
  expect(failed.reason).toContain(failed.what);
  expect(failed.reason).toContain("2026-10-01");
  expect(failed.reason).not.toContain("private database token");
  expect(failed.reason).not.toContain("Something went wrong");
 });
 it.each(toolErrorCodes)("preserves known code %s",code=>{
  const detail=safeToolError(new ToolError(code));
  expect(detail.code).toBe(code);expect(detail.reason.length).toBeGreaterThan(10);
  expect(toolErrorResult("price",new ToolError(code)).missing).toEqual([code]);
 });
 it("masks unknown exception details",()=>{const detail=safeToolError(new Error("secret token"));expect(detail).toMatchObject({code:"internal"});expect(JSON.stringify(detail)).not.toContain("secret token");});
 it("uses deadline instead of unsafe unknown error",()=>expect(safeToolError(new Error("secret"),true).code).toBe("deadline_exceeded"));

 it("names a failing read in Spanish and Arabic without raw errors",()=>{
  const es=safeToolError(new Error("private SQL"),false,{source:"get_labor",locale:"es",period:"2026-10-01 – 2026-10-07"});
  const ar=safeToolError(new Error("private SQL"),false,{source:"get_schedule",locale:"ar",period:"2026-10-01"});
  expect(es.reason).toContain("2026-10-01");
  expect(es.reason).toContain("nómina");
  expect(ar.reason).toContain("ورديات");
  expect(es.reason).not.toContain("private SQL");
 });
});

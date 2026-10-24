import {describe,it,expect} from "vitest";
import {ToolError,safeToolError,toolErrorCodes,toolErrorResult} from "./toolErrors";
describe("safe tool failures",()=>{
 it.each(toolErrorCodes)("preserves known code %s",code=>{
  const detail=safeToolError(new ToolError(code));
  expect(detail.code).toBe(code);expect(detail.reason.length).toBeGreaterThan(10);
  expect(toolErrorResult("price",new ToolError(code)).missing).toEqual([code]);
 });
 it("masks unknown exception details",()=>{const detail=safeToolError(new Error("secret token"));expect(detail).toMatchObject({code:"internal"});expect(JSON.stringify(detail)).not.toContain("secret token");});
 it("uses deadline instead of unsafe unknown error",()=>expect(safeToolError(new Error("secret"),true).code).toBe("deadline_exceeded"));
});

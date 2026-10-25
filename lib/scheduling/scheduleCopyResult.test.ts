import {describe,it,expect,vi} from "vitest";
import {safeScheduleCopyResponse} from "./scheduleCopyResult";

describe("schedule message preparation",()=>{
 it("returns copy-ready text without claiming delivery or mutating the schedule",async()=>{
  const send=vi.fn(async()=>({ok:true as const,data:{messages:[{text:"Monday 07:00–15:00"},{text:"Tuesday 09:00–17:00"}]}}));
  expect(await safeScheduleCopyResponse(send)).toEqual({ok:true,copy:"Monday 07:00–15:00\nTuesday 09:00–17:00"});
  expect(send).toHaveBeenCalledTimes(1);
 });
 it("reports rejected server actions instead of leaving a silent dead end",async()=>{
  expect(await safeScheduleCopyResponse(async()=>{throw Error("timeout");})).toEqual({ok:false});
 });
 it("reports protected failures and empty messages rather than opening an empty copy modal",async()=>{
  expect(await safeScheduleCopyResponse(async()=>({ok:false as const,error:"unauthorized"}))).toEqual({ok:false});
  expect(await safeScheduleCopyResponse(async()=>({ok:true as const,data:{messages:[]}}))).toEqual({ok:false});
  expect(await safeScheduleCopyResponse(async()=>({ok:true as const,data:{messages:[{text:"  "}]}}))).toEqual({ok:false});
 });
});

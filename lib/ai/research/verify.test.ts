import {describe,expect,it} from "vitest";
import {unsupportedNumbers} from "./verify";

describe("research answer numbers",()=>{
  const evidence=[JSON.stringify({ok:true,rows:[{revenue_cents:1234567,orders:412,margin:0.125,payload:{wages:"2500.00"}}]})];
  it("accepts numbers that appear in retrieved data, in cents, dollars and percent forms",()=>{
    expect(unsupportedNumbers("Revenue was $12,345.67 from 412 orders at a 12.5% margin; wages 2,500.",evidence)).toEqual([]);
  });
  it("flags a figure that is not in the evidence",()=>{
    const flagged=unsupportedNumbers("Revenue was $12,999.00 from 412 orders.",evidence);
    expect(flagged.map(f=>f.text)).toEqual(["12,999.00"]);
    expect(flagged[0].start).toBeGreaterThan(0);
  });
  it("ignores small counts, years, times and dates",()=>{
    expect(unsupportedNumbers("In 2026, on 2026-11-25 at 13:30, 3 people worked 8 hours.",[])).toEqual([]);
  });
  it("uses numbers the owner wrote and calculator results",()=>{
    expect(unsupportedNumbers("That is 187.5 per day.",["I pay 6000 a month",JSON.stringify({ok:true,result:{value:"187.5",unit:"cents"}})])).toEqual([]);
  });
});

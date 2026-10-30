import {describe,expect,it} from "vitest";
import {safeEventReport} from "./EventReportCard";

describe("Past event report cards",()=>{
  it("keeps certified zero sales distinct from missing values",()=>{
    const report=safeEventReport({
      reportText:"The morning report is based on certified sales.",
      observedDays:1,expectedDays:2,checklist:{total:3,done:1},
      days:[{date:"2026-10-31",actualCents:0,typicalCents:null,
        hours:[{hourLocal:13,actualCents:0,usualCents:null},
          {hourLocal:14,actualCents:1550,usualCents:1200}]}],
    });
    expect(report).toEqual({
      text:"The morning report is based on certified sales.",
      observedDays:1,expectedDays:2,done:1,total:3,
      days:[{date:"2026-10-31",actualCents:0,typicalCents:null,
        hours:[{hourLocal:13,actualCents:0,usualCents:null},
          {hourLocal:14,actualCents:1550,usualCents:1200}]}],
    });
  });
  it("does not turn absent, malformed or partial evidence into zero",()=>{
    expect(safeEventReport(null)).toBeNull();
    const report=safeEventReport({
      reportText:"",checklist:{},days:[
        {date:"unknown",actualCents:500},
        {date:"2026-10-30",actualCents:"500",hours:[
          {hourLocal:25,actualCents:70,usualCents:60},
          {hourLocal:15,actualCents:"70",usualCents:60}]}],
    });
    expect(report).toEqual({text:null,observedDays:null,expectedDays:null,
      done:null,total:null,
      days:[{date:"2026-10-30",actualCents:null,typicalCents:null,hours:[]}]});
  });
});

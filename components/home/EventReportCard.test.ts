import {describe,expect,it} from "vitest";
import {safeEventReport,EventReportCard} from "./EventReportCard";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";

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
  it("retains precise unverified number spans without changing report text",()=>{
    const report=safeEventReport({
      reportText:"Sales reached 999, but that figure is unverified.",
      reportProvenance:[{start:14,end:17,source:"unchecked"},
        {start:-1,end:4,source:"unchecked"}],
      observedDays:1,expectedDays:1,checklist:{total:1,done:0},days:[],
    });
    expect(report?.text).toBe("Sales reached 999, but that figure is unverified.");
    expect(report?.provenance).toEqual([{start:14,end:17,source:"unchecked"}]);
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
  it.each([["USD","$50.00","$5.00"],["EUR","€50.00","€5.00"],
    [null,"50.00","5.00"]] as const)(
    "renders daily and hourly major-unit values for %s in the same currency as narration",
    (currency,dayMoney,hourMoney)=>{
      const html=renderToStaticMarkup(createElement(EventReportCard,{
        report:{reportText:"Verified sales.",days:[{date:"2026-11-02",
          actualCents:5000,typicalCents:4000,
          hours:[{hourLocal:7,actualCents:500,usualCents:400}]}],
          observedDays:1,expectedDays:1,checklist:{done:1,total:1}},
        status:"complete",currency,locale:"en",
        t:(key:string)=>key,onChat:()=>{},
      }));
      expect(html).toContain(dayMoney);
      expect(html).toContain(hourMoney);
      expect(html).not.toContain("5000 ¢");
      expect(html).not.toContain("500 ¢");
      if(currency===null)expect(html).toContain("reportCurrencyMissing");
      else expect(html).not.toContain("reportCurrencyMissing");
    });
  it("underlines a verified formatted report amount without inserting a marker",()=>{
    const text="Sales: $1,358.44 vs $1,206.05.";
    const first=text.indexOf("$1,358.44");
    const html=renderToStaticMarkup(createElement(EventReportCard,{
      report:{reportText:text,reportProvenance:[{
        start:first,end:first+"$1,358.44".length,source:"owner"}],
        days:[],observedDays:1,expectedDays:1,checklist:{done:1,total:1}},
      status:"complete",currency:"USD",locale:"en",
      t:(key:string)=>key,onChat:()=>{},
    }));
    expect(html).toContain("decoration-dotted");
    expect(html).toContain("decoration-chart-staff");
    expect(html).toContain(">$1,358.44</button>");
    expect(html).not.toContain("$1,358.44°");
    expect(html).not.toContain("h-[6px] w-[6px] align-super");
  });

});

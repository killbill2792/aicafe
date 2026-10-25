import {describe,it,expect} from "vitest";
import {resolvePeriod,calendarMonth,dailyRate,prorate,coveredWindow,requestedPeriod} from "./periods";
const base={asOf:"2026-10-24",timezone:"America/Los_Angeles"};
describe("business-local period resolution",()=>{
 it("preserves the existing trailing seven-day week for financial totals",()=>{
  expect(resolvePeriod("week",{asOf:"2026-10-24",timezone:"America/Los_Angeles"})).toEqual({
   status:"resolved",value:{from:"2026-10-18",to:"2026-10-24",label:"Last 7 days"}});
 });
 it("resolves last month without guessing a current month",()=>{
  expect(resolvePeriod({preset:"last_month"},base)).toEqual({status:"resolved",
   value:{from:"2026-09-01",to:"2026-09-30",label:"Last month"}});
 });
 it("uses explicit owner dates and rejects future ranges",()=>{
  expect(resolvePeriod({from:"2026-03-01",to:"2026-03-31"},base)).toEqual({
   status:"resolved",value:{from:"2026-03-01",to:"2026-03-31",label:"2026-03-01 – 2026-03-31"}});
  expect(resolvePeriod({from:"2026-11-01",to:"2026-11-30"},base)).toMatchObject({
   status:"none",missing:["futurePeriod"]});
 });
 it("requires a choice when two March months are covered",()=>{
  const r=resolvePeriod("March",{...base,coverage:{from:"2025-01-01",to:"2026-10-24"}});
  expect(r.status).toBe("ambiguous");
  if(r.status==="ambiguous")expect(r.candidates.map(c=>c.from)).toEqual(["2025-03-01","2026-03-01"]);
 });
 it("uses the cafe timezone at the UTC day boundary",()=>{
  expect(resolvePeriod("today",{asOf:"2026-10-24T01:00:00Z",timezone:"America/Los_Angeles"}))
   .toEqual({status:"resolved",value:{from:"2026-10-23",to:"2026-10-23",label:"Today"}});
 });
});

describe("calendar-bound money",()=>{
 it("accounts for February leap days",()=>{const feb=calendarMonth("2024-02-14");expect(feb).toEqual({from:"2024-02-01",to:"2024-02-29"});expect(prorate(2900,feb,{from:"2024-02-01",to:"2024-02-14"})).toBe(1400);});
 it("prorates 31-day months to a 22-day span",()=>expect(prorate(1500000,calendarMonth("2026-10-24"),{from:"2026-10-01",to:"2026-10-22"})).toBe(1064516));
 it("spans month boundaries by calendar days",()=>expect(dailyRate(3100,{from:"2026-01-20",to:"2026-02-19"})).toBe(100));
 it("uses latest real coverage when requested interval is empty",()=>expect(coveredWindow({from:"2026-10-01",to:"2026-10-14"},{from:"2026-08-22",to:"2026-09-04"})).toEqual({period:{from:"2026-08-22",to:"2026-09-04"},fallback:true,label:"Latest data: Aug 22–Sep 4"}));
 it("normalizes weekly periods",()=>expect(requestedPeriod("week","2026-10-24")).toEqual({from:"2026-10-18",to:"2026-10-24"}));
});

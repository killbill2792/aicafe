import {describe,it,expect} from "vitest";
import {calendarMonth,dailyRate,prorate,coveredWindow,requestedPeriod} from "./periods";
describe("calendar-bound money",()=>{
 it("accounts for February leap days",()=>{const feb=calendarMonth("2024-02-14");expect(feb).toEqual({from:"2024-02-01",to:"2024-02-29"});expect(prorate(2900,feb,{from:"2024-02-01",to:"2024-02-14"})).toBe(1400);});
 it("prorates 31-day months to a 22-day span",()=>expect(prorate(1500000,calendarMonth("2026-10-24"),{from:"2026-10-01",to:"2026-10-22"})).toBe(1064516));
 it("spans month boundaries by calendar days",()=>expect(dailyRate(3100,{from:"2026-01-20",to:"2026-02-19"})).toBe(100));
 it("uses latest real coverage when requested interval is empty",()=>expect(coveredWindow({from:"2026-10-01",to:"2026-10-14"},{from:"2026-08-22",to:"2026-09-04"})).toEqual({period:{from:"2026-08-22",to:"2026-09-04"},fallback:true,label:"Latest data: Aug 22–Sep 4"}));
 it("normalizes weekly periods",()=>expect(requestedPeriod("week","2026-10-24")).toEqual({from:"2026-10-18",to:"2026-10-24"}));
});

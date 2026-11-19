import {describe,it,expect} from "vitest";
import type {DailyFacts} from "@/lib/calc";
import {hourlyStaffPressure,type ObservedTimecard} from "./hourlyStaffPressure";
const dates=["2026-10-01","2026-10-08","2026-10-15","2026-10-22"];
const now=new Date("2026-10-30T00:00:00Z");
function fixtures(){
 const days:DailyFacts[]=dates.map((date,i)=>({date,netSalesCents:4000,ordersCount:20,drinksCount:20,ingredientsCents:1000,wagesCents:i===3?1000:3000,staffTaxCents:0,laborWageStatus:"actual",staffTaxStatus:"actual",salesDataStatus:"actual",cardFeesCents:0,voidsCents:0}));
 const hours=dates.map(date=>({date,hourLocal:9,netSalesCents:4000}));
 const cards:ObservedTimecard[]=dates.map((date,i)=>({clockIn:date+"T16:00:00Z",clockOut:date+"T17:00:00Z",hourlyWageCents:i===3?1000:3000,actual:true,breaks:[]}));
 return {days,hours,cards};
}
describe("same-hour staff cost screening",()=>{
 it("applies existing 3-of-4 rule to actual reconciled wages and comparable hours",()=>{
  const f=fixtures();
  expect(hourlyStaffPressure(f.days,f.hours,f.cards,"America/Los_Angeles",now)).toEqual({coveredDays:4,slots:[{subject:"weekday-hour:4:9",highWeeks:3,sampleWeeks:4,active:true}]});
  f.days[2].wagesCents=1000;f.cards[2].hourlyWageCents=1000;
  expect(hourlyStaffPressure(f.days,f.hours,f.cards,"America/Los_Angeles",now).slots[0]).toMatchObject({active:false,highWeeks:2});
 });
 it("requires distinct complete observed weeks; missing wages, planned hours and unreconciled sales do not resolve an incident",()=>{
  const f=fixtures();
  f.cards[0].actual=false;
  expect(hourlyStaffPressure(f.days,f.hours,f.cards,"America/Los_Angeles",now).slots).toEqual([]);
  f.cards[0].actual=true;f.hours[0].netSalesCents=5000;
  expect(hourlyStaffPressure(f.days,f.hours,f.cards,"America/Los_Angeles",now).slots).toEqual([]);
  f.hours[0].netSalesCents=4000;f.days[0].laborWageStatus="estimate";
  expect(hourlyStaffPressure(f.days,f.hours,f.cards,"America/Los_Angeles",now).slots).toEqual([]);
 });
});

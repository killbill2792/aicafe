import {describe,expect,it} from "vitest";
import {parseHourlyWage,parseWeeklyHours,isValidTeamAvailability,teamAvailabilitySummary} from "./teamPersonFields";

describe("Staff person typed fields",()=>{
 it("parses wages as exact integer cents, without a stepper",()=>{
  expect(parseHourlyWage("18.73")).toBe(1873);
  expect(parseHourlyWage("18")).toBe(1800);
  expect(parseHourlyWage("18.7")).toBe(1870);
  expect(parseHourlyWage("١٨٫٧٣")).toBe(1873);
  expect(parseHourlyWage("")).toBeNull();
  for(const invalid of ["abc","-18","0","18.739","Infinity","18."])expect(parseHourlyWage(invalid)).toBeUndefined();
 });
 it("parses fractional weekly hours into minutes and guards impossible limits",()=>{
  expect(parseWeeklyHours("25")).toBe(1500);
  expect(parseWeeklyHours("25.5")).toBe(1530);
  expect(parseWeeklyHours("")).toBeNull();
  expect(parseWeeklyHours("168.5")).toBeUndefined();
  expect(parseWeeklyHours("1.001")).toBeUndefined();
 });
 it("accepts typed times at any minute, including overnight windows",()=>{
  expect(isValidTeamAvailability([{day:1,start:"06:15",end:"12:37"}])).toBe(true);
  expect(isValidTeamAvailability([{day:1,start:"22:15",end:"05:40"}])).toBe(true);
  expect(isValidTeamAvailability([{day:1,start:null,end:null}])).toBe(true);
  expect(isValidTeamAvailability([{day:1,start:"06:15",end:null}])).toBe(false);
  expect(isValidTeamAvailability([{day:1,start:"06:15",end:"06:15"}])).toBe(false);
 });
 it("summarizes grouped days in English, Spanish and Arabic",()=>{
  const weekdays=[1,2,3,4,5].map(day=>({day,start:null,end:null}));
  const words={
   en:{anyTime:"Any time",off:"Off",none:"No days selected",everyDay:"Every day"},
   es:{anyTime:"Cualquier hora",off:"Libre",none:"Sin días seleccionados",everyDay:"Todos los días"},
   ar:{anyTime:"أي وقت",off:"إجازة",none:"لم تُحدد أيام",everyDay:"كل يوم"}
  };
  for(const locale of ["en","es","ar"] as const){
   const label=(day:number)=>new Intl.DateTimeFormat(locale,{weekday:"short",timeZone:"UTC"}).format(new Date(Date.UTC(2026,9,25+day)));
   const range=label(1)+"–"+label(5);
   const formatted=teamAvailabilitySummary(weekdays,locale,words[locale]);
   expect(formatted).toContain(range);
   expect(formatted).toContain(words[locale].off);
   const timed=weekdays.map(day=>({...day,start:"06:15",end:"12:00"}));
   expect(teamAvailabilitySummary(timed,locale,words[locale])).toContain(range);
   expect(teamAvailabilitySummary(timed,locale,words[locale])).toContain("–");
   expect(teamAvailabilitySummary(Array.from({length:7},(_,day)=>({day,start:null,end:null})),locale,words[locale])).toBe(words[locale].anyTime);
  }
 });
});

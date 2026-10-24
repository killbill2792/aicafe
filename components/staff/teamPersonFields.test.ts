import {describe,expect,it} from "vitest";
import {parseHourlyWage,parseWeeklyHours,isValidTeamAvailability,teamAvailabilitySummary,formatTeamClock,weeklyHoursInput,storedTeamAvailability,hasComplexTeamAvailability,staffChangeSucceeded} from "./teamPersonFields";

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
  expect(parseWeeklyHours("٢٥٫٥")).toBe(1530);
  expect(weeklyHoursInput(1530,"ar")).toContain("٢٥");
  for(const locale of ["en","es","ar"])for(const minutes of [1,59,61,1500,10079]){
   expect(parseWeeklyHours(weeklyHoursInput(minutes,locale))).toBe(minutes);
  }
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
 it("localizes entered minute-level time labels without changing their stored value",()=>{
  expect(formatTeamClock("06:15","en")).toBe("6:15");
  expect(formatTeamClock("12:00","en")).toBe("12");
  expect(formatTeamClock("06:15","es")).toBe("6:15");
  expect(formatTeamClock("06:15","ar")).toContain("١٥");
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
 it("round trips exact 24-hour and multi-window days without false any-time labels",()=>{
  const saved=[
   {day_of_week:1,start_local:"00:00:00",end_local:"12:00:00"},
   {day_of_week:1,start_local:"12:00:00",end_local:"00:00:00"},
   {day_of_week:2,start_local:"06:15:00",end_local:"11:00:00"},
   {day_of_week:2,start_local:"14:00:00",end_local:"19:00:00"}
  ];
  const rows=storedTeamAvailability([1,2,3],saved);
  expect(rows).toEqual([{day:1,start:null,end:null},
   {day:2,start:"06:15",end:"11:00"},{day:2,start:"14:00",end:"19:00"},
   {day:3,start:null,end:null}]);
  expect(hasComplexTeamAvailability(rows)).toBe(true);
  expect(hasComplexTeamAvailability(storedTeamAvailability([1],saved))).toBe(false);
  const summary=teamAvailabilitySummary(rows,"en",{anyTime:"Any time",off:"Off",none:"None",everyDay:"Every day"});
  expect(summary).toContain("6:15–11");
  expect(summary).toContain("14–19");
  expect(summary).not.toBe("Any time");
 });
 it("handles both rejected and returned staff write errors",async()=>{
  expect(await staffChangeSucceeded(async()=>({ok:false}))).toBe(false);
  expect(await staffChangeSucceeded(async()=>{throw Error("network");})).toBe(false);
  expect(await staffChangeSucceeded(async()=>({ok:true}))).toBe(true);
 });
});

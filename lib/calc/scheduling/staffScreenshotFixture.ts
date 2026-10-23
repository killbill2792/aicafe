import {shiftCost,aggregateCosts} from "./shiftCost";
import {coverageGaps} from "./coverageGaps";
import {DEFAULT_TEAM_RULES} from "./teamRuleDefaults";
import type {OpenHours} from "@/lib/business/openHours";

const employees=[
 ["Amy","Barista",1850],["Chris","Manager",2400],["Sam","Barista",1950],
 ["Lena","Baker",null],["Jamie","Barista",1800],["Jordan","Cashier",2000]
] as const;
export function createStaffScreenshotFixture(weekStart="2026-10-26"){
 const dates=Array.from({length:7},(_,i)=>new Date(Date.parse(weekStart+"T12:00:00Z")+i*86400000).toISOString().slice(0,10));
 const team=employees.map(([name,role,wageCents],i)=>({
  id:`00000000-0000-4000-8000-${String(i+1).padStart(12,"0")}`,
  name,role,wageCents,minWeeklyMinutes:null,maxWeeklyMinutes:null,
  availableDays:[0,1,2,3,4,5,6],colorIndex:i,phone:null
 }));
 const hours:OpenHours={
  mon:[["07:00","16:00"]],tue:[["07:00","16:00"]],wed:[["07:00","16:00"]],
  thu:[["07:00","16:00"]],fri:[["07:00","16:00"]],sat:[["07:00","16:00"]],
  sun:[["07:00","15:00"]]
 };
 const shifts=dates.flatMap((date,i)=>{
  const people=i===2?[team[0],team[1]]:i===6?[team[2],team[5]]:[team[i%6],team[(i+1)%6]];
  return people.map((p,k)=>{
   const start=k?"07:00":"07:00",end=k?(i===2?"14:30":i===6?"13:30":"16:00"):(i===6?"15:00":"16:00");
   const line=shiftCost({employeeId:p.id,date,start,end,breakMinutes:30,
    wageCents:p.wageCents,role:p.role},p.role==="Barista"?1900:null);
   return {...line,id:`00000000-0000-4000-9000-${String(i*2+k+1).padStart(12,"0")}`,
     status:"draft",source:"owner",breakSource:"rule",employeeName:p.name};
  });
 });
 return {dates,weekStart,team,shifts,total:aggregateCosts(shifts),
  gaps:coverageGaps(dates,shifts,hours,2),openHours:hours,
  currency:"USD",rules:{...DEFAULT_TEAM_RULES,owner_set:[],custom:[]},
  availability:[],readOnly:false,timezone:"America/Los_Angeles"};
}

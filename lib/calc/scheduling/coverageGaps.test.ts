import {describe,expect,it} from "vitest";
import {coverageGaps} from "./coverageGaps";
import type {OpenHours} from "@/lib/business/openHours";
const open:OpenHours={sun:[],mon:[["07:00","10:00"]],tue:[],wed:[],thu:[],fri:[],sat:[]};
describe("distinct-person coverage",()=>{
 it("does not mistake overlapping shifts from one person for two employees",()=>{
  const rows=[{employeeId:"amy",date:"2026-10-26",start:"07:00",end:"10:00",overnight:false,
    breakMinutes:0,wageCents:1500},{employeeId:"amy",date:"2026-10-26",
    start:"08:00",end:"09:00",overnight:false,breakMinutes:0,wageCents:1500}];
  expect(coverageGaps(["2026-10-26"],rows,{...open,mon:[["07:00","10:00"]]},2))
    .toEqual([{date:"2026-10-26",start:"07:00",end:"10:00",headcount:1,needed:2}]);
 });
 it("counts two different staff IDs separately",()=>{
  const rows=["amy","bob"].map(employeeId=>({employeeId,date:"2026-10-26",
    start:"07:00",end:"10:00",overnight:false,breakMinutes:0,wageCents:1500}));
  expect(coverageGaps(["2026-10-26"],rows,{...open,mon:[["07:00","10:00"]]},2)).toEqual([]);
 });
 it("counts a prior-day overnight employee in Tuesday opening coverage",()=>{
  const shifts=[{employeeId:"amy",date:"2026-10-26",start:"22:00",end:"02:00",
    overnight:true,breakMinutes:0,wageCents:null}];
  expect(coverageGaps(["2026-10-27"],shifts,{tue:[["00:00","02:00"]]},1)).toEqual([]);
 });
 it("uses a following-day employee for after-midnight coverage of a prior opening",()=>{
  const shifts=[{employeeId:"amy",date:"2026-10-27",start:"00:00",end:"02:00",
    overnight:false,breakMinutes:0,wageCents:null}];
  expect(coverageGaps(["2026-10-26"],shifts,{mon:[["22:00","02:00"]]},1))
   .toEqual([{date:"2026-10-26",start:"22:00",end:"00:00",headcount:0,needed:1}]);
 });
 it("can read an overnight shift originating outside the requested week",()=>{
  const shifts=[{employeeId:"amy",date:"2026-10-25",start:"22:00",end:"02:00",
    overnight:true,breakMinutes:0,wageCents:null}];
  expect(coverageGaps(["2026-10-26"],shifts,{mon:[["00:00","02:00"]]},1)).toEqual([]);
 });
});

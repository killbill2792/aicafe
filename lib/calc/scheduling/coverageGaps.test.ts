import {describe,expect,it} from "vitest";
import {coverageGaps} from "./coverageGaps";
const open={sun:[],mon:[["07:00","10:00"]],tue:[],wed:[],thu:[],fri:[],sat:[]} as const;
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
});

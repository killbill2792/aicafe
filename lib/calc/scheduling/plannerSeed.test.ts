import {describe,it,expect} from "vitest";
import {optimizeOliviaWeek} from "./plannerEngine";
import type {PlannerEmployee,PlannerInput} from "./plannerTypes";
const person=(id:string,days:number[]):PlannerEmployee=>({
 id,displayName:id,active:true,
 recurring:days.map(day=>({day_of_week:day,start_local:"09:00",end_local:"11:00",
  overnight:false,effective_from:"2026-01-01",effective_to:null,confirmation:"owner_confirmed"})),
 exceptions:[],qualifications:[],
 wage:{wage_period:"hour",wage_amount_cents:1600,default_hourly_wage_cents:null},
 provenance:"known_paid",
});
const fixture=(people:PlannerEmployee[],seed:PlannerInput["historicalSeed"]):PlannerInput=>({
 horizonStart:"2026-10-12",locations:[{id:"a",timezone:"America/Los_Angeles"}],
 employees:people,historicalSeed:seed,slotMinutes:60,
 coverage:[{id:"opening",locationId:"a",dayOfWeek:1,start_local:"09:00",
  end_local:"11:00",overnight:false,minHeadcount:1,priority:"required"}]
});
describe("last week's Toast shift seed respects all Olivia constraints",()=>{
 it("prefers a previous Toast worker when both people are available",()=>{
  const result=optimizeOliviaWeek(fixture([person("amy",[1]),person("zoe",[1])],
   [{employeeId:"zoe",weekday:1,startLocal:"09:00",endLocal:"11:00"}]));
  expect(result.status).toBe("feasible");
  expect(result.best?.shifts.map(s=>s.employeeId)).toEqual(["zoe"]);
 });
 it("never copies a prior Toast shift across an owner-approved absence",()=>{
  const unavailable=person("zoe",[1]);
  unavailable.exceptions=[{local_date:"2026-10-12",exception_type:"unavailable",confirmation:"owner_confirmed"}];
  const result=optimizeOliviaWeek(fixture([person("amy",[1]),unavailable],
   [{employeeId:"zoe",weekday:1,startLocal:"09:00",endLocal:"11:00"}]));
  expect(result.status).toBe("feasible");
  expect(result.best?.shifts.map(s=>s.employeeId)).toEqual(["amy"]);
 });
});
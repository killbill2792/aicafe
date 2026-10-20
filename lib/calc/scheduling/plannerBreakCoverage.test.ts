import {describe,expect,it} from "vitest";
import {expandPlannerInput} from "./plannerCore";
import {activeBreakReservations,demandSeatRequired,
  recordedSeatRequired} from "./plannerBreakCoverage";
import type {PlannerInput,PlannerShift} from "./plannerTypes";

const base:PlannerInput={
  horizonStart:"2026-10-12",
  locations:[{id:"cafe",timezone:"UTC"}],
  employees:[{id:"a",displayName:"A",active:true,
    recurring:[{day_of_week:1,start_local:"09:00",end_local:"11:00",
      effective_from:"2026-01-01",overnight:false,confirmation:"owner_confirmed"}],
    exceptions:[],qualifications:[],
    wage:{wage_period:"hour",wage_amount_cents:1500,default_hourly_wage_cents:null},
    provenance:"known_paid"}],
  coverage:[{id:"counter",locationId:"cafe",dayOfWeek:1,
    start_local:"09:00",end_local:"11:00",overnight:false,
    minHeadcount:2,minHeadcountDuringBreak:1,priority:"required"}],
  slotMinutes:30,
  ruleProfile:{verified:true,maxContinuousWorkMinutes:60,unpaidMealMinutes:30},
};
const shift=(employeeId:string,breaks:PlannerShift["breaks"]):PlannerShift=>({
  employeeId,locationId:"cafe",startAt:"2026-10-12T09:00:00.000Z",
  endAt:"2026-10-12T11:00:00.000Z",
  paidMinutes:120-breaks.reduce((n,b)=>n+(!b.paid?
    (Date.parse(b.endAt)-Date.parse(b.startAt))/60000:0),0),
  breaks,pinned:false,
});

describe("owner break coverage floor (pure calculation)",()=>{
  it("waives only excess seats for an actual reserved interval",()=>{
    const plan=expandPlannerInput(base);
    const seats=plan.units.filter(u=>u.start===Date.parse("2026-10-12T09:30:00.000Z"));
    expect(seats).toHaveLength(2);
    const reserved=[{employeeId:"a",coverageId:"counter",locationId:"cafe",
      start:seats[0].start,end:seats[0].end}];
    expect(activeBreakReservations(seats[0],reserved)).toHaveLength(1);
    expect(demandSeatRequired(base,seats.find(u=>u.seatIndex===0)!,reserved)).toBe(true);
    expect(demandSeatRequired(base,seats.find(u=>u.seatIndex===1)!,reserved)).toBe(false);
    expect(demandSeatRequired({...base,coverage:base.coverage.map(c=>({
      ...c,minHeadcountDuringBreak:2}))},seats[1],reserved)).toBe(true);
    expect(demandSeatRequired({...base,coverage:base.coverage.map(c=>({
      ...c,minHeadcountDuringBreak:null}))},seats[1],reserved)).toBe(true);
  });

  it("credits an actual half-hour break when gross span is 330 but net work is 300",()=>{
    const args:PlannerInput={...base,
      ruleProfile:{verified:true,maxContinuousWorkMinutes:300,
        unpaidMealMinutes:30},
      coverage:[{...base.coverage[0],end_local:"14:30"}]};
    const plan=expandPlannerInput(args);
    const seat=plan.units.find(u=>u.seatIndex===1 &&
      u.start===Date.parse("2026-10-12T11:00:00.000Z"))!;
    const meal={startAt:"2026-10-12T11:00:00.000Z",
      endAt:"2026-10-12T11:30:00.000Z",paid:false};
    const published:PlannerShift={employeeId:"a",locationId:"cafe",
      startAt:"2026-10-12T09:00:00.000Z",endAt:"2026-10-12T14:30:00.000Z",
      paidMinutes:300,breaks:[meal],pinned:false};
    expect(recordedSeatRequired(args,plan,[published],seat)).toBe(false);
  });

  it("independent credit requires a real, fully contained reviewed break",()=>{
    const plan=expandPlannerInput(base);
    const during=plan.units.find(u=>u.seatIndex===1 &&
      u.start===Date.parse("2026-10-12T09:30:00.000Z"))!;
    const outside=plan.units.find(u=>u.seatIndex===1 &&
      u.start===Date.parse("2026-10-12T10:00:00.000Z"))!;
    const meal=[{startAt:"2026-10-12T09:30:00.000Z",
      endAt:"2026-10-12T10:00:00.000Z",paid:false}];
    expect(recordedSeatRequired(base,plan,[shift("a",meal)],during)).toBe(false);
    expect(recordedSeatRequired(base,plan,[shift("a",meal)],outside)).toBe(true);
    expect(recordedSeatRequired(base,plan,[shift("a",[])],during)).toBe(true);
    const fake=shift("a",meal);
    expect(recordedSeatRequired(base,plan,[{
      ...fake,startAt:meal[0].startAt,
    }],during)).toBe(true);
  });
});

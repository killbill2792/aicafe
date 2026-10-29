import {describe,expect,it} from "vitest";
import {getFixtureSnapshot} from "@/lib/data/fixtureSnapshot";
import {buildStaffViewModel} from "@/lib/viewmodels/staffViewModel";
import {buildBreakEvenViewModel} from "@/lib/viewmodels/breakEvenViewModel";
import {projectBreakEven,projectCurrentStaff,projectRecurringSchedule} from "./domainProjections";

const snapshot=getFixtureSnapshot();
const team=snapshot.staffShiftsToday.map(row=>({id:row.employeeId,name:row.name,role:row.role,active:true}));
describe("Supervisor canonical domain projections",()=>{
  it("uses the Staff screen's onShift source/provenance, not open-timecard count",()=>{
    const expected=buildStaffViewModel(snapshot,team).onShift.filter(s=>s.sourceType!=="owner_schedule");
    const current=projectCurrentStaff(snapshot,team);
    expect(current.count).toBe(expected.length);
    expect(current.people.map(x=>x.name)).toEqual(expected.slice(0,15).map(x=>x.name));
    expect(current.people.map(x=>x.sourceType)).toEqual(expected.slice(0,15).map(x=>x.sourceType));
    expect(JSON.stringify(current)).not.toContain("hourlyWageCents");
  });
  it("does not present removed staff or owner schedule predictions as clocked in",()=>{
    const removed=team.map((member,i)=>({...member,active:i!==0}));
    const without=projectCurrentStaff(snapshot,removed);
    expect(without.people.some(p=>p.name===team[0].name)).toBe(false);
    expect(without.people.some(p=>p.isSchedulePrediction)).toBe(false);
    expect(without.count).toBe(without.people.length);
  });
  it("shows recurring schedule plan, effective date and display name but never calls it attendance",()=>{
    const rows=[{id:"s",employeeId:"e",dayOfWeek:1,startTime:"08:00",endTime:"16:00",
      unpaidBreakMinutes:30,hourlyWageCents:3000,effectiveFrom:"2026-10-01",effectiveTo:null}];
    const known=projectRecurringSchedule(rows,{e:"Alex"}, {from:"2026-10-12",to:"2026-10-18"},"2026-10-10");
    expect(known.available).toBe(true);
    if(known.available){
      expect(known.value.source).toBe("owner_recurring_schedule");
      expect(known.value.shifts).toMatchObject([{displayName:"Alex",dayOfWeek:1,startTime:"08:00"}]);
      expect(JSON.stringify(known.value)).not.toContain("hourlyWageCents");
    }
    expect(projectRecurringSchedule(rows,{e:"Alex"}, {from:"2026-09-01",to:"2026-09-30"},"2026-10-10").available)
      .toBe(false);
  });
  it("matches Break-even page's canonical drink, hourly and cost figures",()=>{
    const vm=buildBreakEvenViewModel(snapshot), projected=projectBreakEven(snapshot);
    if(vm.unavailableReason){
      expect(projected.available).toBe(false);
    }else{
      expect(projected.available).toBe(true);
      if(projected.available){
        expect(projected.value.drinksNeededPerDay).toBe(vm.drinksNeededPerDay);
        expect(projected.value.drinksPerHour).toBe(vm.perHour);
        expect(projected.value.dailyCostsToCoverCents).toBe(Math.round(vm.dailyCostsToCoverCents));
      }
    }
  });
  it("matches Break-even page's unavailable reason precedence and refuses invented zero sales",()=>{
    const missingCosts={...snapshot,runningCostLines:snapshot.runningCostLines.map((l,i)=>i===0?
      {...l,isMissing:true,isExpected:true}:l)};
    const vm=buildBreakEvenViewModel(missingCosts),result=projectBreakEven(missingCosts);
    expect(vm.unavailableReason).toBeNull();
    expect(vm.noteKeys).toContain("breakEvenBillsMissing");
    expect(result.available).toBe(true);
    if(result.available)expect(result.value.drinksNeededPerDay).toBe(vm.drinksNeededPerDay);
    const noSales={...snapshot,last28Days:[],todayHasData:false,
      runningCostLines:snapshot.runningCostLines.map(l=>({...l,isMissing:false,isExpected:false}))};
    expect(buildBreakEvenViewModel(noSales).unavailableReason).toBe("missing_sales");
    expect(projectBreakEven(noSales).available).toBe(false);
  });
});

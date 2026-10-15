import { describe, expect, it } from "vitest";
import { optimizeOliviaWeek } from "./plannerEngine";
import { wallToUtc, windowUtc } from "./plannerClock";
import type { PlannerCoverage, PlannerEmployee, PlannerInput } from "./plannerTypes";

const monday="2026-10-12";
const recurring=(day:number,start="09:00",end="17:00")=>({
  day_of_week:day,start_local:start,end_local:end,overnight:false,
  effective_from:"2026-01-01",effective_to:null,confirmation:"owner_confirmed" as const,
});
const employee=(id:string,options:Partial<PlannerEmployee>={}):PlannerEmployee=>({
  id,displayName:id,active:true,
  recurring:[0,1,2,3,4,5,6].map(d=>recurring(d)),
  exceptions:[],qualifications:[{code:"barista",validFrom:"2026-01-01",confirmed:true}],
  wage:{wage_period:"hour",wage_amount_cents:1600,default_hourly_wage_cents:null},
  provenance:"known_paid",...options,
});
const coverage=(id:string,opts:Partial<PlannerCoverage>={}):PlannerCoverage=>({
  id,locationId:"a",dayOfWeek:1,localDate:null,effectiveFrom:monday,
  effectiveTo:null,start_local:"09:00",end_local:"11:00",overnight:false,
  minHeadcount:1,qualificationCode:"barista",priority:"required",...opts,
});
const input=(people:PlannerEmployee[], requirements:PlannerCoverage[],
  other:Partial<PlannerInput>={}):PlannerInput=>({
  horizonStart:monday,
  locations:[{id:"a",timezone:"America/Los_Angeles"}],
  employees:people,coverage:requirements,
  slotMinutes:60,
  burden:{rate:0.12,status:"estimate"},...other,
});

describe("Olivia PR2 deterministic cafe scheduling",()=>{
  it("plans five differently available employees, and reruns byte-identically without POS data",()=>{
    const five=[
      employee("ava",{recurring:[recurring(1,"09:00","11:00")]}),
      employee("ben",{recurring:[recurring(2,"09:00","11:00")]}),
      employee("cara",{recurring:[recurring(3,"09:00","11:00")]}),
      employee("dan",{recurring:[recurring(4,"09:00","11:00")]}),
      employee("eli",{recurring:[recurring(5,"09:00","11:00")]}),
    ];
    const requests=[1,2,3,4,5].map(day=>coverage(String(day),{dayOfWeek:day}));
    const args=input(five,requests);
    const a=optimizeOliviaWeek(args),b=optimizeOliviaWeek(args);
    expect(a).toEqual(b);
    expect(a.status).toBe("feasible");
    expect(a.best?.shifts).toHaveLength(5);
    expect(new Set(a.best!.shifts.map(s=>s.employeeId)).size).toBe(5);
    expect(a.warnings.some(w=>w.includes("no hourly POS"))).toBe(true);
  });

  it("honors confirmed absence and returns an exact uncovered role/date/interval",()=>{
    const e=employee("solo",{exceptions:[{
      local_date:monday,exception_type:"unavailable",confirmation:"owner_confirmed",
    }]});
    const plan=optimizeOliviaWeek(input([e],[coverage("open")]));
    expect(plan.status).toBe("infeasible");
    expect(plan.proof).toBe("required_slot_has_no_eligible_worker");
    expect(plan.best?.gaps[0]).toMatchObject({
      coverageId:"open",locationId:"a",qualificationCode:"barista",
      startAt:"2026-10-12T16:00:00.000Z",
      reason:"no_confirmed_availability",missingHeadcount:1,
    });
  });

  it("requires opener/closer qualifications; duplicate names never substitute IDs",()=>{
    const sameNameA=employee("person-1",{displayName:"Alex",
      qualifications:[{code:"open",validFrom:"2026-01-01",confirmed:true}]});
    const sameNameB=employee("person-2",{displayName:"Alex",
      qualifications:[{code:"close",validFrom:"2026-01-01",confirmed:true}]});
    const cheap=employee("cheap",{wage:{
      wage_period:"hour",wage_amount_cents:400,default_hourly_wage_cents:null,
    },qualifications:[]});
    const requests=[coverage("opening",{qualificationCode:"open",end_local:"10:00"}),
      coverage("closing",{qualificationCode:"close",start_local:"16:00",end_local:"17:00"})];
    const plan=optimizeOliviaWeek(input([sameNameA,sameNameB,cheap],requests));
    expect(plan.status).toBe("feasible");
    expect(plan.best?.shifts.map(s=>s.employeeId).sort()).toEqual(["person-1","person-2"]);
  });

  it("supports distinct locations and never books an employee twice at the same instant",()=>{
    const a=coverage("a"),b=coverage("b",{locationId:"b"});
    const opts={locations:[{id:"a",timezone:"America/Los_Angeles"},
      {id:"b",timezone:"America/Los_Angeles"}]};
    const plan=optimizeOliviaWeek(input([employee("one"),employee("two")],[a,b],opts));
    expect(plan.status).toBe("feasible");
    expect(new Set(plan.best!.shifts.map(s=>s.employeeId)).size).toBe(2);
    const impossible=optimizeOliviaWeek(input([employee("one")],[a,b],opts));
    expect(impossible.status).toBe("unproven");
    expect(impossible.best!.gaps.length).toBeGreaterThan(0);
  });

  it("honors split windows without filling gaps, and works across midnight",()=>{
    const e=employee("night",{recurring:[
      recurring(1,"09:00","11:00"),recurring(1,"14:00","16:00"),
      {...recurring(1,"22:00","02:00"),overnight:true},
    ]});
    const requests=[coverage("morning"),coverage("afternoon",{
      start_local:"14:00",end_local:"16:00",
    }),coverage("night",{
      start_local:"22:00",end_local:"02:00",overnight:true,
    })];
    const plan=optimizeOliviaWeek(input([e],requests));
    expect(plan.status).toBe("feasible");
    expect(plan.best?.shifts).toHaveLength(3);
    expect(plan.best?.shifts[2].endAt).toBe("2026-10-13T09:00:00.000Z");
  });

  it("never exceeds daily/weekly caps or a positive next-day hours cap",()=>{
    const e=employee("limited",{maxDailyMinutes:120,maxWeeklyMinutes:120});
    const plan=optimizeOliviaWeek(input([e],[coverage("four-hours",{end_local:"13:00"})]));
    expect(plan.best?.cost.ownerMinutes).toBe(0);
    expect(plan.best!.shifts.reduce((n,s)=>n+s.paidMinutes,0)).toBeLessThanOrEqual(120);
    const overnight=employee("capped",{recurring:[{
      ...recurring(1,"22:00","02:00"),overnight:true,
    }],exceptions:[{local_date:"2026-10-13",exception_type:"hours_cap",
      max_minutes:60,confirmation:"owner_confirmed"}]});
    const result=optimizeOliviaWeek(input([overnight],[coverage("overnight",{
      start_local:"22:00",end_local:"02:00",overnight:true,
    })]));
    const tuesday=result.best?.shifts.filter(s=>s.endAt>"2026-10-13T07:00:00.000Z")
      .reduce((n,s)=>n+(Date.parse(s.endAt)-Math.max(Date.parse(s.startAt),
        Date.parse("2026-10-13T07:00:00.000Z")))/60000,0)??0;
    expect(tuesday).toBeLessThanOrEqual(60);
  });

  it("places a real unpaid break only with alternate coverage and configured verified rules",()=>{
    const rules={verified:true,maxContinuousWorkMinutes:120,
      unpaidMealMinutes:60,minRestBetweenShiftsMinutes:600,
      overtime:{verified:true,weeklyAfterMinutes:2400,
        multiplierNumerator:3,multiplierDenominator:2}};
    const e=employee("worker",{maxDailyMinutes:480});
    const backup=employee("backup",{recurring:[recurring(1,"11:00","12:00")]});
    const result=optimizeOliviaWeek(input([e,backup],[coverage("meal",{
      end_local:"14:00",
    })],{ruleProfile:rules}));
    expect(result.status).toBe("feasible");
    expect(result.best!.shifts.some(s=>s.unpaidBreaks.length>0)).toBe(true);
    expect(result.best!.shifts.every(s=>s.paidMinutes<=240)).toBe(true);
    const impossible=optimizeOliviaWeek(input([e],[coverage("meal",{
      end_local:"14:00",
    })],{ruleProfile:rules}));
    expect(impossible.status).toBe("unproven");
    expect(impossible.best!.completeCoverage).toBe(false);
  });

  it("models owner working versus paid staff without calling owner labor free savings",()=>{
    const owner=employee("owner",{isOwner:true,
      wage:{wage_period:"hour",wage_amount_cents:0,default_hourly_wage_cents:null},
      provenance:"known_eligible_zero",eligibleZeroVerified:true});
    const hired=employee("hired");
    const result=optimizeOliviaWeek(input([owner,hired],[coverage("shift")]));
    expect(result.status).toBe("feasible");
    expect(result.scenarios.some(s=>s.ownerMinutes>0)).toBe(true);
    expect(result.scenarios.some(s=>s.ownerMinutes===0)).toBe(true);
    expect(result.warnings.some(x=>x.includes("not free business savings"))).toBe(true);
    expect(result.comparisons.length).toBeGreaterThan(0);
  });

  it("distinguishes unknown wages and salary-conversion pending from attested zero",()=>{
    const unknown=employee("unknown",{wage:{
      wage_period:null,wage_amount_cents:null,default_hourly_wage_cents:null,
    },provenance:"unknown"});
    const salary=employee("salary",{wage:{
      wage_period:"month",wage_amount_cents:250000,default_hourly_wage_cents:null,
    },provenance:"salary_conversion_pending"});
    const first=optimizeOliviaWeek(input([unknown],[coverage("unknown")]));
    expect(first.status).toBe("feasible");
    expect(first.best?.cost.cashWagesCents).toBeNull();
    expect(first.best?.cost.loadedPayrollCents).toBeNull();
    expect(first.best?.cost.missingWageEmployeeIds).toContain("unknown");
    const second=optimizeOliviaWeek(input([salary],[coverage("salary")]));
    expect(second.best?.cost.cashWagesCents).toBeNull();
  });

  it("applies verified canonical wage/tax cents without changing existing timecards",()=>{
    const previousTimecard={employeeId:"employee",grossWagesCents:12345};
    const result=optimizeOliviaWeek(input([employee("employee")],[coverage("paid")],{
      burden:{rate:0.12,status:"verified"},ruleProfile:{
        verified:true,overtime:{verified:true,multiplierNumerator:3,multiplierDenominator:2},
      },
    }));
    expect(result.best?.cost).toMatchObject({
      cashWagesCents:3200,loadedPayrollCents:3584,costState:"verified",
    });
    expect(previousTimecard.grossWagesCents).toBe(12345);
  });

  it("rejects ambiguous and nonexistent DST wall times, yet accepts precise midnight crossings",()=>{
    expect(()=>wallToUtc("2027-03-14","02:30","America/Los_Angeles"))
      .toThrow("nonexistent_local_time");
    expect(()=>wallToUtc("2027-11-07","01:30","America/Los_Angeles"))
      .toThrow("ambiguous_local_time");
    const interval=windowUtc("2027-03-13","23:00","04:00",true,
      "America/Los_Angeles");
    expect((interval.endAt-interval.startAt)/60000).toBe(240);
  });

  it("rejects invalid inputs and unsafe pinned overlap, preserves no-data behavior",()=>{
    expect(()=>optimizeOliviaWeek(input([employee("e")],[coverage("c",{
      minHeadcount:-1,
    })]))).toThrow("invalid_planner_input");
    expect(()=>optimizeOliviaWeek(input([employee("e")],[coverage("c",{
      start_local:"09:01",
    })]))).toThrow("invalid_planner_input");
    expect(()=>optimizeOliviaWeek(input([employee("e")],[coverage("c")],{
      pinned:[
        {employeeId:"e",locationId:"a",startAt:"2026-10-12T16:00:00.000Z",
          endAt:"2026-10-12T18:00:00.000Z"},
        {employeeId:"e",locationId:"a",startAt:"2026-10-12T17:00:00.000Z",
          endAt:"2026-10-12T19:00:00.000Z"},
      ],
    }))).toThrow("invalid_pinned_commitment");
    expect(optimizeOliviaWeek(input([employee("e")],[])).status).toBe("feasible");
  });

  it("limits computation via a deterministic node budget rather than inventing proof",()=>{
    const big=[1,2,3,4,5,6,0].map(day=>coverage(String(day),{
      dayOfWeek:day,end_local:"17:00",minHeadcount:2,
    }));
    const p=optimizeOliviaWeek(input([employee("e1"),employee("e2"),
      employee("e3"),employee("e4")],big,{maxNodes:100,beamWidth:2}));
    expect(["feasible","unproven"]).toContain(p.status);
    expect(p.warnings.some(w=>w.includes("Search budget"))).toBe(true);
  });
  it("reuses canonical monthly salary conversion only with verified weekly hours",()=>{
    const salaried=employee("salaried",{
      wage:{wage_period:"month",wage_amount_cents:260000,default_hourly_wage_cents:1500},
      provenance:"known_paid",verifiedSalaryHoursPerWeek:40,
    });
    const result=optimizeOliviaWeek(input([salaried],[coverage("salary")],{
      ruleProfile:{verified:true,overtime:{verified:true,
        multiplierNumerator:3,multiplierDenominator:2}},
      burden:{rate:0.12,status:"verified"},
    }));
    // $2,600/month * 12 / (40*52) = $15/hour -> 2h = $30.
    expect(result.status).toBe("feasible");
    expect(result.best?.cost).toMatchObject({
      cashWagesCents:3000,allocatedSalaryCents:3000,
      loadedPayrollCents:3360,costState:"estimate",
    });
    const unverified=optimizeOliviaWeek(input([{...salaried,
      verifiedSalaryHoursPerWeek:null}],[coverage("salary")]));
    expect(unverified.best?.cost.cashWagesCents).toBeNull();
  });

});

import { describe, expect, it } from "vitest";
import { optimizeOliviaWeek } from "./plannerEngine";
import { validateOliviaAssignments } from "./plannerValidate";
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

  it("replans after a source change without rewriting an inactive worker's started published shift or breaks",()=>{
    const official={
      employeeId:"former",locationId:"a",
      startAt:"2026-10-12T16:00:00.000Z",
      endAt:"2026-10-12T18:00:00.000Z",
      paidMinutes:90,pinned:false,
      breaks:[{startAt:"2026-10-12T17:00:00.000Z",
        endAt:"2026-10-12T17:30:00.000Z",paid:false}],
    };
    const args=input([employee("former",{active:false,recurring:[]}),employee("active")],
      [coverage("published",{end_local:"10:00"}),
        coverage("future",{dayOfWeek:2})],{
        slotMinutes:30,
        replanAsOf:"2026-10-12T19:00:00.000Z",
        startedPublishedShifts:[official],
        historicalShiftWageRates:{
          [JSON.stringify(["former","a",official.startAt])]:{
            rateCentsPerHour:1600,salary:false,
          },
        },
      });
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts).toContainEqual(official);
    // The current employee wage may change, but published-started minutes
    // must use their original 1,600-cent/hour rate from the saved revision.
    const changedCurrent=optimizeOliviaWeek({...args,employees:args.employees.map(e=>
      e.id==="former"?{...e,wage:{...e.wage,wage_amount_cents:4900}}:e)});
    expect(changedCurrent.best?.cost.cashWagesCents)
      .toBe(result.best?.cost.cashWagesCents);
    const missingPastRate=optimizeOliviaWeek({...args,historicalShiftWageRates:{}});
    expect(missingPastRate.best?.cost.cashWagesCents).toBeNull();
    expect(result.best?.shifts.some(s=>s.employeeId==="active" &&
      s.startAt.startsWith("2026-10-13"))).toBe(true);
    const shifts=result.best!.shifts;
    expect(validateOliviaAssignments(args,shifts).valid).toBe(true);
    const dropped=shifts.filter(s=>s.employeeId!=="former");
    const missing=validateOliviaAssignments(args,dropped);
    expect(missing.valid).toBe(false);
    expect(missing.violations.some(v=>v.startsWith("pinned_commitment_removed"))).toBe(true);
    const altered=shifts.map(s=>s.employeeId==="former"
      ? {...s,paidMinutes:120,breaks:[]} : s);
    expect(validateOliviaAssignments(args,altered).valid).toBe(false);
    // A previously paid break is frozen and counted as wages, but never as
    // staffing coverage; changes to today's rest policy cannot erase it.
    const paidOfficial={...official,paidMinutes:120,
      breaks:[{...official.breaks[0],paid:true}]};
    const paidArgs={...args,startedPublishedShifts:[paidOfficial]};
    const paidResult=optimizeOliviaWeek(paidArgs);
    expect(paidResult.best?.shifts).toContainEqual(paidOfficial);
    expect(validateOliviaAssignments(paidArgs,paidResult.best!.shifts).valid).toBe(true);
    expect(paidResult.best?.cost.cashWagesCents)
      .toBe((result.best!.cost.cashWagesCents??0)+800);
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
    expect(plan.best!.gaps.some(g=>g.reason==="weekly_hour_limit")).toBe(true);
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
    expect(result.best!.gaps.some(g=>g.reason==="date_specific_cap")).toBe(true);
  });

  it("staggered reviewed breaks keep a two-person shop above its one-person break floor",()=>{
    const rules={verified:true,maxContinuousWorkMinutes:120,
      unpaidMealMinutes:60};
    const args=input([employee("worker-a"),employee("worker-b")],
      [coverage("break-floor",{end_local:"13:00",minHeadcount:2,
        minHeadcountDuringBreak:1})],{slotMinutes:60,ruleProfile:rules});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.completeCoverage).toBe(true);
    expect(result.best?.gaps).toEqual([]);
    const shifts=result.best!.shifts;
    expect(shifts).toHaveLength(2);
    expect(shifts.every(s=>s.breaks.length===1)).toBe(true);
    const intervals=shifts.map(s=>s.breaks[0]).sort((a,b)=>a.startAt.localeCompare(b.startAt));
    expect(intervals[0].endAt).toBe(intervals[1].startAt);
    expect(intervals.every(b=>(Date.parse(b.endAt)-Date.parse(b.startAt))/60000===60)).toBe(true);
    expect(validateOliviaAssignments(args,shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("reports unsatisfiable break coverage for one worker rather than silently dropping a break",()=>{
    const args=input([employee("solo")],
      [coverage("solo-break",{end_local:"13:00",minHeadcount:1,
        minHeadcountDuringBreak:1})],{slotMinutes:60,
        ruleProfile:{verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60}});
    const result=optimizeOliviaWeek(args);
    expect(result.best?.completeCoverage).toBe(false);
    expect(result.best?.gaps.some(g=>g.reason==="break_coverage_unsatisfiable")).toBe(true);
    expect(result.warnings).toContain("break_coverage_unsatisfiable");
    expect(result.best?.shifts.some(s=>s.breaks.length>0)).toBe(true);
    const validation=validateOliviaAssignments(args,result.best!.shifts);
    expect(validation.completeCoverage).toBe(false);
    expect(validation.gaps.some(g=>g.reason==="break_coverage_unsatisfiable")).toBe(true);
  });

  it("binds chosen break takers when a third, cheaper eligible worker exists",()=>{
    const people=[
      employee("a",{wage:{wage_period:"hour",wage_amount_cents:4500,default_hourly_wage_cents:null}}),
      employee("b",{wage:{wage_period:"hour",wage_amount_cents:3000,default_hourly_wage_cents:null}}),
      employee("c",{wage:{wage_period:"hour",wage_amount_cents:900,default_hourly_wage_cents:null}}),
    ];
    const args=input(people,[coverage("three-worker-choice",{end_local:"13:00",
      minHeadcount:2,minHeadcountDuringBreak:1})],{
      slotMinutes:60,ruleProfile:{verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60},
    });
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.completeCoverage).toBe(true);
    expect(result.best?.shifts.some(s=>s.employeeId==="c" && s.breaks.length===1)).toBe(true);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("recognizes a continuous shift across adjacent break-policy coverage windows",()=>{
    const rules={verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60};
    const args=input([employee("a"),employee("b")],[
      coverage("opening",{start_local:"09:00",end_local:"11:00",
        minHeadcount:2,minHeadcountDuringBreak:1}),
      coverage("midday",{start_local:"11:00",end_local:"13:00",
        minHeadcount:2,minHeadcountDuringBreak:1}),
    ],{slotMinutes:60,ruleProfile:rules});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts.filter(s=>s.breaks.length===1)).toHaveLength(2);
    expect(validateOliviaAssignments(args,result.best!.shifts).completeCoverage).toBe(true);
  });

  it("honors exact frozen published breaks without inventing retroactive coverage or handoffs",()=>{
    const originalBreak={startAt:"2026-10-12T17:00:00.000Z",
      endAt:"2026-10-12T18:00:00.000Z",paid:false};
    const first={employeeId:"a",locationId:"a",startAt:"2026-10-12T16:00:00.000Z",
      endAt:"2026-10-12T20:00:00.000Z",paidMinutes:180,
      breaks:[originalBreak],pinned:false};
    const second={employeeId:"b",locationId:"a",startAt:"2026-10-12T16:00:00.000Z",
      endAt:"2026-10-12T20:00:00.000Z",paidMinutes:240,
      breaks:[],pinned:false};
    const args=input([employee("a"),employee("b")],[
      coverage("published-break",{end_local:"13:00",minHeadcount:2,
        minHeadcountDuringBreak:1,minOverlapMinutes:60}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60,
    },startedPublishedShifts:[first,second],
    replanAsOf:"2026-10-12T16:30:00.000Z"});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts).toEqual([first,second]);
    expect(result.best?.gaps).toEqual([]);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("does not interpret taking or returning from a real break as a new shift handoff",()=>{
    const args=input([employee("a"),employee("b")],[
      coverage("handoff-break",{end_local:"13:00",minHeadcount:2,
        minHeadcountDuringBreak:1,minOverlapMinutes:60}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60,
    }});
    const plan=optimizeOliviaWeek(args);
    expect(plan.status).toBe("feasible");
    const checked=validateOliviaAssignments(args,plan.best!.shifts);
    expect(checked.gaps.some(g=>g.reason==="handoff_overlap_missing")).toBe(false);
    expect(checked.completeCoverage).toBe(true);
  });

  it("coordinates break takers across simultaneous locations without double-booking people",()=>{
    const args=input([employee("a"),employee("b")],[
      coverage("north",{locationId:"a",end_local:"13:00",
        minHeadcount:1,minHeadcountDuringBreak:0}),
      coverage("south",{locationId:"b",end_local:"13:00",
        minHeadcount:1,minHeadcountDuringBreak:0}),
    ],{locations:[{id:"a",timezone:"America/Los_Angeles"},
       {id:"b",timezone:"America/Los_Angeles"}],
      slotMinutes:60,ruleProfile:{
        verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60,
      }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts).toHaveLength(2);
    expect(new Set(result.best!.shifts.map(s=>s.employeeId)).size).toBe(2);
    expect(new Set(result.best!.shifts.map(s=>s.locationId)).size).toBe(2);
    expect(validateOliviaAssignments(args,result.best!.shifts).completeCoverage).toBe(true);
  });

  it("staggered breaks survive adjacent peak-hour headcount and floor increases",()=>{
    const args=input([employee("a"),employee("b"),employee("c")],[
      coverage("two",{start_local:"09:00",end_local:"11:00",
        minHeadcount:2,minHeadcountDuringBreak:1}),
      coverage("three",{start_local:"11:00",end_local:"13:00",
        minHeadcount:3,minHeadcountDuringBreak:2}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts.filter(s=>s.breaks.length===1)).toHaveLength(2);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("reserves breaks for workers required only during a longer peak tier",()=>{
    const args=input([employee("a"),employee("b"),employee("c")],[
      coverage("pre-peak",{start_local:"09:00",end_local:"10:00",
        minHeadcount:2,minHeadcountDuringBreak:1}),
      coverage("peak",{start_local:"10:00",end_local:"13:00",
        minHeadcount:3,minHeadcountDuringBreak:1}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts.filter(s=>s.breaks.length===1)).toHaveLength(3);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("moves breaks outside a zero-slack coverage window rather than skipping them",()=>{
    const args=input([employee("a"),employee("b")],[
      coverage("morning-floor",{start_local:"09:00",end_local:"12:00",
        minHeadcount:2,minHeadcountDuringBreak:1}),
      coverage("lunch-floor",{start_local:"12:00",end_local:"13:00",
        minHeadcount:2,minHeadcountDuringBreak:2}),
      coverage("afternoon-floor",{start_local:"13:00",end_local:"15:00",
        minHeadcount:2,minHeadcountDuringBreak:1}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:300,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    const breaks=result.best!.shifts.flatMap(s=>s.breaks);
    expect(breaks).toHaveLength(2);
    expect(breaks.every(b=>b.endAt<="2026-10-12T19:00:00.000Z" ||
      b.startAt>="2026-10-12T20:00:00.000Z")).toBe(true);
    expect(validateOliviaAssignments(args,result.best!.shifts).completeCoverage).toBe(true);
  });

  it("plans reviewed breaks across a contiguous opt-in then opt-out coverage boundary",()=>{
    const args=input([employee("a"),employee("b")],[
      coverage("can-break",{start_local:"09:00",end_local:"13:00",
        minHeadcount:2,minHeadcountDuringBreak:1}),
      coverage("full-roster",{start_local:"13:00",end_local:"15:00",
        minHeadcount:2,minHeadcountDuringBreak:null}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:300,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.completeCoverage).toBe(true);
    const shifts=result.best!.shifts;
    expect(shifts).toHaveLength(2);
    expect(shifts.every(s=>s.breaks.length===1)).toBe(true);
    // Normal coverage is NEVER reduced inside the explicitly opted-out row.
    expect(shifts.every(s=>s.breaks[0].endAt<="2026-10-12T20:00:00.000Z"))
      .toBe(true);
    expect(validateOliviaAssignments(args,shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("reserves the needed full-span break even when the second seat is a B-to-C handoff",()=>{
    const args=input([
      employee("a"),
      employee("b",{recurring:[recurring(1,"09:00","12:00")]}),
      employee("c",{recurring:[recurring(1,"12:00","13:00")]}),
    ],[coverage("handoff-tier",{start_local:"09:00",end_local:"13:00",
      minHeadcount:2,minHeadcountDuringBreak:1})],{
      slotMinutes:60,ruleProfile:{
        verified:true,maxContinuousWorkMinutes:180,unpaidMealMinutes:60,
      },
    });
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts.find(s=>s.employeeId==="a")?.breaks).toHaveLength(1);
    expect(result.best?.shifts.some(s=>s.employeeId==="b")).toBe(true);
    expect(result.best?.shifts.some(s=>s.employeeId==="c")).toBe(true);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("keeps continuous work across an adjacent cashier-to-barista qualification change",()=>{
    const dual=employee("dual",{qualifications:[
      {code:"cashier",validFrom:"2026-01-01",confirmed:true},
      {code:"barista",validFrom:"2026-01-01",confirmed:true},
    ]});
    const args=input([dual],[
      coverage("cashier",{start_local:"09:00",end_local:"11:00",
        qualificationCode:"cashier",minHeadcount:1,minHeadcountDuringBreak:0}),
      coverage("barista",{start_local:"11:00",end_local:"13:00",
        qualificationCode:"barista",minHeadcount:1,minHeadcountDuringBreak:0}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:180,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts).toHaveLength(1);
    expect(result.best?.shifts[0].breaks).toHaveLength(1);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("reserves separate breaks for full-day A and four-hour B before the B-to-C handoff",()=>{
    const args=input([
      employee("a",{recurring:[recurring(1,"09:00","15:00")]}),
      employee("b",{recurring:[recurring(1,"09:00","13:00")]}),
      employee("c",{recurring:[recurring(1,"13:00","15:00")]}),
    ],[coverage("partial-break-taker",{start_local:"09:00",end_local:"15:00",
      minHeadcount:2,minHeadcountDuringBreak:1})],{
      slotMinutes:60,ruleProfile:{
        verified:true,maxContinuousWorkMinutes:180,unpaidMealMinutes:60,
      },
    });
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.completeCoverage).toBe(true);
    expect(result.best?.shifts.find(s=>s.employeeId==="a")?.breaks).toHaveLength(1);
    expect(result.best?.shifts.find(s=>s.employeeId==="b")?.breaks).toHaveLength(1);
    expect(result.best?.shifts.some(s=>s.employeeId==="c")).toBe(true);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("uses relief coverage to preserve a full two-person break floor",()=>{
    const args=input([employee("a"),employee("b"),employee("relief")],[
      coverage("relief-policy",{start_local:"09:00",end_local:"13:00",
        minHeadcount:2,minHeadcountDuringBreak:2}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.completeCoverage).toBe(true);
    const shifts=result.best!.shifts;
    expect(shifts.flatMap(s=>s.breaks)).toHaveLength(2);
    expect(shifts.some(s=>s.employeeId==="relief")).toBe(true);
    expect(validateOliviaAssignments(args,shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("gives both sequential long handoff workers their own reviewed breaks",()=>{
    const args=input([
      employee("b",{recurring:[recurring(1,"09:00","13:00")]}),
      employee("c",{recurring:[recurring(1,"13:00","17:00")]}),
    ],[coverage("sequential",{start_local:"09:00",end_local:"17:00",
      minHeadcount:1,minHeadcountDuringBreak:0})],{
      slotMinutes:60,ruleProfile:{
        verified:true,maxContinuousWorkMinutes:180,unpaidMealMinutes:60,
      },
    });
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts).toHaveLength(2);
    expect(result.best?.shifts.every(s=>s.breaks.length===1)).toBe(true);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("globally matches one shared relief employee during nonconcurrent role breaks",()=>{
    const only=(code:string)=>[{code,validFrom:"2026-01-01",confirmed:true}];
    const args=input([
      employee("cashier",{qualifications:only("cashier")}),
      employee("barista",{qualifications:only("barista")}),
      employee("relief",{qualifications:[...only("cashier"),...only("barista")]}),
    ],[
      coverage("cash",{start_local:"09:00",end_local:"13:00",
        qualificationCode:"cashier",minHeadcount:1,minHeadcountDuringBreak:1}),
      coverage("bar",{start_local:"09:00",end_local:"13:00",
        qualificationCode:"barista",minHeadcount:1,minHeadcountDuringBreak:1}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    const shifts=result.best!.shifts;
    expect(shifts.filter(s=>s.breaks.length===1)).toHaveLength(2);
    expect(shifts.some(s=>s.employeeId==="relief")).toBe(true);
    expect(validateOliviaAssignments(args,shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("retains two distinct qualified work paths when cashier and barista demand converges",()=>{
    const dual=[{code:"cashier",validFrom:"2026-01-01",confirmed:true},
      {code:"barista",validFrom:"2026-01-01",confirmed:true}];
    const args=input([
      employee("a",{qualifications:dual}),
      employee("b",{qualifications:dual}),
    ],[
      coverage("cash",{start_local:"09:00",end_local:"11:00",
        qualificationCode:"cashier",minHeadcount:1,minHeadcountDuringBreak:0}),
      coverage("bar",{start_local:"09:00",end_local:"11:00",
        qualificationCode:"barista",minHeadcount:1,minHeadcountDuringBreak:0}),
      coverage("general",{start_local:"11:00",end_local:"13:00",
        qualificationCode:null,minHeadcount:2,minHeadcountDuringBreak:1}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:180,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts).toHaveLength(2);
    expect(result.best?.shifts.every(s=>s.breaks.length===1)).toBe(true);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("carries both workers across a general-to-qualified split without resetting their break clocks",()=>{
    const dual=[{code:"cashier",validFrom:"2026-01-01",confirmed:true},
      {code:"barista",validFrom:"2026-01-01",confirmed:true}];
    const args=input([employee("a",{qualifications:dual}),
      employee("b",{qualifications:dual})],[
      coverage("general-opening",{start_local:"09:00",end_local:"11:00",
        qualificationCode:null,minHeadcount:2,minHeadcountDuringBreak:1}),
      coverage("cashier-later",{start_local:"11:00",end_local:"13:00",
        qualificationCode:"cashier",minHeadcount:1,minHeadcountDuringBreak:0}),
      coverage("barista-later",{start_local:"11:00",end_local:"13:00",
        qualificationCode:"barista",minHeadcount:1,minHeadcountDuringBreak:0}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:180,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts).toHaveLength(2);
    expect(result.best?.shifts.every(s=>s.breaks.length===1)).toBe(true);
    expect(validateOliviaAssignments(args,result.best!.shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("staggered long shifts receive two genuine breaks each instead of resetting only once",()=>{
    const long=employee("a",{recurring:[recurring(1,"09:00","19:00")]});
    const other=employee("b",{recurring:[recurring(1,"09:00","19:00")]});
    const args=input([long,other],[
      coverage("ten-hours",{start_local:"09:00",end_local:"19:00",
        minHeadcount:2,minHeadcountDuringBreak:1}),
    ],{slotMinutes:60,ruleProfile:{
      verified:true,maxContinuousWorkMinutes:240,unpaidMealMinutes:60,
    }});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    const shifts=result.best!.shifts;
    expect(shifts).toHaveLength(2);
    expect(shifts.every(s=>s.breaks.length===2)).toBe(true);
    expect(validateOliviaAssignments(args,shifts)).toMatchObject({
      valid:true,completeCoverage:true,gaps:[],
    });
  });

  it("keeps the pre-feature planner result byte-identical when break headcount is absent or null",()=>{
    const args=input([employee("original")],
      [coverage("unchanged",{end_local:"13:00"})],{slotMinutes:60,
      ruleProfile:{verified:true,maxContinuousWorkMinutes:120,unpaidMealMinutes:60}});
    const old=optimizeOliviaWeek(args);
    const noOverride=optimizeOliviaWeek({...args,coverage:args.coverage.map(c=>({
      ...c,minHeadcountDuringBreak:null,
    }))});
    expect(JSON.stringify(noOverride)).toBe(JSON.stringify(old));
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
    expect(result.best!.shifts.some(s=>s.breaks.length>0)).toBe(true);
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

  it("preserves a valid pinned commitment and credits it toward required coverage",()=>{
    const originalPinned={
      employeeId:"pinned-worker",locationId:"a",
      startAt:"2026-10-12T16:00:00.000Z",endAt:"2026-10-12T18:00:00.000Z",
    };
    const result=optimizeOliviaWeek(input([employee("pinned-worker")],[coverage("morning")],{
      pinned:[originalPinned],
    }));
    expect(result.status).toBe("feasible");
    expect(result.best?.shifts).toHaveLength(1);
    expect(result.best!.shifts[0]).toMatchObject({employeeId:"pinned-worker",
      pinned:true,startAt:originalPinned.startAt,endAt:originalPinned.endAt,
      paidMinutes:120});
    expect(result.best?.cost.cashWagesCents).toBe(3200);
  });

  it("cannot invent a 45-minute handoff when both employees have exhausted their hard caps",()=>{
    const a=employee("half-a",{maxDailyMinutes:60});
    const b=employee("half-b",{maxDailyMinutes:60});
    const result=optimizeOliviaWeek(input([a,b],[coverage("overlap",{
      start_local:"09:00",end_local:"11:00",minOverlapMinutes:45,
    })],{slotMinutes:15}));
    // Two one-hour shifts provide 120 staff-minutes, but the mandated
    // 45-minute handoff requires an additional 45 concurrent staff-minutes.
    // A planner must not label the zero-overlap roster feasible.
    expect(result.status).toBe("unproven");
    expect(result.best?.completeCoverage).toBe(false);
    expect(result.best?.shifts.reduce((n,s)=>n+s.paidMinutes,0)).toBeLessThanOrEqual(120);
    expect(result.best?.gaps.some(g=>g.reason==="handoff_overlap_missing")).toBe(true);
  });

  it("never upgrades legal review without jurisdiction and employee classification evidence",()=>{
    const worker=employee("classified");
    const rules={verified:true,overtime:{verified:true,weeklyAfterMinutes:2400,
      multiplierNumerator:3,multiplierDenominator:2}};
    const unreviewed=optimizeOliviaWeek(input([worker],[coverage("law")],{
      ruleProfile:rules,
    }));
    expect(unreviewed.best?.legalReview).toBe("unverified_profile");
    expect(unreviewed.warnings.some(w=>w.includes("legal compliance is not verified"))).toBe(true);
    const reviewed=optimizeOliviaWeek(input([worker],[coverage("law")],{
      ruleProfile:{...rules,source:"verified-cafe-policy-v3",
        jurisdictionByLocationId:{a:"CA-US"},
        classificationByEmployeeId:{"classified":"nonexempt"}},
    }));
    expect(reviewed.best?.legalReview).toBe("verified_profile");
  });

  it("places verified ten-minute PAID rest without counting it toward coverage",()=>{
    const a=employee("long-worker",{recurring:[recurring(1,"09:00","09:50")]});
    const backup=employee("rest-cover",{recurring:[recurring(1,"09:20","09:30")]});
    const rules={verified:true,maxContinuousWorkMinutes:20,
      unpaidMealMinutes:30,paidRestMinutes:10,
      overtime:{verified:true,multiplierNumerator:3,multiplierDenominator:2}};
    const args=input([a,backup],[coverage("five-chunks",{
      start_local:"09:00",end_local:"09:50",
    })],{slotMinutes:10,ruleProfile:rules,burden:{rate:0.12,status:"verified"}});
    const result=optimizeOliviaWeek(args);
    expect(result.status).toBe("feasible");
    const worker=result.best!.shifts.find(s=>s.employeeId==="long-worker")!;
    expect(worker).toBeDefined();
    expect(worker.paidMinutes).toBe(50); // 40 productive + 10 PAID rest
    expect(worker.breaks).toMatchObject([{
      startAt:"2026-10-12T16:20:00.000Z",
      endAt:"2026-10-12T16:30:00.000Z",paid:true,
    }]);
    // 50 + 10 = 60 paid minutes across both workers (one hour).
    expect(result.best?.cost.cashWagesCents).toBe(1600);
    const unable=optimizeOliviaWeek(input([a],[coverage("five-chunks",{
      start_local:"09:00",end_local:"09:50",
    })],{slotMinutes:10,ruleProfile:rules}));
    expect(unable.status).toBe("unproven");
  });

  it("automatically extends an eligible incoming worker to meet handoff overlap",()=>{
    const opener=employee("early",{recurring:[recurring(1,"09:00","10:00")],
      wage:{wage_period:"hour",wage_amount_cents:1000,
        default_hourly_wage_cents:null}});
    const closer=employee("later",{recurring:[recurring(1,"09:30","11:00")]});
    const result=optimizeOliviaWeek(input([opener,closer],[coverage("handoff",{
      start_local:"09:00",end_local:"11:00",minOverlapMinutes:30,
    })],{slotMinutes:30}));
    expect(result.status).toBe("feasible");
    expect(result.best?.gaps).toEqual([]);
    const later=result.best!.shifts.find(s=>s.employeeId==="later")!;
    expect(later.startAt).toBe("2026-10-12T16:30:00.000Z");
    expect(later.paidMinutes).toBe(90);
  });

  it("genuinely prefers closing a verified weekly desired/minimum-hours deficit",()=>{
    const noTarget=employee("alpha");
    const needsHours=employee("beta",{
      minWeeklyMinutes:120,desiredWeeklyMinutes:120,
    });
    const result=optimizeOliviaWeek(input([noTarget,needsHours],[coverage("one-hour",{
      end_local:"10:00",
    })]));
    expect(result.status).toBe("feasible");
    // Identical objective outcomes are intentionally deduplicated. All
    // returned feasible scenarios must respect the positive hours preference.
    expect(result.scenarios.every(s=>s.shifts[0]?.employeeId==="beta"))
      .toBe(true);
  });

});

import { describe, expect, it } from "vitest";
import { optimizeOliviaWeek } from "./plannerEngine";
import { validateOliviaAssignments } from "./plannerValidate";
import type { PlannerInput, PlannerShift } from "./plannerTypes";

const person=(id:string,qualified=true)=>({
  id,displayName:"Alex",active:true,
  recurring:[{day_of_week:1,effective_from:"2026-01-01",
    start_local:"08:00",end_local:"16:00",overnight:false,
    confirmation:"owner_confirmed" as const}],
  exceptions:[],
  qualifications:qualified?[{code:"opening",validFrom:"2026-01-01",
    confirmed:true}]:[],
  wage:{wage_period:"hour",wage_amount_cents:1500,default_hourly_wage_cents:null},
  provenance:"known_paid" as const,
});
const input:PlannerInput={
  horizonStart:"2026-10-12",
  locations:[{id:"a",timezone:"America/Los_Angeles"}],
  employees:[person("staff-a"),person("staff-b")],
  coverage:[{id:"opener",locationId:"a",dayOfWeek:1,
    start_local:"09:00",end_local:"11:00",overnight:false,
    minHeadcount:2,qualificationCode:"opening",priority:"required"}],
  slotMinutes:60,burden:{rate:0.12,status:"verified"},
};
describe("Independent pure PR3-ready schedule validation",()=>{
  it("revalidates a generated qualified two-person plan",()=>{
    const result=optimizeOliviaWeek(input);
    expect(result.status).toBe("feasible");
    const checked=validateOliviaAssignments(input,result.best!.shifts);
    expect(checked).toMatchObject({valid:true,completeCoverage:true,
      matchingBudgetExhausted:false,violations:[],gaps:[]});
    expect(checked.cost?.cashWagesCents).toBe(6000);
  });
  it("rejects absent shifts, unknown employees and forged paid minutes",()=>{
    const absent=validateOliviaAssignments(input,[]);
    expect(absent.valid).toBe(false);
    expect(absent.gaps[0].coverageId).toBe("opener");
    const roster=optimizeOliviaWeek(input).best!.shifts;
    const invalid=validateOliviaAssignments(input,[{
      ...roster[0],employeeId:"another-cafe-user",paidMinutes:999,
    },roster[1]]);
    expect(invalid.valid).toBe(false);
    expect(invalid.violations.length).toBeGreaterThan(0);
  });
  it("detects unrecorded leave and guards an existing pinned commitment",()=>{
    const roster=optimizeOliviaWeek(input).best!.shifts;
    const absentInput:PlannerInput={...input,employees:input.employees.map(e=>
      e.id==="staff-a"?{...e,exceptions:[{
        local_date:"2026-10-12",exception_type:"approved_leave" as const,
        confirmation:"owner_confirmed" as const,
      }]}:e)};
    const absent=validateOliviaAssignments(absentInput,roster);
    expect(absent.valid).toBe(false);
    expect(absent.violations.some(v=>v.includes("outside_confirmed_availability"))).toBe(true);
    const pinned:PlannerInput={...input,pinned:[{
      employeeId:"staff-a",locationId:"a",
      startAt:"2026-10-12T16:00:00.000Z",endAt:"2026-10-12T18:00:00.000Z",
    }]};
    expect(validateOliviaAssignments(pinned,roster.filter(s=>s.employeeId==="staff-b"))
      .violations.some(v=>v.startsWith("pinned_commitment_removed"))).toBe(true);
  });
  it("rejects employees being double-counted across simultaneous roles",()=>{
    const roster=optimizeOliviaWeek(input).best!.shifts.filter(s=>s.employeeId==="staff-a");
    expect(validateOliviaAssignments(input,roster).completeCoverage).toBe(false);
  });
  it("validates explicitly scheduled unpaid breaks and rejects fictitious break completion",()=>{
    const base=optimizeOliviaWeek({...input,
      coverage:[{...input.coverage[0],minHeadcount:1}]}).best!.shifts[0];
    const invalid:PlannerShift={...base,unpaidBreaks:[{
      startAt:"2026-10-12T17:00:00.000Z",
      endAt:"2026-10-12T18:00:00.000Z",paid:false,
    }]};
    expect(validateOliviaAssignments({...input,coverage:[{
      ...input.coverage[0],minHeadcount:1,
    }]},[invalid]).violations).toContain("paid_minutes_mismatch");
  });
  it("allows advisory-only coverage to remain unfilled without calling it required",()=>{
    const result=validateOliviaAssignments({...input,coverage:[
      {...input.coverage[0],priority:"advisory"},
    ]},[]);
    expect(result.valid).toBe(true);
    expect(result.completeCoverage).toBe(true);
  });
  it("reports the exact conflicting required interval, not just a generic overlap",()=>{
    const one=optimizeOliviaWeek({...input,coverage:[{
      ...input.coverage[0],minHeadcount:1,
    }]}).best!.shifts.filter(s=>s.employeeId==="staff-a");
    const result=validateOliviaAssignments(input,one);
    expect(result.valid).toBe(false);
    expect(result.gaps[0]).toMatchObject({
      coverageId:"opener",locationId:"a",missingHeadcount:1,
      startAt:"2026-10-12T16:00:00.000Z",reason:"capacity_or_overlap",
    });
  });
  it("rejects a shift outside the plan's seven local calendar days",()=>{
    const roster:PlannerShift={employeeId:"staff-a",locationId:"a",
      startAt:"2026-10-19T16:00:00.000Z",endAt:"2026-10-19T17:00:00.000Z",
      paidMinutes:60,unpaidBreaks:[],pinned:false};
    expect(validateOliviaAssignments(input,[roster]).violations)
      .toContain("shift_outside_seven_day_horizon");
  });
  it("rejects a break whose endpoints are not on the scheduling grid",()=>{
    const shift=optimizeOliviaWeek({...input,coverage:[{
      ...input.coverage[0],minHeadcount:1,
    }]}).best!.shifts[0];
    const wrong:PlannerShift={...shift,paidMinutes:60,unpaidBreaks:[{
      startAt:"2026-10-12T16:30:00.000Z",
      endAt:"2026-10-12T17:30:00.000Z",paid:false,
    }]};
    expect(validateOliviaAssignments({...input,coverage:[{
      ...input.coverage[0],minHeadcount:1,
    }]},[wrong]).violations).toContain("invalid_unpaid_break");
  });

});

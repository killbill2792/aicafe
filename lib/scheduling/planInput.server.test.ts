import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  owner: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  queries: [] as Array<{table:string; cursor:string | null; count:number}>,
  rowCap: null as number | null,
  businessId: "10000000-0000-4000-8000-000000000001",
}));
vi.mock("server-only", () => ({}));
vi.mock("./foundation.server", () => ({ requireSchedulingOwner: fixtures.owner }));

import { loadOliviaWeekFromSavedStaff } from "./planInput.server";

const id = (n:number) => `30000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const week = "2026-10-12";
function rowQuery(table:string) {
  let cursor:string|null=null;
  let max=300;
  const query = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: (n:number) => { max=n; return query; },
    gt: (_key:string, value:string) => { cursor=value; return query; },
    single: async () => ({data:{timezone:"America/Los_Angeles"},error:null}),
    then: (resolve:(value:unknown)=>unknown,reject?:(reason:unknown)=>unknown) => {
      const available=(fixtures.tables[table]??[])
        .filter(r => cursor===null || String(r.id)>cursor)
        .sort((a,b)=>String(a.id).localeCompare(String(b.id)));
      fixtures.queries.push({table,cursor,count:available.length});
      return Promise.resolve({
        data:available.slice(0,Math.min(max,fixtures.rowCap??max)),
        error:null,count:available.length,
      }).then(resolve,reject);
    },
  };
  return query;
}
const recurring = (n:number,confirmation="owner_confirmed") => ({
  id:id(n+200),employee_id:id(n),day_of_week:1,
  start_local:"08:00:00",end_local:"12:00:00",overnight:false,
  location_id:null,effective_from:"2026-01-01",effective_to:null,confirmation,
});
const employee = (n:number, extras:Record<string,unknown>={}) => ({
  id:id(n),display_name:`Staff ${n}`,active:true,wage_period:"hour",
  wage_amount_cents:1800,default_hourly_wage_cents:1800,...extras,
});
const coverage = () => ({
  id:id(999),location_id:id(800),day_of_week:1,local_date:null,
  effective_from:"2026-01-01",effective_to:null,
  start_local:"08:00:00",end_local:"12:00:00",overnight:false,
  min_headcount:1,min_overlap_minutes:0,qualification_code:null,
  priority:"required",confirmation:"owner_confirmed",
});

describe("Olivia PR3B canonical saved-staff input boundary", () => {
  beforeEach(() => {
    fixtures.tables={
      employees:[employee(1)],locations:[{id:id(800),name:"Downtown",timezone:null}],
      staff_availability_rules:[recurring(1)],scheduling_coverage_requirements:[coverage()],
      staff_scheduling_compensation:[{
        id:id(300),employee_id:id(1),cash_cost_state:"known_paid",
      }],
    };
    fixtures.queries=[];
    fixtures.rowCap=null;
    fixtures.owner.mockReset();
    fixtures.owner.mockImplementation(async () => ({
      businessId:fixtures.businessId,supabase:{from:rowQuery},
    }));
    process.env.SCHEDULING_FOUNDATION_ENABLED="true";
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="true";
  });

  it("accepts a valid Monday and projects saved employee/coverage facts without guessing owner identity",async()=>{
    const output=await loadOliviaWeekFromSavedStaff(week);
    expect(output.ok).toBe(true);
    if(!output.ok) return;
    expect(output.businessId).toBe(fixtures.businessId);
    expect(output.blockers).toEqual([]);
    expect(output.notices.some(n=>n.code==="policy_unverified")).toBe(true);
    expect(output.locationNames[id(800)]).toBe("Downtown");
    expect(output.input.horizonStart).toBe(week);
    expect(output.input.employees[0]).toMatchObject({
      id:id(1),displayName:"Staff 1",active:true,provenance:"known_paid",
      recurring:[{start_local:"08:00",end_local:"12:00",
        confirmation:"owner_confirmed"}],
    });
    expect(output.input.employees[0].isOwner).toBeUndefined();
    expect(output.input.coverage[0].start_local).toBe("08:00");
    expect(output.warnings.some(w=>w.includes("not verified"))).toBe(true);
  });

  it.each(["2026-10-13","2026-02-30","2026-10-12junk","2026-10-12 OR true",""])(
    "rejects invalid/non-Monday week %s before reading staff",async bad=>{
      expect(await loadOliviaWeekFromSavedStaff(bad))
        .toEqual({ok:false,error:"invalid_week"});
      expect(fixtures.owner).not.toHaveBeenCalled();
    });

  it("rejects access when flags disabled or the selected user is not owner",async()=>{
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="false";
    expect(await loadOliviaWeekFromSavedStaff(week))
      .toEqual({ok:false,error:"disabled"});
    fixtures.owner.mockResolvedValueOnce(null);
    process.env.SCHEDULING_PR3_DRAFTS_ENABLED="true";
    expect(await loadOliviaWeekFromSavedStaff(week))
      .toEqual({ok:false,error:"unauthorized"});
  });

  it("never treats an unconfirmed availability as a confirmed shift",async()=>{
    fixtures.tables.staff_availability_rules=[recurring(1,"unconfirmed")];
    const result=await loadOliviaWeekFromSavedStaff(week);
    expect(result.ok).toBe(true);
    if(!result.ok) return;
    expect(result.input.employees[0].recurring[0].confirmation).toBe("unconfirmed");
    expect(result.warnings).toContain(
      "Confirm availability for Staff 1; staff-list membership is not availability.");
  });

  it("distinguishes missing wage from verified zero and does not infer free payroll",async()=>{
    fixtures.tables.employees=[employee(1,{wage_amount_cents:null,
      default_hourly_wage_cents:null})];
    fixtures.tables.staff_scheduling_compensation=[];
    const result=await loadOliviaWeekFromSavedStaff(week);
    expect(result.ok).toBe(true);
    if(!result.ok) return;
    expect(result.input.employees[0].provenance).toBe("unknown");
    expect(result.input.employees[0].eligibleZeroVerified).toBe(false);
  });

  it("reads beyond the first 300-row page without silently losing older staff commitments",async()=>{
    fixtures.tables.staff_schedules=Array.from({length:301},(_,n)=>({
      id:id(1000+n),active:true,effective_from:"2026-01-01",effective_to:null,
    }));
    const result=await loadOliviaWeekFromSavedStaff(week);
    expect(result.ok).toBe(true);
    expect(fixtures.queries.filter(q=>q.table==="staff_schedules")).toHaveLength(2);
    if(result.ok)expect(result.warnings.some(w=>w.includes("Legacy recurring"))).toBe(true);
  });

  it("fails closed on a PostgREST row cap that silently truncates a page",async()=>{
    fixtures.tables.staff_schedules=Array.from({length:302},(_,n)=>({
      id:id(1000+n),active:true,
    }));
    fixtures.rowCap=100;
    expect(await loadOliviaWeekFromSavedStaff(week))
      .toEqual({ok:false,error:"storage_unavailable"});
  });

  it("discloses missing coverage and active staff instead of inventing a complete week",async()=>{
    fixtures.tables.employees=[];
    fixtures.tables.scheduling_coverage_requirements=[];
    const result=await loadOliviaWeekFromSavedStaff(week);
    expect(result.ok).toBe(true);
    if(!result.ok) return;
    expect(result.blockers).toContainEqual({code:"no_coverage"});
    expect(result.input.employees).toHaveLength(0);
    expect(result.input.coverage).toHaveLength(0);
  });

  it("blocks contradictory confirmed employee hour limits instead of selecting an arbitrary row",async()=>{
    fixtures.tables.staff_scheduling_preferences=[
      {id:id(400),employee_id:id(1),effective_from:"2026-01-01",
        effective_to:null,confirmation:"owner_confirmed",
        min_weekly_minutes:0,desired_weekly_minutes:600,
        max_weekly_minutes:1200,max_daily_minutes:480},
      {id:id(401),employee_id:id(1),effective_from:"2026-10-01",
        effective_to:null,confirmation:"owner_confirmed",
        min_weekly_minutes:0,desired_weekly_minutes:900,
        max_weekly_minutes:900,max_daily_minutes:240},
    ];
    const result=await loadOliviaWeekFromSavedStaff(week);
    expect(result.ok).toBe(true);
    if(!result.ok) return;
    expect(result.blockers).toContainEqual({
      code:"conflicting_limits",employeeName:"Staff 1",
    });
  });

  it("fingerprints changes to legacy commitments even when optimizer inputs remain unchanged",async()=>{
    const before=await loadOliviaWeekFromSavedStaff(week);
    fixtures.tables.staff_schedules=[{id:id(1000),active:true,
      effective_from:"2026-01-01",effective_to:null}];
    const after=await loadOliviaWeekFromSavedStaff(week);
    expect(before.ok && after.ok).toBe(true);
    if(!before.ok || !after.ok) return;
    expect(after.input).toEqual(before.input);
    expect(after.sourceFingerprint).not.toBe(before.sourceFingerprint);
  });

  it("surfaces uncertain employee leave without inventing verified unavailability",async()=>{
    fixtures.tables.staff_availability_exceptions=[{
      id:id(700),employee_id:id(1),local_date:"2026-10-12",
      exception_type:"approved_leave",confirmation:"unconfirmed",
    }];
    const result=await loadOliviaWeekFromSavedStaff(week);
    expect(result.ok).toBe(true);
    if(!result.ok) return;
    expect(result.notices).toContainEqual({
      code:"unconfirmed_absence",employeeName:"Staff 1",
    });
    expect(result.input.employees[0].exceptions[0].confirmation).toBe("unconfirmed");
  });
});

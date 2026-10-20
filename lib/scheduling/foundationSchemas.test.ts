import { describe, expect, it } from "vitest";
import { foundationCommandSchema, parseFoundationRecord } from "./foundationSchemas";

const validWindow = {
  employee_id: "00000000-0000-4000-8000-000000000001",
  day_of_week: 3,
  start_local: "07:00",
  end_local: "11:00",
  overnight: false,
  effective_from: "2026-10-14",
  source: "worker_reported_by_owner",
  confirmation: "owner_confirmed",
};

describe("scheduling foundation input boundary", () => {
  it("accepts owner-reported weekday windows without any account or POS ID", () => {
    const parsed = parseFoundationRecord("availability_rule", validWindow);
    expect(parsed.employee_id).toBe(validWindow.employee_id);
    expect(parsed.source).toBe("worker_reported_by_owner");
  });

  it("accepts split blocks independently and overnight with an explicit flag", () => {
    const morning = parseFoundationRecord("availability_rule", validWindow);
    const afternoon = parseFoundationRecord("availability_rule", {
      ...validWindow, start_local: "16:00", end_local: "20:00",
    });
    expect(morning.start_local).toBe("07:00");
    expect(afternoon.start_local).toBe("16:00");
    expect(parseFoundationRecord("availability_rule", {
      ...validWindow, start_local: "22:00", end_local: "02:00", overnight: true,
    })).toBeDefined();
  });

  it("accepts date-specific unavailable day without a time window", () => {
    expect(parseFoundationRecord("availability_exception", {
      employee_id: validWindow.employee_id,
      local_date: "2026-10-14",
      exception_type: "unavailable",
      confirmation: "owner_confirmed",
      source: "owner_direct",
    }).exception_type).toBe("unavailable");
  });

  it("records intentional unavailable weekdays with explicit confirmation, never from missing windows",()=>{
    const base={employee_id:validWindow.employee_id,effective_from:"2026-10-14",
      min_weekly_minutes:0,source:"owner_direct",confirmation:"owner_confirmed"};
    const known=parseFoundationRecord("preferences",{
      ...base,unavailable_weekdays:[3,4],
    });
    expect(known.unavailable_weekdays).toEqual([3,4]);
    const unknown=parseFoundationRecord("preferences",base);
    expect(unknown.unavailable_weekdays).toEqual([]);
    expect(()=>parseFoundationRecord("preferences",{
      ...base,unavailable_weekdays:[7],
    })).toThrow();
    expect(()=>parseFoundationRecord("preferences",{
      ...base,unavailable_weekdays:[3,3],
    })).toThrow();
  });

  it("records minimum, desired and maximum distinctly", () => {
    const parsed = parseFoundationRecord("preferences", {
      employee_id: validWindow.employee_id,
      effective_from: "2026-10-14",
      min_weekly_minutes: 120,
      desired_weekly_minutes: 240,
      max_weekly_minutes: 360,
      source: "owner_direct",
      confirmation: "owner_confirmed",
    });
    expect([parsed.min_weekly_minutes, parsed.desired_weekly_minutes, parsed.max_weekly_minutes])
      .toEqual([120, 240, 360]);
  });

  it("rejects fabricated business/actor IDs and oversized or malformed time values", () => {
    expect(() => parseFoundationRecord("availability_rule", {
      ...validWindow, business_id: "00000000-0000-4000-8000-000000000002",
    })).toThrow();
    expect(() => parseFoundationRecord("availability_rule", {
      ...validWindow, confirmed_by: validWindow.employee_id,
    })).toThrow();
    expect(() => parseFoundationRecord("availability_rule", {
      ...validWindow, start_local: "25:15",
    })).toThrow();
    expect(() => parseFoundationRecord("availability_rule", {
      ...validWindow, day_of_week: 8,
    })).toThrow();
  });

  it("does not allow a soft preference to masquerade as verified availability", () => {
    expect(parseFoundationRecord("preference_window", {
      ...validWindow, preference: "prefer", strength: "soft",
    }).strength).toBe("soft");
    expect(parseFoundationRecord("preference_window", {
      ...validWindow, preference: "avoid", strength: "hard",
    }).strength).toBe("hard");
  });

  it("requires a version for updates/deletions and prohibits client IDs on creates", () => {
    expect(foundationCommandSchema.safeParse({
      kind: "availability_rule", action: "update", id: validWindow.employee_id,
    }).success).toBe(false);
    expect(foundationCommandSchema.safeParse({
      kind: "availability_rule", action: "delete", id: validWindow.employee_id, expectedRevision: 1,
    }).success).toBe(true);
    expect(foundationCommandSchema.safeParse({
      kind: "availability_rule", action: "create", id: validWindow.employee_id, data: validWindow,
    }).success).toBe(false);
  });

  it("requires a stable UUID retry key for creates and forbids it for edits", () => {
    const requestKey = "00000000-0000-4000-8000-000000000009";
    expect(foundationCommandSchema.safeParse({
      kind: "availability_rule", action: "create", data: validWindow,
    }).success).toBe(false);
    expect(foundationCommandSchema.safeParse({
      kind: "availability_rule", action: "create", requestKey, data: validWindow,
    }).success).toBe(true);
    expect(foundationCommandSchema.safeParse({
      kind: "availability_rule", action: "create", requestKey: "bad", data: validWindow,
    }).success).toBe(false);
    expect(foundationCommandSchema.safeParse({
      kind: "availability_rule", action: "update", id: validWindow.employee_id,
      expectedRevision: 1, requestKey, data: validWindow,
    }).success).toBe(false);
  });

  it("accepts only explicit wage provenance (never an inferred zero)", () => {
    expect(parseFoundationRecord("compensation", {
      employee_id: validWindow.employee_id, cash_cost_state: "unknown",
    }).cash_cost_state).toBe("unknown");
    expect(parseFoundationRecord("compensation", {
      employee_id: validWindow.employee_id, cash_cost_state: "salary_conversion_pending",
    }).cash_cost_state).toBe("salary_conversion_pending");
    expect(parseFoundationRecord("compensation", {
      employee_id: validWindow.employee_id, cash_cost_state: "known_eligible_zero",
      eligibility_reference: "Owner attested reviewed zero-eligibility evidence",
    }).cash_cost_state).toBe("known_eligible_zero");
    expect(() => parseFoundationRecord("compensation", {
      employee_id: validWindow.employee_id, cash_cost_state: "for-free",
    })).toThrow();
  });

  it("accepts a nullable break floor and rejects policies above normal headcount",()=>{
    const record={
      location_id:"00000000-0000-4000-8000-000000000002",
      day_of_week:3,effective_from:"2026-10-14",
      start_local:"07:00",end_local:"11:00",overnight:false,
      min_headcount:2,priority:"required",
      source:"owner_direct",confirmation:"owner_confirmed",
    };
    expect(parseFoundationRecord("coverage",{
      ...record,min_headcount_during_break:1,
    }).min_headcount_during_break).toBe(1);
    expect(parseFoundationRecord("coverage",{
      ...record,min_headcount_during_break:null,
    }).min_headcount_during_break).toBeNull();
    expect(() => parseFoundationRecord("coverage",{
      ...record,min_headcount_during_break:3,
    })).toThrow();
    expect(() => parseFoundationRecord("coverage",{
      ...record,min_headcount_during_break:-1,
    })).toThrow();
  });

  it("rejects arbitrary qualification codes and missing coverage location", () => {
    expect(() => parseFoundationRecord("qualification_type", {
      code: "owner' DROP TABLE employees;", display_name: "Opener",
    })).toThrow();
    expect(() => parseFoundationRecord("coverage", {
      ...validWindow, min_headcount: 1,
    })).toThrow();
  });
});
